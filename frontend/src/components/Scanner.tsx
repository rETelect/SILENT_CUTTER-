import React, { useEffect, useRef, useState } from 'react';

interface ScannerProps {
  progress: number; // 0 to 100
  status: string;
  stepLabel: string;
  eta?: string;
  errorMessage?: string; // New prop for detailed error
  onCancel?: () => void;
  onReset?: () => void;
}

const Scanner: React.FC<ScannerProps> = ({ progress, status, stepLabel, eta = '', errorMessage, onCancel, onReset }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const [waveform] = useState<number[]>(() => {
    const points = 100;
    return Array.from({ length: points }, () => Math.random());
  });

  // Generate random waveform on mount
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;
    const barWidth = width / waveform.length;

    // Clear canvas
    ctx.clearRect(0, 0, width, height);

    // Draw background
    ctx.fillStyle = '#111111';
    ctx.fillRect(0, 0, width, height);

    // Draw waveform
    waveform.forEach((value, index) => {
      const x = index * barWidth;
      const barHeight = value * height * 0.8;
      const y = (height - barHeight) / 2;

      const isScanned = (index / waveform.length) * 100 < progress;

      if (isScanned) {
        ctx.fillStyle = value > 0.4 ? '#00ff41' : '#ff3333';
        ctx.shadowBlur = 10;
        ctx.shadowColor = ctx.fillStyle;
      } else {
        ctx.fillStyle = '#333333';
        ctx.shadowBlur = 0;
      }

      ctx.fillRect(x, y, barWidth - 1, barHeight);
    });

    // Draw Scanner Line
    const scannerX = (progress / 100) * width;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(scannerX, 0, 2, height);

    // Add glow to scanner
    ctx.shadowBlur = 15;
    ctx.shadowColor = '#ffffff';

  }, [progress, waveform]);

  const isComplete = status === 'complete';
  const isError = status === 'ERROR' || status === 'error';

  return (
    <div className="w-full flex flex-col items-center gap-4 p-6 bg-black rounded-xl border border-gray-800 shadow-2xl">
      <h2 className="text-xl font-mono text-neon-blue tracking-widest uppercase">
        AI Processing Unit
      </h2>

      {/* Waveform canvas */}
      <div className="relative w-full h-32 bg-gray-900 rounded-lg overflow-hidden border border-gray-700">
        <canvas
          ref={canvasRef}
          width={800}
          height={128}
          className="w-full h-full object-cover"
        />
        {/* Status overlay */}
        <div className={`absolute top-2 right-2 text-xs font-mono ${isError ? 'text-red-500' : 'text-green-400'}`}>
          STATUS: {status.toUpperCase()}
        </div>
      </div>

      {/* Progress bar */}
      <div className="w-full h-2 bg-gray-800 rounded-full overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-300 ease-out"
          style={{
            width: `${progress}%`,
            background: isComplete
              ? 'linear-gradient(90deg, #00ff41, #22c55e)'
              : isError
                ? '#dc2626'
                : 'linear-gradient(90deg, #3b82f6, #8b5cf6)',
            boxShadow: isComplete
              ? '0 0 12px rgba(0, 255, 65, 0.6)'
              : '0 0 8px rgba(59, 130, 246, 0.5)',
          }}
        />
      </div>

      <div className="flex justify-between w-full text-xs font-mono text-gray-400">
        <span>{stepLabel || (isError ? 'Process Failed' : 'Initializing...')}</span>
        <span>{eta ? `ETA: ${eta}` : ''}</span>
      </div>

      {/* Error Message Box */}
      {isError && (
        <div className="w-full p-4 bg-red-900/30 border border-red-500/50 rounded-lg text-red-200 font-mono text-sm break-all animate-pulse">
          <div className="font-bold flex items-center gap-2 mb-1">
            <span className="text-xl">⚠️</span> PROCESSING ERROR
          </div>
          {errorMessage || stepLabel || "Unknown error occurred"}
        </div>
      )}

      {/* Buttons */}
      <div className="flex gap-4 mt-2 justify-center w-full">
        {onCancel && !isComplete && !isError && (
          <button
            onClick={onCancel}
            className="px-6 py-2 border border-red-500/50 text-red-400 hover:bg-red-500/10 rounded uppercase text-xs tracking-wider"
          >
            Cancel
          </button>
        )}
        {(isComplete || isError) && onReset && (
          <button
            onClick={onReset}
            className={`px-8 py-3 rounded font-bold uppercase text-xs tracking-wider shadow-lg transition-transform hover:scale-105 ${isError
                ? 'bg-red-600 hover:bg-red-500 text-white'
                : 'bg-blue-600 hover:bg-blue-500 text-white'
              }`}
          >
            {isError ? 'Try Again' : 'Continue'}
          </button>
        )}
      </div>
    </div>
  );
};

export default Scanner;
