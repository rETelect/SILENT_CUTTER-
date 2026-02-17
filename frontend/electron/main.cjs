const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

function createWindow() {
    const win = new BrowserWindow({
        width: 1200,
        height: 800,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.cjs'),
        },
    });

    // In dev, load Vite server. In prod, load built file.
    const startUrl = process.env.ELECTRON_START_URL || 'http://localhost:5173';
    win.loadURL(startUrl);
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});

// IPC Handler to get file path
// Frontend sends a file object (which has a path property in Electron context)
ipcMain.handle('get-file-path', async (event, filePath) => {
    // In Electron, the File object in the renderer has a 'path' property
    // We actually don't need to do much here if we allow 'webUtils' or just read it in renderer
    // But strictly speaking, context isolation hides 'path'.
    // Use webUtils.getPathForFile(file) involves newer Electron versions.
    // For now, let's try the simple approach: allow the renderer to send the path it might verify.
    // Actually, simpler: The preload script has access to the internal file path.
    return filePath;
});
