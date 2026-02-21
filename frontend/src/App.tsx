import { useState, useRef } from 'react';
import Scanner from './components/Scanner';
import UploadZone from './components/UploadZone';
import { type Segment } from './components/Timeline';
import ManualEditor from './components/ManualEditor';
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
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [isManualMode, setIsManualMode] = useState(false);

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  };

  const handleFileSelect = (files: File[]) => {
    setSelectedFiles(prev => [...prev, ...files]);
    setErrorMessage('');
  };

  const removeFile = (index: number) => {
    setSelectedFiles(prev => prev.filter((_, i) => i !== index));
  };

  const startProcessing = async () => {
    if (selectedFiles.length === 0) return;

    setIsUploading(true);
    setStatus('UPLOADING');
    setUploadProgress(0);
    setUploadEta('calculating...');
    setErrorMessage('');

    try {
      // ELECTRON DESKTOP APP FLOW:
      if (window.electron) {
        setUploadEta('Getting file paths...');
        const filePaths = [];
        for (const file of selectedFiles) {
          const path = await window.electron.getFilePath(file);
          filePaths.push(path);
        }
        console.log("Processing local files:", filePaths);

        setUploadProgress(100);
        setStatus('PROCESSING');
        setUploadEta('Starting local processing...');

        // Call backend to start processing local files directly
        const res = await fetch('http://localhost:8000/process_local', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filePaths: filePaths }),
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
        return;
      }

      // Browser Fallback (Single file only for now)
      if (selectedFiles.length > 1) {
        alert("Multi-file merge is currently optimized for Desktop App (Electron). In browser, please upload a single pre-merged file or use the Desktop App.");
        setIsUploading(false);
        setStatus('IDLE');
        return;
      }

      const file = selectedFiles[0];
      const CHUNK_SIZE = 1024 * 1024;
      const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
      const startTime = Date.now();

      // Step 1: Initialize
      const initRes = await fetch('http://localhost:8000/upload/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: file.name, fileSize: file.size }),
      });
      const initData = await initRes.json();
      const fileId = initData.file_id;

      const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

      // Step 2: Send chunks
      const sendChunk = (chunkIndex: number): Promise<void> => {
        return new Promise((resolve, reject) => {
          const start = chunkIndex * CHUNK_SIZE;
          const end = Math.min(start + CHUNK_SIZE, file.size);
          const blob = file.slice(start, end);

          const xhr = new XMLHttpRequest();
          xhr.open('POST', `http://localhost:8000/upload/chunk/${fileId}`, true);
          xhr.setRequestHeader('Content-Type', 'application/octet-stream');

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

    } catch (err: any) {
      console.error("Upload/Process failed", err);
      setStatus('ERROR');
      setErrorMessage(err.message || "An unexpected error occurred");
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
    setSelectedFiles([]);
    setErrorMessage('');
  };

  const connectWebSocket = (fid: string) => {
    const ws = new WebSocket(`ws://localhost:8000/ws/${fid}`);

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);

      // Handle error status from WS
      if (data.status === 'error' || data.step === 'error') {
        setStatus('ERROR');
        setErrorMessage(data.message || data.details || "Processing error");
        return;
      }

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
      setStatus('ERROR');
      setErrorMessage("Connection lost to server");
    }
  };

  const fetchSegments = async (fid: string) => {
    try {
      const res = await fetch(`http://localhost:8000/project/${fid}`);
      const data = await res.json();
      if (data.segments) setSegments(data.segments);
    } catch (e) {
      console.error("Failed to fetch segments", e);
    }
  };

  const handleExport = async () => {
    if (!fileId) return;
    setStatus('RENDERING');
    try {
      await fetch('http://localhost:8000/render', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          file_id: fileId,
          segments: segments.filter((s: Segment) => s.type === 'keep' || !s.type)
        }),
      });
    } catch (e: any) {
      console.error("Export failed", e);
      setStatus('ERROR');
      setErrorMessage(e.message || "Export failed");
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
      {isManualMode && fileId && (
        <div className="fixed inset-0 z-50 bg-black">
          <ManualEditor
            fileId={fileId}
            duration={duration}
            segments={segments}
            onSegmentsChange={setSegments}
            currentTime={currentTime}
            onSeek={(t) => {
              setCurrentTime(t);
              if (videoRef.current) videoRef.current.currentTime = t;
            }}
            onExit={() => setIsManualMode(false)}
          />
        </div>
      )}

      <div className={`w-full max-w-4xl space-y-8 ${isManualMode ? 'hidden' : ''}`}>
        <header className="text-center space-y-2">
          <h1 className="text-4xl font-black tracking-tighter bg-clip-text text-transparent bg-gradient-to-r from-blue-400 to-green-400">
            JUMP-CUTTER AI
          </h1>
          <p className="text-gray-400">Silence Removal & Auto-Correction System</p>
        </header>

        <main className="w-full space-y-6">
          {status === 'IDLE' || status === 'UPLOADING' ? (
            <div className="space-y-4">
              <UploadZone
                onFileSelect={handleFileSelect}
                isUploading={isUploading}
                uploadProgress={uploadProgress}
                uploadEta={uploadEta}
              />

              {selectedFiles.length > 0 && !isUploading && (
                <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-4 animate-fade-in">
                  <div className="flex justify-between items-center">
                    <h3 className="text-lg font-bold text-gray-300">Selected Files ({selectedFiles.length})</h3>
                    <button
                      onClick={() => setSelectedFiles([])}
                      className="text-xs text-gray-500 hover:text-red-400"
                    >
                      Clear All
                    </button>
                  </div>

                  <ul className="space-y-2 max-h-40 overflow-y-auto custom-scrollbar">
                    {selectedFiles.map((file, i) => (
                      <li key={i} className="flex justify-between items-center bg-gray-800/50 p-2 rounded">
                        <span className="text-sm truncate max-w-[80%]">{file.name}</span>
                        <button
                          onClick={() => removeFile(i)}
                          className="text-gray-500 hover:text-red-400 px-2"
                        >
                          ✕
                        </button>
                      </li>
                    ))}
                  </ul>

                  <button
                    onClick={startProcessing}
                    className="w-full py-3 bg-gradient-to-r from-blue-600 to-green-600 hover:from-blue-500 hover:to-green-500 rounded-lg font-bold text-lg shadow-lg transition-all transform hover:scale-[1.02]"
                  >
                    START PROCESSING
                  </button>
                </div>
              )}
            </div>
          ) : (
            <Scanner
              progress={progress}
              status={status}
              stepLabel={stepLabel}
              eta={processingEta}
              errorMessage={errorMessage}
              onCancel={handleCancel}
              onReset={handleReset}
            />
          )}

          {status === 'TIMELINE' && fileId && (
            <div className="space-y-4">
              <div className="relative aspect-video bg-black rounded-lg overflow-hidden border border-gray-800">
                <video
                  ref={videoRef}
                  src={`http://localhost:8000/stream/${fileId}`}
                  className="w-full h-full"
                  controls
                  onTimeUpdate={onTimeUpdate}
                  onLoadedMetadata={onLoadedMetadata}
                />
              </div>

              {/* Legacy Timeline Removed as per user request */}

              <div className="flex justify-end gap-4">
                <button
                  onClick={() => setIsManualMode(true)}
                  className="px-6 py-2 bg-purple-600 hover:bg-purple-500 rounded-full font-bold shadow-lg transition"
                >
                  Open Manual Editor
                </button>

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
