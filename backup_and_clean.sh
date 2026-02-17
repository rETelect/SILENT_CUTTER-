#!/bin/bash

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_NAME="project_backup_$TIMESTAMP.tar.gz"

echo "Creating project backup: $BACKUP_NAME"
echo "Including source code, configuration, and scripts..."
echo "Excluding: node_modules, dist, __pycache__, outputs, logs"

# Create backup archive
# We exclude 'outputs' to avoid backing up large video files.
# We exclude 'node_modules' because they can be re-installed.
tar -czvf "$BACKUP_NAME" \
    --exclude='node_modules' \
    --exclude='dist' \
    --exclude='__pycache__' \
    --exclude='backend/__pycache__' \
    --exclude='backend/venv' \
    --exclude='backend/uploads' \
    --exclude='.git' \
    --exclude='backend/outputs' \
    --exclude='backend/*.log' \
    --exclude='*.tar.gz' \
    .

echo "Backup created successfully: $BACKUP_NAME"

echo "Cleaning up temporary files..."

# Backend cleanup
rm -rf backend/__pycache__
rm -f backend/backend_debug.log
rm -f backend/*.log

# Intermediate processing files (keep final mp4s)
rm -f backend/outputs/*.wav
rm -f backend/outputs/*_concat.txt
rm -f backend/outputs/ffmpeg_*.log

# Frontend cleanup
rm -rf frontend/dist

echo "Cleanup complete."
echo "Note: Processed videos (*.mp4) in backend/outputs were NOT deleted."
echo "Note: node_modules were NOT deleted (to allow running the app)."
