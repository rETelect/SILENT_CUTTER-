# Video Jump-Cutter

A powerful, local-first application that automatically detects and removes silence from your videos. Built with a robust Python backend for media processing and a sleek Electron/React frontend for a seamless user experience.

## Features

- **Automated Silence Detection**: Uses `Silero VAD` (Voice Activity Detection) to accurately identify speech and silence segments.
- **Smart Cutting**: Automatically skips silent parts to create a fast-paced, engaging video.
- **Visual Timeline**: Interactive timeline visualizing speech (green) and silence (red) segments.
- **Local Processing**: All video processing happens locally on your machine—no data leaves your computer.
- **Large File Support**: Optimized to handle large video files (8GB+) efficiently.
- **Cross-Platform**: Designed to run on Linux (tested) and compatible with other platforms.

## Technology Stack

- **Backend**: Python, FastAPI, PyTorch, FFmpeg, Silero VAD
- **Frontend**: React, TypeScript, Vite, TailwindCSS
- **Desktop Wrapper**: Electron

## Prerequisites

- **Python 3.12+**
- **Node.js 20+** (and `npm`)
- **FFmpeg** (Must be installed and accessible in your system PATH)

## Installation

### 1. Clone the Repository

```bash
git clone <repository_url>
cd newapp
```

### 2. Backend Setup

Create a virtual environment and install Python dependencies.

```bash
# Navigate to project root
cd newapp

# Create virtual environment
python3 -m venv backend/venv

# Activate virtual environment
source backend/venv/bin/activate

# Install dependencies
pip install -r backend/requirements.txt
```

### 3. Frontend Setup

Install Node.js dependencies.

```bash
cd frontend
npm install
```

## Running the Application

You can run the application using the provided helper scripts or manually.

### Using Scripts (Recommended)

To start both the backend and the Electron app:

```bash
# Make sure the script is executable
chmod +x start_electron.sh

# Run the app
./start_electron.sh
```

### Manual Start

#### 1. Start the Backend API

```bash
# From project root
source backend/venv/bin/activate
cd backend
uvicorn main:app --host 0.0.0.0 --port 8000
```

#### 2. Start the Frontend (Electron)

In a new terminal:

```bash
cd frontend
npm run electron:dev
```

## Usage

1.  **Launch the App**: Open the application using the instructions above.
2.  **Select Video**: Drag and drop a video file or browse to select one.
3.  **Analyze**: The app will process the audio to detect silence.
4.  **Review**: See the generated timeline with cut/keep segments.
5.  **Render**: Click to render the final video with silence removed.
6.  **Output**: The processed video will be saved in the `backend/outputs` directory.

## License

[MIT License](LICENSE)
