export interface WarpApi {
  getSettings(): Promise<any>;
  setSettings(patch: any): Promise<any>;
  getHostState(): Promise<any>;
  startHosting(): Promise<{ ok: boolean; error?: string }>;
  stopHosting(): Promise<void>;
  onHostState(fn: (s: any) => void): void;
  onHostingStopped(fn: () => void): void;
  onUpdateReady(fn: (version: string) => void): void;
  onUpdateInstallFailed(fn: () => void): void;
  checkForUpdates(): Promise<{
    ok: boolean; currentVersion: string; latestVersion?: string;
    updateAvailable?: boolean; downloaded?: boolean; error?: string;
  }>;
  getAppVersion(): Promise<string>;
  installUpdate(): Promise<void>;
  onEngineMessage(fn: (data: { sessionId: string; msg: any }) => void): void;
  hostEngineReady(): void;
  toSession(sessionId: string, msg: any): void;
  getCaptureSource(displayId: number): Promise<{ id: string; name: string; width: number; height: number; scaleFactor: number } | null>;
  queueCaptureDisplay(displayId: number): void;
  injectInput(ev: any): void;
  onCursorUpdate(fn: (m: any) => void): void;
  requestCursorSnapshot(): void;
  getDiscoveredHosts(): Promise<any[]>;
  onDiscoveredHosts(fn: (hosts: any[]) => void): void;
  wakeHost(mac: string): Promise<boolean>;
  getLocalDisplays(): Promise<any[]>;
  openViewers(args: any): Promise<boolean>;
  viewerClose(): void;
  viewerCloseAll(): void;
  viewerToggleFullscreen(): void;
  viewerApplyAll(cfg: any): void;
  onApplyCfg(fn: (cfg: any) => void): void;
  openPermissionSettings(which: string): Promise<void>;
  requestScreenPermission(): Promise<any>;
  createVdisplay(width: number, height: number, hz?: number): Promise<any>;
  destroyVdisplay(token: number): Promise<any>;
  getClipboard(): Promise<string>;
  setClipboard(text: string): void;
  getClipboardImage(): Promise<string | null>;
  setClipboardImage(dataUrl: string): void;
  saveIncomingFile(name: string, dataUrl: string): Promise<{ ok: boolean; path?: string; error?: string }>;
}

declare global {
  interface Window { warp: WarpApi; }
  interface Navigator { keyboard?: { lock(keys?: string[]): Promise<void>; unlock(): void } }
}

export {};
