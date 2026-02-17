import React, { useEffect, useRef, useState } from 'react';

interface ScannerProps {
  progress: number; // 0 to 100
  status: string;
  stepLabel: string;
  eta?: string;
  onCancel?: () => void;
  onReset?: () => void;
}

const Scanner: React.FC<ScannerProps> = ({ progress, status, stepLabel, eta = '', onCancel, onReset }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const [waveform, setWaveform] = useState<number[]>([]);

  // Generate random waveform on mount
  useEffect(() => {
    const points = 100;
    const newWaveform = Array.from({ length: points }, () => Math.random());
    setWaveform(newWaveform);
  }, []);

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
        <div className="absolute top-2 right-2 text-xs font-mono text-green-400">
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
              : 'linear-gradient(90deg, #3b82f6, #00ff41)',
            boxShadow: isComplete
              ? '0 0 12px rgba(0, 255, 65, 0.6)'
              : '0 0 8px rgba(59, 130, 246, 0.5)',
          }}
        />
      </div>
      {/* Info row */}
      <div className="w-full flex justify-between font-mono text-xs text-gray-400">
        <span className="text-blue-400 font-semibold">
          {stepLabel || status.toUpperCase()}
        </span>
        <span className={`font-bold ${isComplete ? 'text-green-400' : 'text-white'}`}>
          {Math.round(progress)}%
        </span>
        <span className="text-gray-500">
          {isComplete ? '✅ Done' : eta ? `⏱ ${eta}` : '⏱ calculating...'}
        </span>
      </div>

      {!isComplete && status !== 'error' && status !== 'cancelled' && (
        <button
          onClick={onCancel}
          className="mt-4 px-6 py-2 bg-red-600 hover:bg-red-700 text-white font-bold rounded-lg transition-colors shadow-lg border border-red-500 w-full"
        >
          STOP / CANCEL
        </button>
      )}

      {(status === 'complete' || status === 'error' || status === 'cancelled') && onReset && (
        <button
          onClick={onReset}
          style={{
            marginTop: '1rem',
            padding: '0.8rem 1.6rem',
            background: 'rgba(50, 200, 100, 0.2)',
            border: '1px solid rgba(50, 200, 100, 0.4)',
            color: '#4ade80',
            borderRadius: '8px',
            cursor: 'pointer',
            fontFamily: 'Orbitron, sans-serif',
            fontSize: '0.9rem',
            letterSpacing: '1px',
            transition: 'all 0.3s ease',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'rgba(50, 200, 100, 0.4)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'rgba(50, 200, 100, 0.2)';
          }}
        >
          UPLOAD ANOTHER VIDEO
        </button>
      )}
    </div>
  );
};

export default Scanner;
