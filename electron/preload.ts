import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('warp', {
  // settings
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setSettings: (patch: any) => ipcRenderer.invoke('set-settings', patch),

  // hosting
  getHostState: () => ipcRenderer.invoke('get-host-state'),
  startHosting: () => ipcRenderer.invoke('start-hosting'),
  stopHosting: () => ipcRenderer.invoke('stop-hosting'),
  onHostState: (fn: (s: any) => void) =>
    ipcRenderer.on('host-state', (_e, s) => fn(s)),
  onHostingStopped: (fn: () => void) =>
    ipcRenderer.on('hosting-stopped', () => fn()),
  onUpdateReady: (fn: (version: string) => void) =>
    ipcRenderer.on('update-ready', (_e, v) => fn(v)),
  onUpdateInstallFailed: (fn: () => void) =>
    ipcRenderer.on('update-install-failed', () => fn()),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  installUpdate: () => ipcRenderer.invoke('install-update'),

  // host engine plumbing
  onEngineMessage: (fn: (data: { sessionId: string; msg: any }) => void) =>
    ipcRenderer.on('engine-message', (_e, data) => fn(data)),
  toSession: (sessionId: string, msg: any) =>
    ipcRenderer.send('to-session', { sessionId, msg }),
  getCaptureSource: (displayId: number) =>
    ipcRenderer.invoke('get-capture-source', displayId),
  queueCaptureDisplay: (displayId: number) =>
    ipcRenderer.send('set-pending-capture-display', displayId),
  injectInput: (ev: any) => ipcRenderer.send('input-event', ev),

  // discovery / client
  getDiscoveredHosts: () => ipcRenderer.invoke('get-discovered-hosts'),
  onDiscoveredHosts: (fn: (hosts: any[]) => void) =>
    ipcRenderer.on('discovered-hosts', (_e, hosts) => fn(hosts)),
  getLocalDisplays: () => ipcRenderer.invoke('get-local-displays'),
  openViewers: (args: any) => ipcRenderer.invoke('open-viewers', args),

  // viewer window controls
  viewerClose: () => ipcRenderer.send('viewer-close'),
  viewerCloseAll: () => ipcRenderer.send('viewer-close-all'),
  viewerToggleFullscreen: () => ipcRenderer.send('viewer-toggle-fullscreen'),

  // permissions
  openPermissionSettings: (which: string) =>
    ipcRenderer.invoke('open-permission-settings', which),
  requestScreenPermission: () => ipcRenderer.invoke('request-screen-permission'),

  // virtual displays (host UI)
  createVdisplay: (width: number, height: number) =>
    ipcRenderer.invoke('create-vdisplay-local', width, height),
  destroyVdisplay: (token: number) =>
    ipcRenderer.invoke('destroy-vdisplay-local', token),

  // clipboard sync
  getClipboard: () => ipcRenderer.invoke('get-clipboard'),
  setClipboard: (text: string) => ipcRenderer.send('set-clipboard', text),
});
