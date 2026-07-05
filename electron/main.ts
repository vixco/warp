import {
  app, BrowserWindow, ipcMain, screen, desktopCapturer,
  systemPreferences, shell, clipboard, Tray, Menu, nativeImage, session, powerMonitor,
} from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { autoUpdater } from 'electron-updater';
import { NativeHelpers } from './helpers';
import { Discovery, DiscoveredHost, primaryLanIp } from './discovery';
import { HostServer, DisplayInfo, generatePairingCode } from './signaling';

const RENDERER = path.join(__dirname, '..', 'renderer');

// Per-screen capture uses getDisplayMedia (for OS-cursor suppression), and
// the host starts streaming in response to a client connecting over the
// network — there is no user gesture in the host window at that moment.
// Without this flag Chromium rejects gesture-less getDisplayMedia calls
// before the displayMediaRequestHandler ever runs, breaking streaming.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// Force WebRTC video onto the GPU hardware encoder (VideoToolbox on macOS).
// By default Chromium keeps HW encoding behind a conservative GPU blocklist and
// on many Macs silently falls back to the SOFTWARE H.264 encoder (OpenH264) —
// which, at HiDPI resolutions across multiple monitors, both wrecks quality
// (heavy quantization → the "heeeel laag" picture) and pegs the CPU so hard
// that later streams can't keep up. Ignoring the blocklist is the single
// biggest quality/throughput win for multi-monitor streaming; zero-copy keeps
// captured frames on the GPU so they reach the encoder without a CPU round-trip.
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-zero-copy');

interface Settings {
  hostName: string;
  port: number;
  pairingCode: string;      // persistent code; empty = random per session
  trustedClients: string[]; // clientIds that paired before and skip the code
  fps: number;
  maxBitrateMbps: number;
  codec: 'h264' | 'vp9' | 'av1';
  hidpiVirtual: boolean;
  hostingEnabled: boolean;
  launchAtLogin: boolean;
  streamMode: 'sharp' | 'smooth';
  audioEnabled: boolean;
  audioSource: string;   // 'auto' = system loopback, else input deviceId
  micSink: string;       // where client mic plays on the host ('default' or deviceId)
}

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

function loadSettings(): Settings {
  const defaults: Settings = {
    hostName: os.hostname().replace(/\.local$/, ''),
    port: 9750,
    pairingCode: '',
    trustedClients: [],
    fps: 60,
    maxBitrateMbps: 200,   // VBR ceiling — idle stays near-zero, motion gets full quality
    codec: 'h264',
    hidpiVirtual: false,
    hostingEnabled: false,
    launchAtLogin: true,
    streamMode: 'sharp',
    audioEnabled: true,
    audioSource: 'auto',
    micSink: 'default',
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
let updateReadyVersion: string | null = null;
let pendingInstall = false; // set while we're attempting quitAndInstall()
const RELEASES_URL = 'https://github.com/vixco/warp/releases/latest';
const viewerWindows = new Map<string, BrowserWindow>(); // sessionId -> window
let hostServer: HostServer | null = null;
let sessionCode = '';
const vdisplayTokens = new Map<number, number>(); // displayId -> helper token
let lastClipboardText = '';
// Display the next video-only getDisplayMedia call should capture. Set by the
// host engine right before it calls getDisplayMedia; consumed by the
// displayMediaRequestHandler. The renderer serializes captures, so a single
// slot is race-free.
let pendingCaptureDisplayId: number | null = null;

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
    refreshRate: Math.round((d as any).displayFrequency) || 60,
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
    verifyClient: (code, clientId) => {
      // Already-paired clients skip the code (they're trusted by deviceId).
      if (clientId && settings.trustedClients.includes(clientId)) return true;
      // First-time pairing: accept the correct code, then remember this
      // client so it never has to enter the code again.
      if (code && code === sessionCode) {
        if (clientId && !settings.trustedClients.includes(clientId)) {
          settings.trustedClients.push(clientId);
          saveSettings();
        }
        return true;
      }
      return false;
    },
    getDisplays,
    createVdisplay: async (width, height, hidpi, hz) => {
      const res = await helpers.createVirtualDisplay(
        width, height, hidpi ?? settings.hidpiVirtual,
        `Warp Display ${vdisplayTokens.size + 1}`, hz ?? 60);
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
    onClientsChanged: (count) => {
      pushHostState();
      // When the last client leaves, tear down the virtual displays it
      // created (after a short grace period for reconnects).
      if (count === 0 && vdisplayTokens.size > 0) {
        setTimeout(async () => {
          if (hostServer?.clientCount === 0) {
            for (const [dispId, token] of [...vdisplayTokens]) {
              await helpers.destroyVirtualDisplay(token);
              vdisplayTokens.delete(dispId);
            }
            pushHostState();
          }
        }, 5000);
      }
    },
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
// Auto-update: every push to GitHub triggers CI that publishes a new release;
// running apps pick it up here, download in the background, and install on
// restart (or via the tray's "Restart to update").

function setupAutoUpdater() {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-downloaded', (info) => {
    updateReadyVersion = info.version;
    refreshTrayMenu();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-ready', info.version);
    }
  });
  autoUpdater.on('error', (err) => {
    // Unsigned macOS builds can't auto-install; log and carry on.
    console.error('auto-update:', err?.message || err);
    if (pendingInstall) triggerInstallFallback();
  });

  const check = () => autoUpdater.checkForUpdates().catch(() => { /* offline */ });
  setTimeout(check, 15_000);            // shortly after launch
  setInterval(check, 15 * 60 * 1000);   // then every 15 minutes
}

async function checkForUpdatesNow(): Promise<{
  ok: boolean; currentVersion: string; latestVersion?: string;
  updateAvailable?: boolean; downloaded?: boolean; error?: string;
}> {
  const currentVersion = app.getVersion();
  if (!app.isPackaged) {
    return { ok: false, currentVersion, error: 'Updates only work in the installed app' };
  }
  if (updateReadyVersion) {
    return {
      ok: true, currentVersion, latestVersion: updateReadyVersion,
      updateAvailable: true, downloaded: true,
    };
  }
  try {
    const result = await autoUpdater.checkForUpdates();
    const latestVersion = result?.updateInfo?.version;
    const updateAvailable = (result as any)?.isUpdateAvailable
      ?? (!!latestVersion && latestVersion !== currentVersion);
    return { ok: true, currentVersion, latestVersion, updateAvailable };
  } catch (err: any) {
    return { ok: false, currentVersion, error: err?.message || String(err) };
  }
}

// On an unsigned macOS build, quitAndInstall() logs an error and silently
// no-ops (Squirrel.Mac won't replace the app with an unsigned bundle). Detect
// that — we're still alive shortly after the call — and fall back to opening
// the releases page so the user can install manually instead of staring at a
// button that does nothing.
function triggerInstallFallback() {
  if (!pendingInstall) return;
  pendingInstall = false;
  isQuitting = false; // we're not actually quitting; undo the flag
  shell.openExternal(RELEASES_URL).catch(() => { /* offline */ });
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update-install-failed');
  }
}

function installUpdateNow() {
  if (!updateReadyVersion) return;
  pendingInstall = true;
  isQuitting = true;
  autoUpdater.quitAndInstall();
  // If quitAndInstall silently no-ops (unsigned macOS), we'll still be alive
  // here — fall back to the manual-download path.
  setTimeout(() => { if (pendingInstall) triggerInstallFallback(); }, 2500);
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
  const powerLine = process.platform === 'darwin' && hosting
    ? [{ label: powerMonitor.onBatteryPower
        ? 'On battery — will sleep if lid closed'
        : 'On AC power — lid-close safe',
        enabled: false }]
    : [];
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Warp', click: () => showMainWindow() },
    { type: 'separator' },
    ...(process.platform === 'darwin' ? [{
      label: hosting ? `Hosting on — code ${sessionCode}` : 'Hosting off',
      type: 'checkbox' as const,
      checked: hosting,
      click: () => { hosting ? stopHosting() : startHosting(); },
    }] : []),
    ...powerLine,
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
    { label: 'Check for updates', click: () => { checkForUpdatesNow(); } },
    ...(updateReadyVersion ? [
      { type: 'separator' as const },
      {
        label: `Restart to update (v${updateReadyVersion})`,
        click: () => { installUpdateNow(); },
      },
    ] : []),
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
    autoHideMenuBar: true,
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

let closingAllViewers = false;
function closeAllViewers() {
  if (closingAllViewers) return;
  closingAllViewers = true;
  for (const win of [...viewerWindows.values()]) {
    if (!win.isDestroyed()) win.close();
  }
  viewerWindows.clear();
  closingAllViewers = false;
}

function openViewerWindow(opts: {
  sessionId: string; host: string; port: number; code: string; clientId: string;
  displayId: number; screenIndex: number; targetDisplayId?: number;
  fps: number; bitrateMbps: number; codec: string; mode: string; label: string;
}) {
  const target = screen.getAllDisplays().find((d) => d.id === opts.targetDisplayId)
    ?? screen.getPrimaryDisplay();

  const win = new BrowserWindow({
    x: target.bounds.x,
    y: target.bounds.y,
    width: target.bounds.width,
    height: target.bounds.height,
    fullscreen: true,
    autoHideMenuBar: true,
    backgroundColor: '#000000',
    title: `Warp — ${opts.label}`,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  win.removeMenu();
  const params = new URLSearchParams({
    sessionId: opts.sessionId,
    host: opts.host,
    port: String(opts.port),
    code: opts.code,
    clientId: opts.clientId,
    displayId: String(opts.displayId),
    screenIndex: String(opts.screenIndex),
    fps: String(opts.fps),
    bitrate: String(opts.bitrateMbps),
    codec: opts.codec,
    mode: opts.mode,
    label: opts.label,
  });
  win.loadFile(path.join(RENDERER, 'viewer.html'), { search: params.toString() });
  viewerWindows.set(opts.sessionId, win);
  // One screen closing ends the session for all screens (Parsec-style).
  win.on('closed', () => {
    viewerWindows.delete(opts.sessionId);
    closeAllViewers();
  });
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
      // The monitor's native refresh rate, so the client can offer (and
      // default to) the frame rates the panel can actually display —
      // 60 / 120 / 144 / 165 / 240 Hz, per monitor. Falls back to 60 when
      // the platform doesn't report it.
      refreshRate: Math.round((d as any).displayFrequency) || 60,
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
    host: string; port: number; code: string; clientId: string;
    screens: { displayId: number; targetDisplayId: number; label: string; fps?: number }[];
  }) => {
    args.screens.forEach((s, i) => {
      openViewerWindow({
        sessionId: `${machineId()}-${Date.now()}-${i}`,
        host: args.host,
        port: args.port,
        code: args.code,
        clientId: args.clientId,
        displayId: s.displayId,
        screenIndex: i,
        targetDisplayId: s.targetDisplayId,
        // Per-monitor frame rate chosen in the mapping dialog; falls back to
        // the global default when a screen didn't specify one.
        fps: s.fps || settings.fps,
        bitrateMbps: settings.maxBitrateMbps,
        codec: settings.codec,
        mode: settings.streamMode,
        label: s.label,
      });
    });
    return true;
  });

  ipcMain.on('viewer-close', (e) => {
    BrowserWindow.fromWebContents(e.sender)?.close();
  });
  ipcMain.on('viewer-close-all', () => closeAllViewers());
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
  ipcMain.handle('create-vdisplay-local', async (_e, width: number, height: number, hz?: number) => {
    const res = await helpers.createVirtualDisplay(
      width || 1920, height || 1080, settings.hidpiVirtual,
      `Warp Display ${vdisplayTokens.size + 1}`, hz || 60);
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

  ipcMain.handle('check-for-updates', () => checkForUpdatesNow());
  ipcMain.handle('get-app-version', () => app.getVersion());
  ipcMain.handle('install-update', () => { installUpdateNow(); });

  ipcMain.handle('get-clipboard', () => clipboard.readText());
  // Renderer tells us which display the next video-only getDisplayMedia call
  // should capture (Parsec-style per-screen streaming, cursor suppressed).
  ipcMain.on('set-pending-capture-display', (_e, displayId: number) => {
    pendingCaptureDisplayId = displayId;
  });
  ipcMain.on('set-clipboard', (_e, text: string) => {
    if (typeof text === 'string' && text !== lastClipboardText) {
      lastClipboardText = text;
      clipboard.writeText(text);
    }
  });
}

// ---------------------------------------------------------------------------

app.whenReady().then(async () => {
  // No File/Edit/View menu bar on Windows/Linux (Parsec-style chrome-less UI).
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null);

  // Single displayMedia handler serves two callers, told apart by whether
  // audio was requested:
  //  • Per-screen video capture (host streaming): video only, cursor
  //    suppressed (Parsec-style — the client renders its own zero-lag
  //    cursor). The renderer queues the target displayId over IPC before
  //    the getDisplayMedia call so we can pick the right screen with no
  //    system picker. Captures are serialized in the renderer, so a single
  //    pending slot is race-free.
  //  • Loopback system audio (legacy path): capture a small window + system
  //    audio. Never a display — that would conflict with the per-screen
  //    captures. Only the loopback audio track is used.
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    if (!request.audioRequested) {
      const want = pendingCaptureDisplayId;
      pendingCaptureDisplayId = null;
      try {
        const sources = await desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: { width: 0, height: 0 },
        });
        let src = sources[0];
        if (want != null) {
          src = sources.find((s) => String(s.display_id) === String(want)) || sources[0];
        }
        if (!src) { try { callback({} as any); } catch { /* ignore */ } return; }
        callback({ video: src });
      } catch {
        try { callback({} as any); } catch { /* ignore */ }
      }
      return;
    }
    try {
      const windows = await desktopCapturer.getSources({
        types: ['window'],
        thumbnailSize: { width: 0, height: 0 },
      });
      const own = windows.find((w) => w.name.startsWith('Warp')) ?? windows[0];
      if (own) {
        callback({ video: own, audio: 'loopback' });
        return;
      }
      const screens = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 0, height: 0 },
      });
      callback({ video: screens[0], audio: 'loopback' });
    } catch {
      try { callback({} as any); } catch { /* ignore */ }
    }
  });

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
  setupAutoUpdater();

  screen.on('display-added', () => pushHostState());
  screen.on('display-removed', () => pushHostState());

  // Re-arm the keep-awake assertion after the system wakes or switches to AC,
  // and refresh the tray so the power-state line stays accurate. This is what
  // makes lid-close streaming survive: even if macOS tore down caffeinate's
  // assertion on sleep, it gets re-asserted the instant we resume.
  if (process.platform === 'darwin') {
    powerMonitor.on('resume', () => { helpers.ensureAwake(); refreshTrayMenu(); });
    powerMonitor.on('on-ac', () => { helpers.ensureAwake(); refreshTrayMenu(); });
    powerMonitor.on('on-battery', () => refreshTrayMenu());
    powerMonitor.on('suspend', () => refreshTrayMenu());
  }

  if (settings.hostingEnabled && process.platform === 'darwin') {
    await startHosting();
  }

  // Automated self-test: stream own primary display into a windowed viewer.
  if (process.argv.includes('--test-loopback')) {
    // Animated window so the damage-driven encoder has something to encode.
    const anim = new BrowserWindow({ width: 220, height: 160, x: 40, y: 80, alwaysOnTop: true });
    anim.loadURL('data:text/html,<style>div{width:60px;height:60px;background:%234f7cff;' +
      'animation:m 0.8s linear infinite alternate}@keyframes m{to{transform:translate(120px,60px)}}' +
      '</style><div></div>');
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
  pendingInstall = false; // quit is really happening — cancel the fallback timer
  stopHosting(false); // keep the hosting preference for next launch
  discovery.stop();
});
