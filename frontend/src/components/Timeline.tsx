import React, { useRef, useEffect, useState } from 'react';

interface Segment {
    start: number;
    end: number;
    type?: 'keep' | 'cut';
}

interface TimelineProps {
    fileId: string;
    duration: number; // Total duration in seconds
    segments: Segment[];
    onSegmentsChange: (segments: Segment[]) => void;
    currentTime: number;
    onSeek: (time: number) => void;
}

const Timeline: React.FC<TimelineProps> = ({
    fileId,
    duration,
    segments,
    onSegmentsChange,
    currentTime,
    onSeek
}) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const [waveform, setWaveform] = useState<number[]>([]);
    const [loading, setLoading] = useState(true);
    const [zoom, setZoom] = useState(1);

    // Tools: 'pointer' (Seek/Toggle) vs 'range' (Select Interval)
    const [tool, setTool] = useState<'pointer' | 'range'>('pointer');

    // Selection State
    const [selection, setSelection] = useState<{ start: number, end: number } | null>(null);
    const [isDragging, setIsDragging] = useState(false);
    const dragStartRef = useRef<number | null>(null);

    // Keyboard Shortcuts
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key.toLowerCase() === 'r') {
                setTool(t => t === 'pointer' ? 'range' : 'pointer');
            }
            if (e.key === 'Escape') {
                setSelection(null);
                setTool('pointer');
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, []);

    // Initialize segments with gaps filled
    useEffect(() => {
        if (segments.length === 0 || duration === 0) return;
        if (segments.some(s => s.type === 'cut')) return;

        const filled: Segment[] = [];
        let t = 0;
        const sorted = [...segments].sort((a, b) => a.start - b.start);

        sorted.forEach(s => {
            if (s.start > t + 0.1) {
                filled.push({ start: t, end: s.start, type: 'cut' });
            }
            filled.push({ ...s, type: 'keep' });
            t = s.end;
        });

        if (t < duration) {
            filled.push({ start: t, end: duration, type: 'cut' });
        }

        if (filled.length !== segments.length) {
            onSegmentsChange(filled);
        }
    }, [segments, duration, onSegmentsChange]);

    // Fetch waveform data
    useEffect(() => {
        const fetchWaveform = async () => {
            try {
                const res = await fetch(`http://localhost:8000/project/${fileId}/waveform`);
                const data = await res.json();
                if (data.waveform && Array.isArray(data.waveform)) {
                    setWaveform(data.waveform);
                } else if (Array.isArray(data)) {
                    setWaveform(data);
                }
            } catch (err) {
                console.error("Failed to load waveform", err);
            } finally {
                setLoading(false);
            }
        };
        fetchWaveform();
    }, [fileId]);

    // Draw Canvas
    useEffect(() => {
        const canvas = canvasRef.current;
        const container = containerRef.current;
        if (!canvas || !container || waveform.length === 0) return;

        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        // Handle resize & Zoom
        const containerWidth = container.clientWidth;
        const width = containerWidth * zoom;
        const height = 120;

        canvas.width = width;
        canvas.height = height;
        canvas.style.width = `${width}px`;

        // Clear
        ctx.clearRect(0, 0, width, height);

        // Draw Background
        ctx.fillStyle = '#1a1a1a';
        ctx.fillRect(0, 0, width, height);

        // Draw Waveform
        ctx.beginPath();
        ctx.strokeStyle = '#4b5563';
        ctx.lineWidth = 1;

        const step = width / waveform.length;
        const midY = height / 2;

        waveform.forEach((val, i) => {
            const x = i * step;
            const h = val * (height * 0.8);
            ctx.moveTo(x, midY - h / 2);
            ctx.lineTo(x, midY + h / 2);
        });
        ctx.stroke();

        // Draw Segments
        segments.forEach(seg => {
            const startX = (seg.start / duration) * width;
            const endX = (seg.end / duration) * width;
            const w = Math.max(endX - startX, 1);

            if (seg.type === 'keep' || !seg.type) {
                ctx.fillStyle = 'rgba(34, 197, 94, 0.3)';
                ctx.fillRect(startX, 0, w, height);
                ctx.strokeStyle = 'rgba(34, 197, 94, 0.8)';
                ctx.strokeRect(startX, 0, w, height);
            } else {
                ctx.fillStyle = 'rgba(239, 68, 68, 0.2)';
                ctx.fillRect(startX, 0, w, height);
            }
        });

        // Draw Selection Overlay
        if (selection) {
            const startX = (selection.start / duration) * width;
            const endX = (selection.end / duration) * width;
            const selW = endX - startX;
            ctx.fillStyle = 'rgba(59, 130, 246, 0.3)'; // Blue
            ctx.fillRect(startX, 0, selW, height);
            ctx.strokeStyle = '#3b82f6';
            ctx.lineWidth = 2;
            ctx.strokeRect(startX, 0, selW, height);
        }

        // Draw Cursor
        const cursorX = (currentTime / duration) * width;
        ctx.strokeStyle = '#ffff00';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(cursorX, 0);
        ctx.lineTo(cursorX, height);
        ctx.stroke();

    }, [waveform, segments, currentTime, duration, zoom, selection]);

    // Mouse Handlers
    const getTimestamp = (e: React.MouseEvent) => {
        if (!canvasRef.current || duration === 0) return 0;
        const x = e.nativeEvent.offsetX;
        const width = canvasRef.current.width;
        return (x / width) * duration;
    };

    const handleMouseDown = (e: React.MouseEvent) => {
        if (e.button !== 0) return; // Only left click

        const t = getTimestamp(e);

        if (tool === 'range') {
            setIsDragging(true);
            dragStartRef.current = t;
            if (!e.ctrlKey) setSelection(null);
        } else {
            // Pointer Mode: Seek or Toggle
            // We'll handle Toggle in Click
            // But allow Seek on MouseDown?
            // Standard: Seek on Click/Drag?
            // Let's allow simple Seek.
            onSeek(t);
        }
    };

    const handleMouseMove = (e: React.MouseEvent) => {
        if (tool === 'range') {
            if (!isDragging || dragStartRef.current === null) return;
            const t = getTimestamp(e);
            const start = Math.min(dragStartRef.current, t);
            const end = Math.max(dragStartRef.current, t);
            setSelection({ start, end });
        } else {
            // Pointer Mode: Maybe dragging scrubbing?
            // Not implemented for MVP simplicity.
        }
    };

    const handleMouseUp = (e: React.MouseEvent) => {
        if (tool === 'range') {
            if (!isDragging) return;
            setIsDragging(false);
            // If tiny drag -> Treat as click?
            if (dragStartRef.current !== null) {
                const t = getTimestamp(e);
                const dist = Math.abs(t - dragStartRef.current);
                if (dist < 0.2) {
                    // Click in Range Mode -> Clear selection
                    setSelection(null);
                }
            }
            dragStartRef.current = null;
        }
    };

    const handleClick = (e: React.MouseEvent) => {
        // This runs AFTER mouseUp
        if (tool === 'pointer') {
            const t = getTimestamp(e);
            const segmentIndex = segments.findIndex(s => t >= s.start && t <= s.end);
            if ((e.ctrlKey || e.metaKey) && segmentIndex !== -1) {
                const newSegments = [...segments];
                const seg = { ...newSegments[segmentIndex] };
                seg.type = (seg.type === 'cut') ? 'keep' : 'cut';
                newSegments[segmentIndex] = seg;
                onSegmentsChange(newSegments);
            } else {
                onSeek(t);
            }
        }
    };

    const handleRangeAction = (actionType: 'keep' | 'cut') => {
        if (!selection) return;

        // Split segments at Start and End
        let newSegments: Segment[] = [];
        const { start, end } = selection;

        const splitAt = (segs: Segment[], t: number): Segment[] => {
            const res: Segment[] = [];
            segs.forEach(s => {
                if (t > s.start && t < s.end) {
                    res.push({ start: s.start, end: t, type: s.type });
                    res.push({ start: t, end: s.end, type: s.type });
                } else {
                    res.push(s);
                }
            });
            return res;
        };

        // 1. Split at Start
        let temp = splitAt(segments, start);
        // 2. Split at End
        temp = splitAt(temp, end);

        // 3. Update types in range
        newSegments = temp.map(s => {
            const mid = (s.start + s.end) / 2;
            if (mid >= start && mid <= end) {
                return { ...s, type: actionType };
            }
            return s;
        });

        onSegmentsChange(newSegments);
        setSelection(null);
        // Switch back to pointer automatically?
        setTool('pointer');
    };

    const handleWheel = (e: React.WheelEvent) => {
        if (e.ctrlKey) {
            setZoom(z => Math.max(1, Math.min(20, z + (e.deltaY < 0 ? 0.5 : -0.5))));
            e.preventDefault();
        }
    };

    const zoomIn = () => setZoom(z => Math.min(20, z + 1));
    const zoomOut = () => setZoom(z => Math.max(1, z - 1));

    return (
        <div className="w-full bg-[#0a0a0a] border border-gray-800 rounded-xl p-4 space-y-2">
            <div className="flex justify-between items-center text-xs text-gray-400">
                <div className="flex gap-2 items-center">
                    <div className="flex bg-gray-800 rounded p-0.5">
                        <button
                            onClick={() => setTool('pointer')}
                            className={`px-2 py-0.5 rounded ${tool === 'pointer' ? 'bg-blue-600 text-white' : 'hover:bg-gray-700'}`}
                            title="Pointer (Seek/Toggle)"
                        >
                            Pointer
                        </button>
                        <button
                            onClick={() => setTool('range')}
                            className={`px-2 py-0.5 rounded ${tool === 'range' ? 'bg-blue-600 text-white' : 'hover:bg-gray-700'}`}
                            title="Range Selection (Drag)"
                        >
                            Range (R)
                        </button>
                    </div>

                    <div className="h-4 w-px bg-gray-700 mx-1"></div>

                    <button onClick={zoomOut} className="px-2 py-1 bg-gray-800 rounded hover:bg-gray-700">-</button>
                    <span>{zoom.toFixed(1)}x</span>
                    <button onClick={zoomIn} className="px-2 py-1 bg-gray-800 rounded hover:bg-gray-700">+</button>

                    {selection && (
                        <>
                            <div className="h-4 w-px bg-gray-700 mx-2"></div>
                            <span className="text-blue-400">Sel: {(selection.end - selection.start).toFixed(1)}s</span>
                            <button
                                onClick={() => handleRangeAction('cut')}
                                className="px-2 py-1 bg-red-900/50 text-red-200 rounded hover:bg-red-800 border border-red-800"
                            >
                                Cut
                            </button>
                            <button
                                onClick={() => handleRangeAction('keep')}
                                className="px-2 py-1 bg-green-900/50 text-green-200 rounded hover:bg-green-800 border border-green-800"
                            >
                                Keep
                            </button>
                            <button
                                onClick={() => setSelection(null)}
                                className="px-2 py-1 bg-gray-700 rounded hover:bg-gray-600"
                            >
                                X
                            </button>
                        </>
                    )}
                </div>
                <span>{Math.floor(duration / 60)}:{Math.floor(duration % 60).toString().padStart(2, '0')}</span>
            </div>
            <div
                ref={containerRef}
                onWheel={handleWheel}
                className="w-full h-[140px] overflow-x-auto relative custom-scrollbar select-none"
            >
                <canvas
                    ref={canvasRef}
                    onMouseDown={handleMouseDown}
                    onMouseMove={handleMouseMove}
                    onMouseUp={handleMouseUp}
                    onMouseLeave={handleMouseUp}
                    onClick={handleClick}
                    className={`h-[120px] block ${tool === 'range' ? 'cursor-crosshair' : 'cursor-default'}`}
                />
                {loading && (
                    <div className="absolute inset-0 flex items-center justify-center text-sm text-gray-500 pointer-events-none">
                        Loading waveform...
                    </div>
                )}
            </div>
        </div>
    );
};

export default Timeline;
