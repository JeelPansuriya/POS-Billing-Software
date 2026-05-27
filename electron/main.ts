import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import path from 'node:path';
import { autoUpdater } from 'electron-updater';
import { initDb } from './db';
import { registerIpcHandlers } from './ipc';
import { maybeRunScheduledSync } from './sync';

const isDev = !!process.env.VITE_DEV_SERVER_URL;

let mainWindow: BrowserWindow | null = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());

  if (isDev) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL!);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }
}

app.whenReady().then(() => {
  initDb();
  registerIpcHandlers(ipcMain);
  createWindow();

  // Catch up immediately on launch in case scheduled times were missed
  // while the app was closed.
  maybeRunScheduledSync().catch((e) => console.error('Startup sync failed:', e));
  // Then check every minute.
  setInterval(() => {
    maybeRunScheduledSync().catch((e) => console.error('Scheduled sync failed:', e));
  }, 60_000);

  // Auto-update check (production only — there's no published version while
  // running `npm run dev`). Uses the GitHub Releases provider declared in
  // package.json#build.publish.
  if (!isDev) {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('update-downloaded', async () => {
      const { response } = await dialog.showMessageBox({
        type: 'info',
        buttons: ['Restart now', 'Later'],
        defaultId: 0,
        title: 'Update ready',
        message:
          'A new version of Girr Kathiyawadi POS has been downloaded. Restart now to install? It will install automatically the next time you close the app.',
      });
      if (response === 0) autoUpdater.quitAndInstall();
    });
    autoUpdater.on('error', (err) => console.error('Auto-update error:', err));
    // Check on startup, then every 6 hours.
    autoUpdater.checkForUpdatesAndNotify().catch((e) => console.error(e));
    setInterval(
      () => autoUpdater.checkForUpdatesAndNotify().catch((e) => console.error(e)),
      6 * 60 * 60 * 1000
    );
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

export function getMainWindow() {
  return mainWindow;
}
