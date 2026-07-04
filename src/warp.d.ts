export interface WarpApi {
  getSettings(): Promise<any>;
  setSettings(patch: any): Promise<any>;
  getHostState(): Promise<any>;
  startHosting(): Promise<{ ok: boolean; error?: string }>;
  stopHosting(): Promise<void>;
  onHostState(fn: (s: any) => void): void;
  onHostingStopped(fn: () => void): void;
  onEngineMessage(fn: (data: { sessionId: string; msg: any }) => void): void;
  toSession(sessionId: string, msg: any): void;
  getCaptureSource(displayId: number): Promise<{ id: string; name: string } | null>;
  injectInput(ev: any): void;
  getDiscoveredHosts(): Promise<any[]>;
  onDiscoveredHosts(fn: (hosts: any[]) => void): void;
  getLocalDisplays(): Promise<any[]>;
  openViewers(args: any): Promise<boolean>;
  viewerClose(): void;
  viewerCloseAll(): void;
  viewerToggleFullscreen(): void;
  openPermissionSettings(which: string): Promise<void>;
  requestScreenPermission(): Promise<any>;
  createVdisplay(width: number, height: number): Promise<any>;
  destroyVdisplay(token: number): Promise<any>;
  getClipboard(): Promise<string>;
  setClipboard(text: string): void;
}

declare global {
  interface Window { warp: WarpApi; }
  interface Navigator { keyboard?: { lock(keys?: string[]): Promise<void>; unlock(): void } }
}

export {};
