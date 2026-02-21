import ffmpeg
import torch
import numpy as np
import os
import asyncio
import asyncio.subprocess
import subprocess
import logging
import time
import re
from pathlib import Path
from typing import List, Dict, Any, Tuple
import colorlog
import scipy.io.wavfile as wavfile

# Removed global logging.basicConfig as logging is now handled per instance

def format_eta(seconds: float) -> str:
    """Format seconds into a human-readable ETA string."""
    if seconds < 0 or seconds > 86400:
        return "calculating..."
    secs = int(seconds)
    if secs < 60:
        return f"{secs}s"
    elif secs < 3600:
        m, s = divmod(secs, 60)
        return f"{m}m {s}s"
    else:
        h, remainder = divmod(secs, 3600)
        m, s = divmod(remainder, 60)
        return f"{h}h {m}m {s}s"


def parse_ffmpeg_time(time_str: str) -> float:
    """Parse FFmpeg time string (HH:MM:SS.ms) to seconds."""
    parts = time_str.split(':')
    if len(parts) == 3:
        h, m, s = parts
        return int(h) * 3600 + int(m) * 60 + float(s)
    return 0.0


def _clamp(value: float, lo: float, hi: float) -> float:
    """Clamp a value between lo and hi."""
    if value < lo:
        return lo
    if value > hi:
        return hi
    return value


class VideoProcessor:
    def __init__(self, file_path: Path, output_dir: Path, file_id: str = "temp"):
        self.file_path = file_path
        self.output_dir = output_dir
        self.output_dir.mkdir(exist_ok=True, parents=True) # Kept parents=True for safety
        self.file_id = file_id
        
        # Setup logging
        self.logger = logging.getLogger(f"processor_{file_id}")
        self.source_map: List[Dict[str, Any]] = [] # metadata for merged files
        if not self.logger.handlers:
            handler = logging.StreamHandler()
            formatter = colorlog.ColoredFormatter(
                "%(log_color)s%(levelname)-8s%(reset)s %(blue)s%(message)s"
            )
            handler.setFormatter(formatter)
            self.logger.addHandler(handler)
            self.logger.setLevel(logging.INFO)

        self.status_callback: Any = None
        self.current_proc: asyncio.subprocess.Process | None = None
        self.cancelled = False
        self.segments: List[Dict[str, float]] = [] # Store analysis results
        self.completion_event = asyncio.Event()
        self.final_output: Path | None = None

    @classmethod
    async def concat_videos(cls, file_paths: List[Path], output_path: Path) -> Path:
        """Concatenate multiple videos into a single file using FFmpeg concat demuxer."""
        if not file_paths:
            raise ValueError("No input files provided")

        if len(file_paths) == 1:
            import shutil
            shutil.copy(file_paths[0], output_path)
            return output_path
        
        # Create concat list file
        concat_list_path = output_path.parent / f"{output_path.stem}_concat_list.txt"
        with open(concat_list_path, 'w') as f:
            for path in file_paths:
                # Escape single quotes for ffmpeg concat list: ' -> '\''
                escaped_path = str(path.absolute()).replace("'", "'\\''")
                f.write(f"file '{escaped_path}'\n")

        print(f"Concatenating {len(file_paths)} files to {output_path}...")
        
        # FFmpeg command for stream copy (fastest)
        # Note: Input files must have same codecs/params for this to work perfectly.
        # If not, we might need re-encoding, but let's try copy first for speed.
        cmd = [
            "ffmpeg", "-y",
            "-f", "concat",
            "-safe", "0",
            "-i", str(concat_list_path),
            "-c", "copy",
            "-loglevel", "error",
            str(output_path)
        ]

        # Run ffmpeg
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )
        stdout, stderr = await proc.communicate()

        if proc.returncode != 0:
            error_msg = stderr.decode() if stderr else "Unknown ffmpeg error"
            raise RuntimeError(f"Concatenation failed: {error_msg}")

        print(f"Concatenation complete: {output_path}")
        return output_path

    def cancel(self):
        """Cancel the current operation."""
        self.cancelled = True
        self.log("Cancellation wrapper requested...")
        if self.current_proc is not None:
            try:
                self.current_proc.terminate()
                self.log("Terminated current process")
            except Exception as e:
                self.log(f"Failed to terminate process: {e}")

    def log(self, msg: str) -> None:
        logging.debug(msg)
        print(msg)

    def set_callback(self, callback: Any) -> None:
        self.status_callback = callback

    async def _emit_status(self, step: str, progress: float, details: str = "", eta_seconds: float = -1) -> None:
        if self.status_callback:
            # Use int() for clean progress values, avoiding round() Pyright overload issues
            progress_val = int(progress * 10) / 10.0  # manual round to 1 decimal
            eta_val = int(eta_seconds * 10) / 10.0 if eta_seconds >= 0 else -1

            msg: Dict[str, Any] = {
                "step": step,
                "progress": progress_val,
                "details": details
            }
            if eta_seconds >= 0:
                msg["eta_seconds"] = eta_val
                msg["eta_display"] = format_eta(eta_seconds)
            await self.status_callback(msg)

    async def process_async(self, auto_render: bool = False) -> str | None:
        """Main processing pipeline — runs heavy work in a thread pool to avoid blocking."""
        try:
            self.cancelled = False
            self.log("Starting analysis...")
            await self._emit_status("initializing", 0, "Starting analysis...")

            if self.cancelled: raise RuntimeError("Cancelled")

            # Get total video duration for progress calculations
            probe = ffmpeg.probe(str(self.file_path))
            total_duration = float(probe['format']['duration'])
            self.log(f"Video duration: {total_duration:.1f}s")

            # 1. Extract Audio with progress (0% - 20%)
            self.log(f"Extracting audio from {self.file_path}")
            loop = asyncio.get_running_loop()
            audio_path = await self._extract_audio_with_progress(loop, total_duration)
            self.log(f"Audio extracted to {audio_path}")
            await self._emit_status("audio_extraction", 20, "Audio extracted")

            # 2. VAD Analysis with progress (20% - 50%)
            self.log("Starting VAD analysis")
            speech_timestamps = await self._detect_voice_with_progress(loop, audio_path, total_duration)
            
            # STORE SEGMENTS FOR API ACCESS
            self.segments = speech_timestamps

            # Log useful debug info
            total_speech = sum(t['end'] - t['start'] for t in speech_timestamps)
            self.log(f"Found {len(speech_timestamps)} speech segments, total speech: {total_speech:.1f}s / {total_duration:.1f}s")
            for i, ts in enumerate(speech_timestamps):
                self.log(f"  Segment {i}: {ts['start']:.2f}s - {ts['end']:.2f}s (duration: {ts['end']-ts['start']:.2f}s)")

            await self._emit_status("vad_analysis", 50, f"Found {len(speech_timestamps)} speech segments ({total_speech:.1f}s of speech)")

            if not auto_render:
                self.log("Analysis complete. Waiting for supervisor review.")
                await self._emit_status("analysis_complete", 50, "Ready for Review")
                return None

            # 3. Render with progress (50% - 100%)
            self.log("Rendering video")
            output_file = await self._render_video_with_progress(loop, speech_timestamps, total_speech)
            self.log("Video processing complete")
            await self._emit_status("rendering", 100, "Video processing complete")

            self.final_output = output_file
            self.completion_event.set()
            return str(output_file)

        except Exception as e:
            self.log(f"Process Error: {e}")
            import traceback
            self.log(traceback.format_exc())
            await self._emit_status("error", 0, str(e))
            raise e

    async def _extract_audio_with_progress(self, loop: asyncio.AbstractEventLoop, total_duration: float) -> Path:
        """Extract audio with real-time progress tracking using async subprocess."""
        audio_path = self.output_dir / f"{self.file_id}_{self.file_path.stem}.wav"

        cmd = [
            "ffmpeg", "-y",
            "-i", str(self.file_path),
            "-ac", "1", "-ar", "16000",
            "-progress", "pipe:1",
            "-loglevel", "error",
            str(audio_path)
        ]

        stderr_log = open(self.output_dir / "ffmpeg_audio_stderr.log", "w")
        stderr_log = open(self.output_dir / "ffmpeg_audio_stderr.log", "w")
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=stderr_log
        )
        self.current_proc = proc
        start_time = time.time()

        if proc.stdout is None:
             raise RuntimeError("Failed to open ffmpeg stdout")
             
        while True:
            if self.cancelled:
                if self.current_proc is not None:
                    self.current_proc.terminate()
                raise RuntimeError("Cancelled by user")
            line_bytes = await proc.stdout.readline()
            if not line_bytes:
                break
            line = line_bytes.decode('utf-8', errors='replace')
            if line.startswith("out_time="):
                time_str = line.split("=")[1].strip()
                if time_str and time_str != "N/A":
                    current_time = parse_ffmpeg_time(time_str)
                    if total_duration > 0:
                        fraction = _clamp(current_time / total_duration, 0.0, 1.0)
                        progress = fraction * 20  # 0-20% range
                        elapsed = time.time() - start_time
                        eta = (elapsed / fraction) * (1.0 - fraction) if fraction > 0.01 else -1
                        await self._emit_status(
                            "audio_extraction", progress,
                            f"Extracting audio... {int(fraction * 100)}%",
                            eta
                        )

        # Wait for process to finish
        # close stderr file
        if self.current_proc is not None:
            await self.current_proc.wait()
        stderr_log.close()
        
        if self.current_proc is not None and self.current_proc.returncode != 0:
            # Read the log file for error message
            try:
                with open(self.output_dir / "ffmpeg_audio_stderr.log", "r") as f:
                    stderr = f.read()
            except:
                stderr = "unknown error (check log file)"
            raise RuntimeError(f"Audio extraction failed: {stderr}")

        self.current_proc = None
        return audio_path

    async def _detect_voice_with_progress(self, loop: asyncio.AbstractEventLoop, audio_path: Path, total_duration: float) -> List[Dict[str, float]]:
        """Run VAD with progress updates."""
        if self.cancelled: raise RuntimeError("Cancelled")
        await self._emit_status("vad_analysis", 22, "Loading VAD model...", -1)

        def _load_model() -> Any:
            try:
                model, utils = torch.hub.load(
                    repo_or_dir='snakers4/silero-vad',
                    model='silero_vad',
                    force_reload=False,
                    trust_repo=True
                )
                return model, utils
            except Exception as e:
                self.log(f"Error loading VAD model: {e}")
                raise RuntimeError(f"Failed to load VAD model: {e}")

        result = await loop.run_in_executor(None, _load_model)  # type: ignore[arg-type]
        model, utils = result
        await self._emit_status("vad_analysis", 30, "Model loaded, analyzing speech...", -1)

        (get_speech_timestamps, _, read_audio, _, _) = utils

        def _run_vad() -> Tuple[List[Dict[str, float]], float]:
            start = time.time()
            try:
                wav = read_audio(str(audio_path))
                stamps = get_speech_timestamps(
                    wav, model,
                    return_seconds=True,
                    threshold=0.35,
                    min_speech_duration_ms=100,
                    min_silence_duration_ms=200,
                    speech_pad_ms=80
                )
            except Exception as e:
                self.log(f"Error executing VAD: {e}")
                raise RuntimeError(f"VAD execution failed: {e}")
            elapsed = time.time() - start
            return stamps, elapsed

        # Run VAD in a thread via run_in_executor (avoids Pyright executor.submit type issue)
        start_time = time.time()
        vad_future = loop.run_in_executor(None, _run_vad)  # type: ignore[arg-type]

        # Poll for completion and update progress
        while not vad_future.done():
            if self.cancelled:
                # We can't easily kill the thread running VAD, but we can abandon it
                raise RuntimeError("Cancelled by user")
            
            elapsed = time.time() - start_time
            # Estimate: VAD typically processes at ~50x real-time on CPU
            estimated_vad_time = max(total_duration / 50.0, 5.0)
            fraction = _clamp(elapsed / estimated_vad_time, 0.0, 0.95)
            progress = 30 + fraction * 18  # 30-48% range
            eta = max(estimated_vad_time - elapsed, 0.0)
            await self._emit_status(
                "vad_analysis", progress,
                f"Analyzing speech patterns... {int(fraction * 100)}%",
                eta
            )
            await asyncio.sleep(0.5)

        # Get result after loop finishes
        try:
            speech_timestamps, _vad_elapsed = await vad_future
        except Exception as e:
            self.log(f"VAD Future failed (check installed libraries like soundfile): {e}")
            raise RuntimeError(f"VAD analysis failed. Ensure 'soundfile' is installed. Error: {e}")
            
        # Merge overlapping timestamps to avoid video repetition
        speech_timestamps = self._merge_timestamps(speech_timestamps)

        return speech_timestamps

    def get_waveform_data(self, points_per_second: int = 20) -> List[float]:
        """Generate waveform peaks for visualization."""
        # The extracted audio file
        wav_path = self.output_dir / f"{self.file_id}_{self.file_path.stem}.wav"
        
        if not wav_path.exists():
            self.log(f"Waveform error: {wav_path} not found")
            return []
            
        try:
            # Read WAV file
            sample_rate, data = wavfile.read(str(wav_path))
            
            # Convert to mono if stereo
            if len(data.shape) > 1:
                data = np.mean(data, axis=1)
                
            # Handle empty data
            if len(data) == 0:
                return []

            # Normalize to 0-1 range based on absolute max
            max_val = np.max(np.abs(data))
            if max_val > 0:
                data = data / max_val
            
            # Calculate step size for downsampling
            step = int(sample_rate / points_per_second)
            if step < 1: step = 1
            
            # Pad to make length divisible by step
            pad_len = (step - len(data) % step) % step
            if pad_len > 0:
                data = np.pad(data, (0, pad_len))
                
            # Resample by taking max amplitude in each window (peak detection)
            # Reshape to (num_windows, step) and take max of absolute values along axis 1
            peaks = np.max(np.abs(data.reshape(-1, step)), axis=1)
            
            # Return rounded floats for compact JSON
            return [round(float(x), 3) for x in peaks]
            
        except Exception as e:
            self.log(f"Error generating waveform: {e}")
            return []

    def _merge_timestamps(self, timestamps: List[Dict[str, float]], min_gap: float = 0.2) -> List[Dict[str, float]]:
        """Merge overlapping or adjacent timestamps to prevent video repetition."""
        if not timestamps:
            return []
        
        # Sort by start time
        timestamps.sort(key=lambda x: x['start'])
        
        merged = []
        current = timestamps[0].copy()
        
        for next_ts in timestamps[1:]:
            # Check overlap OR close proximity (gap < min_gap)
            # If the next segment starts before the current one ends + min_gap, merge them.
            if next_ts['start'] < current['end'] + min_gap:
                # Merge
                current['end'] = max(current['end'], next_ts['end'])
            else:
                merged.append(current)
                current = next_ts.copy()
        merged.append(current)
        return merged

    async def _render_video_with_progress(self, loop: asyncio.AbstractEventLoop, timestamps: List[Dict[str, float]], total_speech_duration: float) -> Path:
        """Render video by extracting each segment individually for frame-accurate cuts,
        then concatenating with stream copy. This avoids the concat demuxer's keyframe-seeking
        bug that causes repeated words at segment boundaries."""
        if self.cancelled: raise RuntimeError("Cancelled")
        
        if not timestamps:
            self.log("No speech detected. Returning original video.")
            output_path = self.output_dir / self.file_path.name
            import shutil
            shutil.copy(self.file_path, output_path)
            return output_path

        output_path = self.output_dir / f"{self.file_path.stem}_processed.mp4"

        # FAILSAFE: Ensure no segment overlap
        safe_timestamps = []
        last_end = 0.0
        for ts in timestamps:
            start = ts['start']
            end = ts['end']
            if start < last_end:
                start = last_end
            if end <= start:
                continue
            safe_timestamps.append({"start": start, "end": end})
            last_end = end

        n = len(safe_timestamps)
        self.log(f"Rendering {n} segments with per-segment extraction (frame-accurate)...")
        await self._emit_status("rendering", 52, f"Rendering {n} segments...", -1)

        # Create temp directory for segment files
        temp_dir = self.output_dir / f"{self.file_id}_segments"
        temp_dir.mkdir(exist_ok=True)

        stderr_log_path = self.output_dir / "ffmpeg_render_stderr.log"
        segment_files = []
        start_time = time.time()

        # STEP 1: Extract each segment individually (frame-accurate)
        # Using -ss BEFORE -i does fast keyframe seek, then -ss AFTER -i does precise decode.
        # Combined: fast seek + precise trim = frame-accurate and fast.
        for i, ts in enumerate(safe_timestamps):
            if self.cancelled:
                raise RuntimeError("Cancelled by user")

            seg_start = ts['start']
            seg_duration = ts['end'] - ts['start']
            seg_file = temp_dir / f"seg_{i:04d}.mp4"
            segment_files.append(seg_file)

            cmd = [
                "ffmpeg", "-y",
                "-ss", f"{seg_start:.3f}",
                "-i", str(self.file_path),
                "-t", f"{seg_duration:.3f}",
                "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
                "-c:a", "aac", "-b:a", "128k",
                "-avoid_negative_ts", "make_zero",
                "-loglevel", "error",
                str(seg_file)
            ]

            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )
            self.current_proc = proc
            _, stderr_data = await proc.communicate()

            if proc.returncode != 0 and not self.cancelled:
                err = stderr_data.decode() if stderr_data else "unknown"
                self.log(f"Segment {i} failed: {err}")
                # Skip failed segments instead of crashing
                if seg_file.exists():
                    seg_file.unlink()
                segment_files.pop()
                continue

            # Update progress (50% - 90% range for extraction)
            fraction = (i + 1) / n
            progress = 50 + fraction * 40  # 50-90%
            elapsed = time.time() - start_time
            eta = (elapsed / fraction) * (1.0 - fraction) if fraction > 0.01 else -1
            await self._emit_status(
                "rendering", progress,
                f"Extracting segment {i + 1}/{n}...",
                eta
            )

        self.current_proc = None

        if not segment_files:
            raise RuntimeError("All segments failed to extract")

        # STEP 2: Concatenate all segment files with stream copy (fast, no re-encode)
        concat_list_path = self.output_dir / f"{self.file_path.stem}_concat.txt"
        with open(concat_list_path, 'w') as f:
            for seg_file in segment_files:
                escaped = str(seg_file.absolute()).replace("'", "'\\''")
                f.write(f"file '{escaped}'\n")

        self.log(f"Concatenating {len(segment_files)} segments...")
        await self._emit_status("rendering", 92, "Joining segments...", -1)

        cmd = [
            "ffmpeg", "-y",
            "-f", "concat",
            "-safe", "0",
            "-i", str(concat_list_path),
            "-c", "copy",
            "-loglevel", "error",
            str(output_path)
        ]

        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )
        self.current_proc = proc
        _, stderr_data = await proc.communicate()

        if proc.returncode != 0 and not self.cancelled:
            err = stderr_data.decode() if stderr_data else "unknown"
            self.log(f"Concat failed: {err}")
            raise RuntimeError(f"FFmpeg concat failed: {err}")

        self.current_proc = None

        # STEP 3: Cleanup temp segment files
        for seg_file in segment_files:
            try:
                seg_file.unlink()
            except:
                pass
        try:
            temp_dir.rmdir()
        except:
            pass

        self.log(f"Output saved to {output_path}")
        return output_path

    async def render_from_segments(self, segments: List[Dict[str, float]]) -> str:
        """Render video from manually confirmed segments."""
        self.segments = segments # Update with user-edited segments
        
        # Recalculate duration
        total_duration = sum(s['end'] - s['start'] for s in segments)
        loop = asyncio.get_running_loop()
        
        output_file = await self._render_video_with_progress(loop, segments, total_duration)
        await self._emit_status("complete", 100, "Video processing complete", -1)
        
        self.final_output = output_file
        self.completion_event.set()
        
        return str(output_file)
