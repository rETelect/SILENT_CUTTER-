import sys
import os
import subprocess

with open("diagnosis.log", "w") as f:
    f.write(f"Python: {sys.executable}\n")
    f.write(f"Version: {sys.version}\n")
    
    try:
        import torch
        f.write(f"Torch: {torch.__version__}\n")
    except ImportError as e:
        f.write(f"Torch Error: {e}\n")

    try:
        import ffmpeg
        f.write("ffmpeg-python: Installed\n")
    except ImportError as e:
        f.write(f"ffmpeg-python Error: {e}\n")
        
    try:
        subprocess.check_call(["ffmpeg", "-version"])
        f.write("ffmpeg binary: Found\n")
    except Exception as e:
        f.write(f"ffmpeg binary Error: {e}\n")
