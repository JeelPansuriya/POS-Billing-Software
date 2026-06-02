import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import path from 'node:path';
import { autoUpdater } from 'electron-updater';
import { initDb, getDb, writeAudit } from './db';
import { registerIpcHandlers } from './ipc';
import { maybeRunScheduledSync } from './sync';
import { pullRemoteSettings } from './settings-sync';
import { maybeRunDailyExport } from './export';

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

// SQLite can corrupt under hard power-loss, especially on the cheap SSDs in
// shop-floor PCs. Run integrity_check at startup so we surface a warning the
// owner can act on (restore from latest CSV/Supabase) instead of finding out
// mid-service. Non-blocking: a failed check still lets the app boot.
function runStartupIntegrityCheck() {
  try {
    const rows = getDb().prepare('PRAGMA integrity_check').all() as Array<{
      integrity_check: string;
    }>;
    const messages = rows.map((r) => r.integrity_check);
    const ok = messages.length === 1 && messages[0] === 'ok';
    writeAudit({ action: 'integrity_check', details: { ok, messages, source: 'startup' } });
    if (!ok) {
      dialog.showMessageBox({
        type: 'warning',
        title: 'Database integrity warning',
        message:
          'The local database failed an integrity check. Continue using the app, but please restore from your latest backup at the earliest.',
        detail: messages.join('\n'),
      });
    }
  } catch (err) {
    console.error('Startup integrity check failed:', err);
  }
}

app.whenReady().then(() => {
  initDb();
  registerIpcHandlers(ipcMain);
  runStartupIntegrityCheck();
  createWindow();

  // Catch up immediately on launch in case scheduled times were missed
  // while the app was closed.
  maybeRunScheduledSync().catch((e) => console.error('Startup sync failed:', e));
  maybeRunDailyExport().catch((e) => console.error('Startup export failed:', e));
  pullRemoteSettings().catch((e) => console.error('Startup settings pull failed:', e));
  // Settings change rarely (admin tweaks a price once every few months), so
  // pulling on every 5th minute tick keeps Supabase egress comfortably inside
  // the free-tier monthly bandwidth budget while still propagating remote
  // changes within ~5 minutes.
  let tickCount = 0;
  setInterval(() => {
    tickCount += 1;
    maybeRunScheduledSync().catch((e) => console.error('Scheduled sync failed:', e));
    maybeRunDailyExport().catch((e) => console.error('Scheduled export failed:', e));
    if (tickCount % 5 === 0) {
      pullRemoteSettings().catch((e) => console.error('Settings pull failed:', e));
    }
  }, 60_000);

  // Auto-update wiring. Events broadcast to the renderer so the Tools page
  // can show live status; the native dialog on `update-downloaded` is kept
  // as a backup so a manager who isn't on Tools still sees the prompt.
  type UpdaterPhase =
    | 'idle'
    | 'checking'
    | 'available'
    | 'not-available'
    | 'downloading'
    | 'downloaded'
    | 'error';
  let updaterStatus: {
    phase: UpdaterPhase;
    version: string;
    newVersion?: string;
    progressPct?: number;
    error?: string;
    checkedAt?: string;
  } = { phase: 'idle', version: app.getVersion() };
  const pushUpdaterStatus = () => {
    mainWindow?.webContents.send('updates:event', updaterStatus);
  };

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => {
    updaterStatus = { ...updaterStatus, phase: 'checking', error: undefined };
    pushUpdaterStatus();
  });
  autoUpdater.on('update-available', (info) => {
    updaterStatus = {
      ...updaterStatus,
      phase: 'downloading',
      newVersion: info.version,
      progressPct: 0,
      error: undefined,
    };
    pushUpdaterStatus();
  });
  autoUpdater.on('update-not-available', (info) => {
    updaterStatus = {
      ...updaterStatus,
      phase: 'not-available',
      newVersion: info.version,
      error: undefined,
      checkedAt: new Date().toISOString(),
    };
    pushUpdaterStatus();
  });
  autoUpdater.on('download-progress', (p) => {
    updaterStatus = {
      ...updaterStatus,
      phase: 'downloading',
      progressPct: Math.round(p.percent),
    };
    pushUpdaterStatus();
  });
  autoUpdater.on('update-downloaded', async (info) => {
    updaterStatus = {
      ...updaterStatus,
      phase: 'downloaded',
      newVersion: info.version,
      progressPct: 100,
      error: undefined,
    };
    pushUpdaterStatus();
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
  autoUpdater.on('error', (err) => {
    console.error('Auto-update error:', err);
    updaterStatus = {
      ...updaterStatus,
      phase: 'error',
      error: err?.message ?? String(err),
    };
    pushUpdaterStatus();
  });

  ipcMain.handle('updates:status', () => updaterStatus);
  ipcMain.handle('updates:check', async () => {
    if (isDev) {
      return { ok: false, error: 'Updates only run in installed builds' };
    }
    try {
      await autoUpdater.checkForUpdates();
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  });
  ipcMain.handle('updates:install', () => {
    if (updaterStatus.phase === 'downloaded') autoUpdater.quitAndInstall();
  });

  if (!isDev) {
    // Background check on startup, then every 6 hours. Uses the GitHub
    // Releases provider declared in package.json#build.publish.
    autoUpdater.checkForUpdates().catch((e) => console.error(e));
    setInterval(
      () => autoUpdater.checkForUpdates().catch((e) => console.error(e)),
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
