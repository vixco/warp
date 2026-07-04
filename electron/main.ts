import {
  app, BrowserWindow, ipcMain, screen, desktopCapturer,
  systemPreferences, shell, clipboard, Tray, Menu, nativeImage,
} from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { NativeHelpers } from './helpers';
import { Discovery, DiscoveredHost, primaryLanIp } from './discovery';
import { HostServer, DisplayInfo, generatePairingCode } from './signaling';

const RENDERER = path.join(__dirname, '..', 'renderer');

interface Settings {
  hostName: string;
  port: number;
  pairingCode: string;      // persistent code; empty = random per session
  fps: number;
  maxBitrateMbps: number;
  codec: 'h264' | 'vp9' | 'av1';
  hidpiVirtual: boolean;
  hostingEnabled: boolean;
  launchAtLogin: boolean;
}

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

function loadSettings(): Settings {
  const defaults: Settings = {
    hostName: os.hostname().replace(/\.local$/, ''),
    port: 9750,
    pairingCode: '',
    fps: 60,
    maxBitrateMbps: 50,
    codec: 'h264',
    hidpiVirtual: false,
    hostingEnabled: false,
    launchAtLogin: true,
  };
  try {
    return { ...defaults, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) };
  } catch {
    return defaults;
  }
}

let settings = loadSettings();
function saveSettings() {
  try { fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2)); } catch { /* ignore */ }
}

const helpers = new NativeHelpers();
const discovery = new Discovery();
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
const viewerWindows = new Map<string, BrowserWindow>(); // sessionId -> window
let hostServer: HostServer | null = null;
let sessionCode = '';
const vdisplayTokens = new Map<number, number>(); // displayId -> helper token
let lastClipboardText = '';

// ---------------------------------------------------------------------------
// Displays

function getDisplays(): DisplayInfo[] {
  const primary = screen.getPrimaryDisplay();
  return screen.getAllDisplays().map((d) => ({
    id: d.id,
    label: d.label || `Display ${d.id}`,
    width: Math.round(d.size.width * d.scaleFactor),
    height: Math.round(d.size.height * d.scaleFactor),
    scaleFactor: d.scaleFactor,
    primary: d.id === primary.id,
    virtual: vdisplayTokens.has(d.id),
    vdisplayToken: vdisplayTokens.get(d.id),
  }));
}

// ---------------------------------------------------------------------------
// Hosting

async function startHosting(): Promise<{ ok: boolean; error?: string }> {
  if (hostServer?.running) return { ok: true };
  sessionCode = settings.pairingCode || generatePairingCode();

  const server = new HostServer({
    verifyCode: (code) => code === sessionCode,
    getDisplays,
    createVdisplay: async (width, height, hidpi) => {
      const res = await helpers.createVirtualDisplay(
        width, height, hidpi ?? settings.hidpiVirtual,
        `Warp Display ${vdisplayTokens.size + 1}`);
      if (res.ok && res.displayId !== undefined && res.token !== undefined) {
        vdisplayTokens.set(res.displayId, res.token);
        pushHostState();
      }
      return res;
    },
    destroyVdisplay: async (token) => {
      await helpers.destroyVirtualDisplay(token);
      for (const [dispId, tok] of vdisplayTokens) {
        if (tok === token) vdisplayTokens.delete(dispId);
      }
      pushHostState();
    },
    onEngineMessage: (sessionId, msg) => {
      if (msg.type === 'input') {
        helpers.injectInput(msg.ev);
        return;
      }
      if (msg.type === 'clipboard' && typeof msg.text === 'string') {
        lastClipboardText = msg.text;
        clipboard.writeText(msg.text);
        return;
      }
      mainWindow?.webContents.send('engine-message', { sessionId, msg });
    },
    onSessionClosed: (sessionId) => {
      helpers.injectInput({ t: 'reset' });
      mainWindow?.webContents.send('engine-message', {
        sessionId, msg: { type: 'stop-screen', sessionId },
      });
    },
    onClientsChanged: () => pushHostState(),
    hostName: () => settings.hostName,
  });

  try {
    await server.start(settings.port);
  } catch (err: any) {
    return { ok: false, error: `Port ${settings.port} unavailable: ${err.message}` };
  }

  hostServer = server;
  helpers.startHosting();
  discovery.startAnnouncing(() => ({
    hostId: machineId(),
    name: settings.hostName,
    port: settings.port,
    platform: process.platform,
    displays: screen.getAllDisplays().length,
  }));
  settings.hostingEnabled = true;
  saveSettings();
  pushHostState();
  return { ok: true };
}

async function stopHosting(persistPreference = true) {
  discovery.stopAnnouncing();
  hostServer?.stop();
  hostServer = null;
  helpers.stopHosting();
  vdisplayTokens.clear();
  if (persistPreference) {
    settings.hostingEnabled = false;
    saveSettings();
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('hosting-stopped');
  }
  pushHostState();
}

let cachedMachineId = '';
function machineId(): string {
  if (!cachedMachineId) {
    const idFile = path.join(app.getPath('userData'), 'machine-id');
    try {
      cachedMachineId = fs.readFileSync(idFile, 'utf8').trim();
    } catch {
      cachedMachineId = Math.random().toString(36).slice(2, 12);
      try { fs.writeFileSync(idFile, cachedMachineId); } catch { /* ignore */ }
    }
  }
  return cachedMachineId;
}

function hostState() {
  return {
    hosting: !!hostServer?.running,
    code: sessionCode,
    port: settings.port,
    ip: primaryLanIp(),
    clients: hostServer?.clientCount ?? 0,
    displays: getDisplays(),
    platform: process.platform,
    canHost: process.platform === 'darwin',
    permissions: permissionStatus(),
  };
}

function pushHostState() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('host-state', hostState());
  }
  hostServer?.broadcastDisplays();
  refreshTrayMenu();
}

function permissionStatus() {
  if (process.platform !== 'darwin') return { screen: 'granted', accessibility: 'granted' };
  return {
    screen: systemPreferences.getMediaAccessStatus('screen'),
    accessibility: systemPreferences.isTrustedAccessibilityClient(false) ? 'granted' : 'denied',
  };
}

// ---------------------------------------------------------------------------
// Login item + tray

function applyLoginItemSettings() {
  if (!app.isPackaged) return; // dev runs would register the Electron binary
  app.setLoginItemSettings({
    openAtLogin: settings.launchAtLogin,
    openAsHidden: true,          // macOS: start without showing the window
    args: ['--hidden'],          // Windows: same, via our own flag
  });
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) createMainWindow();
  else { mainWindow.show(); mainWindow.focus(); }
}

function trayIcon(): Electron.NativeImage {
  const name = process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png';
  const img = nativeImage.createFromPath(path.join(app.getAppPath(), 'assets', name));
  if (process.platform === 'darwin') img.setTemplateImage(true);
  return img;
}

function refreshTrayMenu() {
  if (!tray) return;
  const hosting = !!hostServer?.running;
  tray.setToolTip(hosting ? `Warp — hosting on (${sessionCode})` : 'Warp');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Warp', click: () => showMainWindow() },
    { type: 'separator' },
    ...(process.platform === 'darwin' ? [{
      label: hosting ? `Hosting on — code ${sessionCode}` : 'Hosting off',
      type: 'checkbox' as const,
      checked: hosting,
      click: () => { hosting ? stopHosting() : startHosting(); },
    }] : []),
    {
      label: 'Start at login',
      type: 'checkbox',
      checked: settings.launchAtLogin,
      click: () => {
        settings.launchAtLogin = !settings.launchAtLogin;
        saveSettings();
        applyLoginItemSettings();
        refreshTrayMenu();
      },
    },
    { type: 'separator' },
    { label: 'Quit Warp', click: () => { isQuitting = true; app.quit(); } },
  ]));
}

function createTray() {
  if (tray) return;
  tray = new Tray(trayIcon());
  refreshTrayMenu();
  tray.on('click', () => {
    if (process.platform !== 'darwin') showMainWindow();
  });
}

// ---------------------------------------------------------------------------
// Windows

function createMainWindow(show = true) {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 720,
    minWidth: 880,
    minHeight: 560,
    title: 'Warp',
    show,
    backgroundColor: '#10141c',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false, // host engine must keep encoding when hidden
    },
  });
  mainWindow.loadFile(path.join(RENDERER, 'index.html'));
  // Closing the window keeps Warp alive in the tray (Parsec-style); quit via
  // the tray menu.
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

function openViewerWindow(opts: {
  sessionId: string; host: string; port: number; code: string;
  displayId: number; screenIndex: number; targetDisplayId?: number;
  fps: number; bitrateMbps: number; codec: string; label: string;
}) {
  const target = screen.getAllDisplays().find((d) => d.id === opts.targetDisplayId)
    ?? screen.getPrimaryDisplay();

  const win = new BrowserWindow({
    x: target.bounds.x,
    y: target.bounds.y,
    width: target.bounds.width,
    height: target.bounds.height,
    fullscreen: true,
    backgroundColor: '#000000',
    title: `Warp — ${opts.label}`,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  const params = new URLSearchParams({
    sessionId: opts.sessionId,
    host: opts.host,
    port: String(opts.port),
    code: opts.code,
    displayId: String(opts.displayId),
    screenIndex: String(opts.screenIndex),
    fps: String(opts.fps),
    bitrate: String(opts.bitrateMbps),
    codec: opts.codec,
    label: opts.label,
  });
  win.loadFile(path.join(RENDERER, 'viewer.html'), { search: params.toString() });
  viewerWindows.set(opts.sessionId, win);
  win.on('closed', () => { viewerWindows.delete(opts.sessionId); });
}

// ---------------------------------------------------------------------------
// IPC

function wireIpc() {
  ipcMain.handle('get-settings', () => settings);
  ipcMain.handle('set-settings', (_e, patch: Partial<Settings>) => {
    settings = { ...settings, ...patch };
    saveSettings();
    applyLoginItemSettings();
    refreshTrayMenu();
    return settings;
  });

  ipcMain.handle('get-host-state', () => hostState());
  ipcMain.handle('start-hosting', () => startHosting());
  ipcMain.handle('stop-hosting', () => stopHosting());

  ipcMain.handle('get-discovered-hosts', () => discovery.getHosts());

  ipcMain.handle('get-local-displays', () =>
    screen.getAllDisplays().map((d, i) => ({
      id: d.id,
      index: i,
      label: d.label || `Monitor ${i + 1}`,
      bounds: d.bounds,
      primary: d.id === screen.getPrimaryDisplay().id,
      width: Math.round(d.size.width * d.scaleFactor),
      height: Math.round(d.size.height * d.scaleFactor),
    })));

  // Host engine: resolve a capture source id for a given display id
  ipcMain.handle('get-capture-source', async (_e, displayId: number) => {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 0, height: 0 },
    });
    const match = sources.find((s) => String(s.display_id) === String(displayId));
    const src = match ?? sources[0];
    if (!src) return null;
    const disp = screen.getAllDisplays().find((d) => d.id === displayId)
      ?? screen.getPrimaryDisplay();
    return {
      id: src.id,
      name: src.name,
      width: Math.round(disp.size.width * disp.scaleFactor),
      height: Math.round(disp.size.height * disp.scaleFactor),
    };
  });

  // Host engine renderer -> a connected client (rtc-offer / rtc-ice)
  ipcMain.on('to-session', (_e, { sessionId, msg }) => {
    hostServer?.sendToSession(sessionId, msg);
  });

  // Input events received on the host's WebRTC data channel
  ipcMain.on('input-event', (_e, ev) => {
    if (hostServer?.running) helpers.injectInput(ev);
  });

  // Viewer window -> open/close/fullscreen helpers
  ipcMain.handle('open-viewers', (_e, args: {
    host: string; port: number; code: string;
    screens: { displayId: number; targetDisplayId: number; label: string }[];
  }) => {
    args.screens.forEach((s, i) => {
      openViewerWindow({
        sessionId: `${machineId()}-${Date.now()}-${i}`,
        host: args.host,
        port: args.port,
        code: args.code,
        displayId: s.displayId,
        screenIndex: i,
        targetDisplayId: s.targetDisplayId,
        fps: settings.fps,
        bitrateMbps: settings.maxBitrateMbps,
        codec: settings.codec,
        label: s.label,
      });
    });
    return true;
  });

  ipcMain.on('viewer-close', (e) => {
    BrowserWindow.fromWebContents(e.sender)?.close();
  });
  ipcMain.on('viewer-close-all', () => {
    for (const win of viewerWindows.values()) win.close();
  });
  ipcMain.on('viewer-toggle-fullscreen', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (win) win.setFullScreen(!win.isFullScreen());
  });

  ipcMain.handle('open-permission-settings', (_e, which: string) => {
    if (process.platform !== 'darwin') return;
    const pane = which === 'screen'
      ? 'Privacy_ScreenCapture'
      : 'Privacy_Accessibility';
    shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${pane}`);
  });

  ipcMain.handle('request-screen-permission', async () => {
    // Triggering getSources prompts macOS to show the screen-recording dialog.
    try { await desktopCapturer.getSources({ types: ['screen'] }); } catch { /* ignore */ }
    return permissionStatus();
  });

  // Host UI "+ Virtual display" button
  ipcMain.handle('create-vdisplay-local', async (_e, width: number, height: number) => {
    const res = await helpers.createVirtualDisplay(
      width || 1920, height || 1080, settings.hidpiVirtual,
      `Warp Display ${vdisplayTokens.size + 1}`);
    if (res.ok && res.displayId !== undefined && res.token !== undefined) {
      vdisplayTokens.set(res.displayId, res.token);
      setTimeout(() => pushHostState(), 800);
    }
    return res;
  });
  ipcMain.handle('destroy-vdisplay-local', async (_e, token: number) => {
    await helpers.destroyVirtualDisplay(token);
    for (const [dispId, tok] of vdisplayTokens) {
      if (tok === token) vdisplayTokens.delete(dispId);
    }
    setTimeout(() => pushHostState(), 500);
    return { ok: true };
  });

  ipcMain.handle('get-clipboard', () => clipboard.readText());
  ipcMain.on('set-clipboard', (_e, text: string) => {
    if (typeof text === 'string' && text !== lastClipboardText) {
      lastClipboardText = text;
      clipboard.writeText(text);
    }
  });
}

// ---------------------------------------------------------------------------

app.whenReady().then(async () => {
  wireIpc();
  discovery.start();
  discovery.onHostsChanged = (hosts: DiscoveredHost[]) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('discovered-hosts', hosts);
    }
  };

  const startHidden = process.argv.includes('--hidden') ||
    app.getLoginItemSettings().wasOpenedAsHidden;
  createMainWindow(!startHidden);
  createTray();
  applyLoginItemSettings();

  screen.on('display-added', () => pushHostState());
  screen.on('display-removed', () => pushHostState());

  if (settings.hostingEnabled && process.platform === 'darwin') {
    await startHosting();
  }

  // Automated self-test: stream own primary display into a windowed viewer.
  if (process.argv.includes('--test-loopback')) {
    setTimeout(() => {
      const primary = screen.getPrimaryDisplay();
      const win = new BrowserWindow({
        width: 900, height: 560, title: 'Warp loopback test',
        backgroundColor: '#000000',
        webPreferences: {
          preload: path.join(__dirname, 'preload.js'),
          contextIsolation: true,
          nodeIntegration: false,
          backgroundThrottling: false,
        },
      });
      const params = new URLSearchParams({
        sessionId: 'loopback-test',
        host: '127.0.0.1',
        port: String(settings.port),
        code: sessionCode,
        displayId: String(primary.id),
        fps: String(settings.fps),
        bitrate: String(settings.maxBitrateMbps),
        codec: settings.codec,
        label: 'loopback',
        debug: '1',
      });
      win.loadFile(path.join(RENDERER, 'viewer.html'), { search: params.toString() });
    }, 4000);
  }

  app.on('activate', () => showMainWindow());
});

app.on('window-all-closed', () => {
  // Warp lives in the tray; quitting happens via the tray menu.
});

app.on('before-quit', () => {
  isQuitting = true;
  stopHosting(false); // keep the hosting preference for next launch
  discovery.stop();
});
