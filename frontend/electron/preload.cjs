const { contextBridge, webUtils } = require('electron');

contextBridge.exposeInMainWorld('electron', {
    getFilePath: (file) => {
        // webUtils.getPathForFile is the modern way to get the full path from a File object in Electron
        return webUtils.getPathForFile(file);
    }
});
