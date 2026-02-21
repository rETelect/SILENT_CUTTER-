# Note: If your editor shows "ModuleNotFoundError", ensure you have selected the 'venv' interpreter.
from fastapi import FastAPI, UploadFile, File, WebSocket, WebSocketDisconnect, Request, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, FileResponse
import uvicorn
import shutil
import asyncio
import os
import uuid
from pathlib import Path
from pydantic import BaseModel
from typing import List, Dict, Any
from processor import VideoProcessor

from fastapi.staticfiles import StaticFiles


app = FastAPI()

app.mount("/outputs", StaticFiles(directory="outputs"), name="outputs")

# CORS configuration
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # For development convenience
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# storage for uploaded files
UPLOAD_DIR = Path("uploads")
OUTPUT_DIR = Path("outputs")
UPLOAD_DIR.mkdir(exist_ok=True)
OUTPUT_DIR.mkdir(exist_ok=True)

# Track pending chunked uploads: file_id -> {filename, path, chunks_received}
pending_uploads: dict = {}

# Track local file paths for Electron app: file_id -> absolute_path
local_file_paths: dict = {}

# Track active processors for cancellation: file_id -> VideoProcessor
active_processors: dict = {}

# Track extra metadata (like source maps) for projects: file_id -> dict
project_metadata: dict = {}

# active websocket connections
class ConnectionManager:
    def __init__(self):
        self.active_connections: list[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)

    def disconnect(self, websocket: WebSocket):
        self.active_connections.remove(websocket)

    async def broadcast(self, message: dict):
        for connection in self.active_connections:
            await connection.send_json(message)

manager = ConnectionManager()

@app.get("/")
def read_root():
    return {"status": "ok", "message": "Video Jump-Cutter API is running"}

@app.post("/process_local")
async def process_local(request: Request):
    """Register local file path(s) for processing (Electron mode)."""
    body = await request.json()
    # Support both single 'filePath' (legacy) and 'filePaths' (list)
    file_path_str = body.get("filePath")
    file_paths_list = body.get("filePaths")
    
    input_paths = []
    if file_paths_list and isinstance(file_paths_list, list):
        input_paths = [Path(p) for p in file_paths_list]
    elif file_path_str:
        input_paths = [Path(file_path_str)]
    
    if not input_paths:
        return JSONResponse(status_code=400, content={"status": "error", "message": "No filePath provided"})
    
    # Check existence
    for p in input_paths:
        if not p.exists():
             return JSONResponse(status_code=404, content={"status": "error", "message": f"File not found: {p}"})

    file_id = str(uuid.uuid4())
    
    if len(input_paths) == 1:
        local_file_paths[file_id] = input_paths[0]
        return {"file_id": file_id, "filename": input_paths[0].name, "status": "ready"}
    else:
        # Merge needed
        output_filename = f"merged_{file_id}.mp4"
        output_path = OUTPUT_DIR / output_filename
        try:
            print(f"Merging {len(input_paths)} files...")
            
            # 1. Calculate source map (names & durations) for frontend
            import ffmpeg
            current_time = 0.0
            source_map = []
            
            for p in input_paths:
                try:
                    probe = ffmpeg.probe(str(p))
                    dur = float(probe['format']['duration'])
                    source_map.append({
                        "filename": p.name,
                        "start": current_time,
                        "duration": dur,
                        "end": current_time + dur
                    })
                    current_time += dur
                except Exception as e:
                    print(f"Error probing {p}: {e}")
            
            merged_path = await VideoProcessor.concat_videos(input_paths, output_path)
            local_file_paths[file_id] = merged_path
            
            # Store metadata
            project_metadata[file_id] = { "sources": source_map }

            return {"file_id": file_id, "filename": output_filename, "status": "ready", "sources": source_map}
        except Exception as e:
            print(f"Merge error: {e}")
            return JSONResponse(status_code=500, content={"status": "error", "message": f"Merge failed: {str(e)}"})

@app.post("/cancel/{file_id}")
async def cancel_processing(file_id: str):
    """Cancel processing for a specific file."""
    if file_id in active_processors:
        try:
            active_processors[file_id].cancel()
            return {"status": "cancelled", "message": "Cancellation requested"}
        except Exception as e:
            return JSONResponse(status_code=500, content={"status": "error", "message": str(e)})
            
    return JSONResponse(status_code=404, content={"status": "error", "message": "Process not found or already finished"})

@app.post("/upload")
async def upload_video(file: UploadFile = File(...)):
    file_id = str(uuid.uuid4())
    file_path = UPLOAD_DIR / f"{file_id}_{file.filename}"
    
    # Use chunked async writing for large files (8GB+)
    # shutil.copyfileobj blocks the event loop on large files
    CHUNK_SIZE = 1024 * 1024  # 1MB chunks
    with open(file_path, "wb") as buffer:
        while True:
            chunk = await file.read(CHUNK_SIZE)
            if not chunk:
                break
            buffer.write(chunk)
        
    return {"file_id": file_id, "filename": file.filename, "status": "uploaded"}

# --- Chunked upload endpoints for large files (8GB+) ---

@app.post("/upload/init")
async def upload_init(request: Request):
    """Initialize a chunked upload. Returns a file_id to use for subsequent chunks."""
    body = await request.json()
    filename = body.get("filename", "video.mp4")
    file_size = body.get("fileSize", 0)
    
    file_id = str(uuid.uuid4())
    file_path = UPLOAD_DIR / f"{file_id}_{filename}"
    
    # Create empty file
    file_path.touch()
    
    pending_uploads[file_id] = {
        "filename": filename,
        "path": file_path,
        "file_size": file_size,
        "bytes_received": 0
    }
    
    return {"file_id": file_id, "filename": filename, "status": "initialized"}

@app.post("/upload/chunk/{file_id}")
async def upload_chunk(file_id: str, request: Request):
    """Receive a single chunk and append it to the file."""
    if file_id not in pending_uploads:
        return JSONResponse(status_code=404, content={"error": "Upload not found"})
    
    info = pending_uploads[file_id]
    chunk_data = await request.body()
    
    with open(info["path"], "ab") as f:
        f.write(chunk_data)
    
    info["bytes_received"] += len(chunk_data)
    
    return {"status": "chunk_received", "bytes_received": info["bytes_received"]}

class AnalyzeRequest(BaseModel):
    file_path: str

class RenderRequest(BaseModel):
    file_id: str
    segments: List[Dict[str, Any]]

@app.post("/analyze")
async def analyze_local_file(request: AnalyzeRequest):
    """Start analysis on a local file (Direct 8GB Direct Access)."""
    file_path_str = request.file_path
    file_path = Path(file_path_str)
    
    if not file_path.exists():
        raise HTTPException(status_code=404, detail=f"File not found on server: {file_path_str}")
        
    file_id = str(uuid.uuid4())
    
    try:
        processor = VideoProcessor(file_path, output_dir=OUTPUT_DIR, file_id=file_id)
        active_processors[file_id] = processor
        
        # processor initialized but not started. WS will start it.
        # This prevents double-execution.
        
        return {
            "status": "success",
            "file_id": file_id,
            "message": "Analysis started",
            "file_name": file_path.name
        }
    except Exception as e:
        print(f"Error initializing processor: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/render")
async def render_video(request: RenderRequest):
    """Render video from manually confirmed segments."""
    file_id = request.file_id
    if file_id not in active_processors:
        raise HTTPException(status_code=404, detail="Project not found or expired")
    
    processor = active_processors[file_id]
    try:
        # Start rendering in background
        # We don't await here to return quickly, but we need to track it?
        # Actually websocket reports progress.
        asyncio.create_task(processor.render_from_segments(request.segments))
        
        return {"status": "success", "message": "Rendering started"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/project/{file_id}")
async def get_project_status(file_id: str):
    """Get current project status and data."""
    if file_id not in active_processors:
        raise HTTPException(status_code=404, detail="Project not found")
    
    proc = active_processors[file_id]
    # We might need to store segments in processor to retrieve them here
    # Currently they are returned by process_async but not stored in a public attribute?
    # We should update processor.py to store self.segments
    return {
        "file_id": file_id,
        "status": "active", # Simplified
        "file_path": str(proc.file_path),
        "segments": proc.segments,
        "sources": proc.source_map
    }

@app.get("/project/{file_id}/waveform")
async def get_project_waveform(file_id: str):
    """Get waveform peak data for visualization."""
    if file_id not in active_processors:
        raise HTTPException(status_code=404, detail="Project not found")
        
    proc = active_processors[file_id]
    data = proc.get_waveform_data()
    return {"waveform": data}

@app.get("/stream/{file_id}")
async def stream_video(file_id: str):
    """Stream the video file for preview."""
    if file_id not in active_processors:
        raise HTTPException(status_code=404, detail="Project not found")
    
    proc = active_processors[file_id]
    if not proc.file_path.exists():
        raise HTTPException(status_code=404, detail="File not found")
        
    return FileResponse(proc.file_path)

@app.post("/upload/complete/{file_id}")
async def upload_complete(file_id: str):
    """Finalize a chunked upload."""
    if file_id not in pending_uploads:
        return JSONResponse(status_code=404, content={"error": "Upload not found"})
    
    info = pending_uploads.pop(file_id)
    
    return {
        "file_id": file_id,
        "filename": info["filename"],
        "status": "uploaded",
        "total_bytes": info["bytes_received"]
    }

@app.websocket("/ws/{file_id}")
async def websocket_endpoint(websocket: WebSocket, file_id: str):
    await manager.connect(websocket)
    try:
        # Check if processor already exists (initialized by /analyze)
        if file_id in active_processors:
            processor = active_processors[file_id]
        else:
            # Check local_file_paths (from /process_local)
            file_path = None
            if file_id in local_file_paths:
                file_path = local_file_paths[file_id]
            else:
                # Fallback legacy logic for uploads
                for f in UPLOAD_DIR.iterdir():
                    if f.name.startswith(file_id):
                        file_path = f
                        break
            
            if not file_path:
                await websocket.send_json({"status": "error", "message": "File not found"})
                return

            processor = VideoProcessor(file_path, output_dir=OUTPUT_DIR, file_id=file_id)
            if file_id in project_metadata:
                 processor.source_map = project_metadata[file_id].get("sources", [])
            active_processors[file_id] = processor
        
        async def status_callback(status):
            await websocket.send_json(status)

        processor.set_callback(status_callback)
        
        try:
            # Run analysis. If it returns None, it means we are in interactive mode.
            output_file = await processor.process_async(auto_render=False)
            
            if output_file is None:
                # Interactive mode: Wait for render completion signal
                # This keeps the WS open while user edits segments.
                await processor.completion_event.wait()
                output_file = processor.final_output

            # notify completion
            if output_file:
                await websocket.send_json({
                    "step": "complete",
                    "progress": 100,
                    "output_file": os.path.basename(output_file)
                })
            
        except RuntimeError as e:
            if "Cancelled" in str(e):
                await websocket.send_json({"status": "cancelled", "message": "Processing cancelled by user"})
            else:
                raise e
        finally:
            # Only clean up if we are truly done OR invalid file_id
            # But here final_output check handles success.
            # If WS disconnects, we might want to keep processor alive for a bit?
            # But typically disconnect = cancel.
            # However, for "Refresh", we want to reconnect.
            # Given we store processor in `active_processors`, we should ONLY delete if complete/cancelled.
            # But `finally` runs on disconnect too.
            # Let's cancel if disconnect.
            pass # We don't delete here. We delete in shutdown or periodic cleanup (not implemented yet).
            # Or we can delete if complete.
            
    except WebSocketDisconnect:
        manager.disconnect(websocket)
        # Only cancel if not complete?
        # For now, let's leave it. If user refreshes, they might lose progress if we cancel.
        # But if we don't cancel, we leak.
        # Let's cancel to be safe for now, assuming standard flow.
        if file_id in active_processors:
             active_processors[file_id].cancel()
             del active_processors[file_id]
            
    except Exception as e:
        import traceback
        traceback.print_exc()
        print(f"WebSocket processing error: {e}", flush=True)
        await websocket.send_json({"status": "error", "message": str(e)})

@app.on_event("shutdown")
async def shutdown_event():
    """Cleanup active processors on shutdown."""
    print("Shutting down, cancelling active processors...")
    for file_id, processor in list(active_processors.items()):
        try:
            processor.cancel()
        except Exception as e:
            print(f"Error cancelling processor {file_id}: {e}")

if __name__ == "__main__":
    import uvicorn
    # Use 0.0.0.0 to allow external access if needed, but localhost is safer for desktop app
    uvicorn.run(app, host="0.0.0.0", port=8000)
