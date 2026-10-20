// Electron main process — wraps the Vite build in a desktop window.
//
// Development: loads the Vite dev server (npm run electron:dev).
// Production:  loads dist/index.html from inside the packaged app.

import { app, BrowserWindow, ipcMain, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The offline copy of the Sheet and the changes waiting to upload, one file per
// key under the user's app-data folder (electron/preload.cjs).
function storeFile(key) {
  const safe = String(key).replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(app.getPath('userData'), 'offline-data', `${safe}.json`);
}

ipcMain.on('store:get', (event, key) => {
  try {
    event.returnValue = fs.readFileSync(storeFile(key), 'utf8');
  } catch {
    event.returnValue = null;
  }
});

ipcMain.on('store:set', (event, key, value) => {
  try {
    const file = storeFile(key);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Write beside it, then swap in: a crash mid-write leaves the old copy whole.
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, value, 'utf8');
    fs.renameSync(tmp, file);
    event.returnValue = true;
  } catch (err) {
    event.returnValue = `Could not save to this computer: ${err.message}`;
  }
});

ipcMain.on('store:remove', (event, key) => {
  try { fs.rmSync(storeFile(key), { force: true }); } catch { /* already gone */ }
  event.returnValue = true;
});
// Its own port, so electron:dev never opens another project that happens to be
// running on Vite's default 5173. Matches the electron:dev script.
const DEV_URL = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5199';
const isDev = !app.isPackaged;

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#B91F19',
    autoHideMenuBar: true,
    show: false,
    // The packaged .exe already carries build/icon.ico; this covers dev runs.
    ...(isDev ? { icon: path.join(__dirname, '..', 'build', 'icon.png') } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  win.once('ready-to-show', () => win.show());

  // Printing opens a blank popup and writes the bill into it
  // (src/lib/exporters.js), so those stay inside the app. Any real web link —
  // WhatsApp, a shared ledger URL — goes to the user's normal browser instead
  // of a bare Electron window with no address bar.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url || url === 'about:blank') {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          autoHideMenuBar: true,
          webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
        },
      };
    }
    if (/^https?:|^mailto:|^tel:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // Never let the main window navigate away from the dashboard itself.
  win.webContents.on('will-navigate', (event, url) => {
    const own = isDev ? url.startsWith(DEV_URL) : url.startsWith('file:');
    if (!own) {
      event.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });

  if (isDev) {
    win.loadURL(DEV_URL);
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

// One copy of the app at a time: a second launch focuses the existing window,
// so two windows cannot race each other writing to the same Sheet.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
