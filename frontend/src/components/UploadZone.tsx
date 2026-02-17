import React, { useCallback } from 'react';

interface UploadZoneProps {
    onFileSelect: (file: File) => void;
    isUploading: boolean;
    uploadProgress?: number;
    uploadEta?: string;
}

const UploadZone: React.FC<UploadZoneProps> = ({ onFileSelect, isUploading, uploadProgress = 0, uploadEta = '' }) => {
    const handleDrop = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            onFileSelect(e.dataTransfer.files[0]);
        }
    }, [onFileSelect]);

    const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files && e.target.files.length > 0) {
            onFileSelect(e.target.files[0]);
        }
    }, [onFileSelect]);

    return (
        <div
            onDrop={handleDrop}
            onDragOver={(e) => e.preventDefault()}
            className={`
                w-full border-2 border-dashed rounded-xl flex flex-col items-center justify-center cursor-pointer
                transition-all duration-300
                ${isUploading
                    ? 'border-green-500 bg-green-500/5 h-auto py-8'
                    : 'border-gray-600 hover:border-blue-500 hover:bg-gray-800 h-64'
                }
            `}
        >
            <input
                type="file"
                className="hidden"
                id="file-upload"
                accept="video/*"
                onChange={handleChange}
                disabled={isUploading}
            />

            {isUploading ? (
                <div className="w-full px-8 flex flex-col items-center gap-4">
                    <div className="text-3xl">🚀</div>
                    <p className="text-lg font-medium text-gray-200">
                        Uploading Video...
                    </p>

                    {/* Progress bar */}
                    <div className="w-full max-w-md h-3 bg-gray-800 rounded-full overflow-hidden border border-gray-700">
                        <div
                            className="h-full rounded-full transition-all duration-300 ease-out"
                            style={{
                                width: `${uploadProgress}%`,
                                background: 'linear-gradient(90deg, #00ff41, #008F11)',
                                boxShadow: '0 0 10px rgba(0, 255, 65, 0.5)',
                            }}
                        />
                    </div>

                    {/* Stats row */}
                    <div className="w-full max-w-md flex justify-between font-mono text-sm">
                        <span className="text-green-400 font-bold">
                            {uploadProgress}%
                        </span>
                        <span className="text-gray-400">
                            {uploadEta || 'calculating...'}
                        </span>
                    </div>
                </div>
            ) : (
                <label htmlFor="file-upload" className="flex flex-col items-center justify-center w-full h-full">
                    <div className="text-4xl mb-4">📁</div>
                    <p className="text-lg font-medium text-gray-300">
                        Drag & Drop Video or Click to Browse
                    </p>
                    <p className="text-sm text-gray-500 mt-2">
                        Supports MP4, MOV, AVI
                    </p>
                </label>
            )}
        </div>
    );
};

export default UploadZone;
