import { useState, useRef } from 'react';
import Scanner from './components/Scanner';
import UploadZone from './components/UploadZone';
import Timeline, { type Segment } from './components/Timeline';
import './App.css';

// Add global type for Electron API
declare global {
  interface Window {
    electron?: {
      getFilePath: (file: File) => Promise<string>;
    };
  }
}

function App() {
  const [fileId, setFileId] = useState<string | null>(null);
  const [status, setStatus] = useState<string>('IDLE');
  const [progress, setProgress] = useState<number>(0);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number>(0);
  const [uploadEta, setUploadEta] = useState<string>('');
  const [processingEta, setProcessingEta] = useState<string>('');
  const [stepLabel, setStepLabel] = useState<string>('');
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const videoRef = useRef<HTMLVideoElement>(null);

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  };



  const handleUpload = async (file: File) => {
    setIsUploading(true);
    setStatus('UPLOADING');
    setUploadProgress(0);
    setUploadEta('calculating...');

    try {
      // ELECTRON DESKTOP APP FLOW:
      // If running in Electron, get the real file path and process locally (Zero Copy / Zero Upload)
      if (window.electron) {
        setUploadEta('Getting file path...');
        // In Electron, File object path property is stripped in renderer, but we exposed a helper
        const filePath = await window.electron.getFilePath(file);
        console.log("Processing local file:", filePath);

        setUploadProgress(100);
        setStatus('PROCESSING');
        setUploadEta('Starting local processing...');

        // Call backend to start processing local file directly
        const res = await fetch('http://localhost:8000/analyze', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ file_path: filePath }),
        });

        const data = await res.json();
        if (data.status === "error") {
          throw new Error(data.message);
        }

        setFileId(data.file_id);
        connectWebSocket(data.file_id);
        setStatus('PROCESSING');
        setIsUploading(false);
        setUploadProgress(100);
        setUploadEta('');
        connectWebSocket(data.file_id);
        return;
      }

      // 2. Fallback: Chunked Upload (Browser Mode)
      // chunk size 1MB (conservative)
      const CHUNK_SIZE = 1024 * 1024;
      const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
      const startTime = Date.now();

      // Step 1: Initialize the chunked upload
      const initRes = await fetch('http://localhost:8000/upload/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: file.name, fileSize: file.size }),
      });
      const initData = await initRes.json();
      const fileId = initData.file_id;

      // Helper to allow UI/GC to breathe
      const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

      // Step 2: Send chunks one by one
      const sendChunk = (chunkIndex: number): Promise<void> => {
        return new Promise((resolve, reject) => {
          const start = chunkIndex * CHUNK_SIZE;
          const end = Math.min(start + CHUNK_SIZE, file.size);
          const blob = file.slice(start, end);

          const xhr = new XMLHttpRequest();
          xhr.open('POST', `http://localhost:8000/upload/chunk/${fileId}`, true);
          xhr.setRequestHeader('Content-Type', 'application/octet-stream');

          // Track individual chunk progress for smoother updates
          xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) {
              const chunkBytesSent = start + e.loaded;
              const percent = (chunkBytesSent / file.size) * 100;
              setUploadProgress(Math.round(percent));

              const elapsed = (Date.now() - startTime) / 1000;
              if (percent > 1) {
                const totalEstimated = (elapsed / percent) * 100;
                const remaining = totalEstimated - elapsed;
                setUploadEta(`${formatFileSize(chunkBytesSent)} / ${formatFileSize(file.size)} — ${formatEta(remaining)}`);
              }
            }
          };

          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              resolve();
            } else {
              reject(new Error(`Chunk upload failed: ${xhr.status}`));
            }
          };
          xhr.onerror = () => reject(new Error('Network error during chunk upload'));
          xhr.send(blob);
        });
      };

      for (let i = 0; i < totalChunks; i++) {
        await sendChunk(i);
        // Yield to main thread for GC and UI updates
        await sleep(50);
      }

      // Step 3: Finalize
      await fetch(`http://localhost:8000/upload/complete/${fileId}`, {
        method: 'POST',
      });

      setFileId(fileId);
      setStatus('PROCESSING');
      setIsUploading(false);
      setUploadProgress(100);
      setUploadEta('');
      connectWebSocket(fileId);

    } catch (err) {
      console.error("Upload failed", err);
      setStatus('ERROR');
      setIsUploading(false);
    }
  };

  const formatEta = (seconds: number): string => {
    if (seconds < 0 || seconds > 86400) return 'calculating...';
    seconds = Math.round(seconds);
    if (seconds < 60) return `${seconds}s left`;
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    if (m < 60) return `${m}m ${s}s left`;
    const h = Math.floor(m / 60);
    const rm = m % 60;
    return `${h}h ${rm}m left`;
  };



  const getStepLabel = (step: string): string => {
    const labels: Record<string, string> = {
      'initializing': 'Initializing...',
      'audio_extraction': 'Extracting Audio',
      'vad_analysis': 'Analyzing Speech',
      'rendering': 'Rendering Video',
      'complete': 'Complete!',
      'error': 'Error',
      'cancelled': 'Cancelled'
    };
    return labels[step] || step;
  };

  const handleCancel = async () => {
    if (!fileId) return;
    try {
      await fetch(`http://localhost:8000/cancel/${fileId}`, {
        method: 'POST',
      });
      // UI update will happen via WebSocket status 'cancelled', 
      // but we can also force it here just in case WS is dead
      setStatus('IDLE');
      setStepLabel('');
      setProgress(0);
    } catch (err) {
      console.error('Failed to cancel:', err);
    }
  };

  const handleReset = () => {
    setFileId(null);
    setStatus('IDLE');
    setProgress(0);
    setProcessingEta('');
    setStepLabel('');
    setUploadEta('');
  };

  const connectWebSocket = (fid: string) => {
    const ws = new WebSocket(`ws://localhost:8000/ws/${fid}`);

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.progress !== undefined) setProgress(data.progress);
      if (data.step) {
        setStatus(data.step);
        setStepLabel(getStepLabel(data.step));
      }
      if (data.eta_display) {
        setProcessingEta(data.eta_display);
      } else if (data.step === 'complete') {
        setProcessingEta('');
      }

      if (data.step === 'analysis_complete') {
        fetchSegments(fid);
        setStatus('TIMELINE');
      }

      if (data.step === 'complete' && data.output_file) {
        setDownloadUrl(`http://localhost:8000/outputs/${data.output_file}`);
        setStatus('COMPLETE');
      }
    };

    ws.onerror = (e) => {
      console.error("WebSocket error", e);
      setStatus('CONNECTION_ERROR');
    }
  };

  const fetchSegments = async (fid: string) => {
    try {
      const res = await fetch(`http://localhost:8000/project/${fid}`);
      const data = await res.json();
      if (data.segments) setSegments(data.segments);
      // We can get duration from video metadata when it loads
    } catch (e) {
      console.error("Failed to fetch segments", e);
    }
  };

  const handleExport = async () => {
    if (!fileId) return;
    setStatus('RENDERING'); // Custom local status
    try {
      await fetch('http://localhost:8000/render', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          file_id: fileId,
          segments: segments.filter((s: Segment) => s.type === 'keep' || !s.type)
        }),
      });
    } catch (e) {
      console.error("Export failed", e);
      setStatus('ERROR');
    }
  };

  const onTimeUpdate = () => {
    if (videoRef.current) setCurrentTime(videoRef.current.currentTime);
  };

  const onLoadedMetadata = () => {
    if (videoRef.current) setDuration(videoRef.current.duration);
  };

  return (
    <div className="min-h-screen w-full bg-[#050505] text-white flex flex-col items-center justify-center p-8">
      <div className="w-full max-w-4xl space-y-8">
        <header className="text-center space-y-2">
          <h1 className="text-4xl font-black tracking-tighter bg-clip-text text-transparent bg-gradient-to-r from-blue-400 to-green-400">
            JUMP-CUTTER AI
          </h1>
          <p className="text-gray-400">Silence Removal & Auto-Correction System</p>
        </header>

        <main className="w-full space-y-6">
          {status === 'IDLE' || status === 'UPLOADING' ? (
            <UploadZone
              onFileSelect={handleUpload}
              isUploading={isUploading}
              uploadProgress={uploadProgress}
              uploadEta={uploadEta}
            />
          ) : (
            <Scanner
              progress={progress}
              status={status}
              stepLabel={stepLabel}
              eta={processingEta}
              onCancel={handleCancel}
              onReset={handleReset}
            />
          )}

          {status === 'TIMELINE' && fileId && (
            <div className="space-y-4">
              <div className="relative aspect-video bg-black rounded-lg overflow-hidden border border-gray-800">
                {/* Video Player for Preview */}
                <video
                  ref={videoRef}
                  src={`http://localhost:8000/stream/${fileId}`} // Need stream endpoint or file path?
                  // Actually exposing local file is tricky in browser.
                  // But in Electron we can just use file:// IF allowed?
                  // Or serve via backend static?
                  // Let's assume we can serve source via /project/{id}/video
                  className="w-full h-full"
                  controls
                  onTimeUpdate={onTimeUpdate}
                  onLoadedMetadata={onLoadedMetadata}
                />
              </div>

              <Timeline
                fileId={fileId}
                duration={duration}
                segments={segments}
                onSegmentsChange={setSegments}
                currentTime={currentTime}
                onSeek={(t) => {
                  if (videoRef.current) videoRef.current.currentTime = t;
                }}
              />

              <div className="flex justify-end gap-4">
                <button
                  onClick={handleReset}
                  className="px-6 py-2 rounded-full border border-gray-600 hover:bg-gray-800 transition flex items-center gap-2"
                >
                  <span>←</span> Back to Upload
                </button>
                <button
                  onClick={handleExport}
                  className="px-8 py-2 bg-blue-600 hover:bg-blue-500 rounded-full font-bold shadow-lg shadow-blue-500/20 transition transform hover:scale-105"
                >
                  Export Video
                </button>
              </div>
            </div>
          )}

          {downloadUrl && (
            <div className="flex flex-col items-center gap-6 mt-8 w-full max-w-4xl mx-auto">
              <div className="w-full relative aspect-video bg-black rounded-xl overflow-hidden shadow-2xl border border-green-500/30">
                <video
                  src={downloadUrl}
                  controls
                  className="w-full h-full"
                  autoPlay
                />
              </div>

              <div className="flex gap-4">
                <a
                  href={downloadUrl}
                  download
                  className="px-8 py-3 bg-green-500 hover:bg-green-600 text-black font-bold rounded-full transition-all shadow-[0_0_20px_rgba(34,197,94,0.5)]"
                >
                  DOWNLOAD PROCESSED VIDEO
                </a>

                <button
                  onClick={handleReset}
                  className="px-6 py-2 text-gray-400 hover:text-white hover:bg-white/10 rounded-full transition"
                >
                  Upload Another Video
                </button>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

export default App;
