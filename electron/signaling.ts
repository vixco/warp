// Host-side WebSocket server: pairing, display listing, virtual display
// management and WebRTC signaling relay between clients and the host engine
// (which runs in the host renderer process).

import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import * as crypto from 'crypto';

// --- Pairing brute-force guard ---------------------------------------------
// A wrong pairing code counts as a failed attempt for the connecting address.
// After MAX_AUTH_FAILS failures that address is locked out for a window that
// doubles with each further failure (capped), so the 6-digit code space can't
// be swept over the network. Trusted clients (known clientId) authenticate on
// the first try and never trip this.
const MAX_AUTH_FAILS = 5;
const LOCKOUT_BASE_MS = 30_000;
const LOCKOUT_MAX_MS = 15 * 60_000;

export interface DisplayInfo {
  id: number;            // CGDirectDisplayID / Electron display id
  label: string;
  width: number;
  height: number;
  scaleFactor: number;
  refreshRate?: number;  // native panel refresh rate in Hz
  primary: boolean;
  virtual: boolean;
  vdisplayToken?: number;
}

export interface HostServerCallbacks {
  // Returns true if the connection should be accepted. A client is accepted
  // either because its persistent clientId is in the host's trusted list
  // (already paired before) or because it presented the correct pairing code
  // (first-time pairing — the host may then remember the clientId).
  verifyClient(code: string, clientId: string): boolean;
  getDisplays(): DisplayInfo[];
  createVdisplay(width: number, height: number, hidpi: boolean, hz?: number):
    Promise<{ ok: boolean; token?: number; displayId?: number; error?: string }>;
  destroyVdisplay(token: number): Promise<void>;
  // Messages that must reach the host engine renderer (start/stop/rtc)
  onEngineMessage(sessionId: string, msg: any): void;
  onSessionClosed(sessionId: string): void;
  onClientsChanged(count: number): void;
  hostName(): string;
}

interface ClientConn {
  ws: WebSocket;
  name: string;
  authed: boolean;
  sessions: Set<string>;
}

export class HostServer {
  private wss: WebSocketServer | null = null;
  private clients = new Set<ClientConn>();
  private sessionOwner = new Map<string, ClientConn>();
  private cb: HostServerCallbacks;
  private authFails = new Map<string, { count: number; lockedUntil: number }>();
  port = 9750;

  constructor(cb: HostServerCallbacks) { this.cb = cb; }

  get running(): boolean { return !!this.wss; }
  get clientCount(): number {
    return [...this.clients].filter((c) => c.authed).length;
  }

  start(port: number): Promise<void> {
    this.port = port;
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({ port, host: '0.0.0.0' });
      wss.on('listening', () => { this.wss = wss; resolve(); });
      wss.on('error', (err) => { if (!this.wss) reject(err); else console.error('wss error', err); });
      wss.on('connection', (ws, req) => this.onConnection(ws, req));
    });
  }

  stop() {
    if (!this.wss) return;
    for (const c of this.clients) { try { c.ws.close(); } catch { /* ignore */ } }
    this.clients.clear();
    this.sessionOwner.clear();
    this.wss.close();
    this.wss = null;
  }

  private send(ws: WebSocket, msg: any) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  private isLockedOut(ip: string): boolean {
    const rec = this.authFails.get(ip);
    return !!rec && rec.lockedUntil > Date.now();
  }

  private recordAuthFail(ip: string) {
    // Opportunistically drop stale entries so a churn of addresses can't grow
    // the map without bound.
    if (this.authFails.size > 256) {
      const now = Date.now();
      for (const [k, v] of this.authFails) {
        if (v.lockedUntil < now && v.count < MAX_AUTH_FAILS) this.authFails.delete(k);
      }
    }
    const rec = this.authFails.get(ip) ?? { count: 0, lockedUntil: 0 };
    rec.count++;
    if (rec.count >= MAX_AUTH_FAILS) {
      const over = rec.count - MAX_AUTH_FAILS;
      rec.lockedUntil = Date.now() + Math.min(LOCKOUT_BASE_MS * 2 ** over, LOCKOUT_MAX_MS);
    }
    this.authFails.set(ip, rec);
  }

  private clearAuthFails(ip: string) {
    this.authFails.delete(ip);
  }

  private onConnection(ws: WebSocket, req: IncomingMessage) {
    const ip = req.socket.remoteAddress || 'unknown';
    const conn: ClientConn = { ws, name: '?', authed: false, sessions: new Set() };
    this.clients.add(conn);

    // Refuse addresses that are currently locked out for too many bad codes,
    // before any code is even examined.
    if (this.isLockedOut(ip)) {
      this.send(ws, { type: 'auth-failed', reason: 'locked' });
      this.clients.delete(conn);
      ws.close();
      return;
    }

    const authTimeout = setTimeout(() => { if (!conn.authed) ws.close(); }, 10000);

    ws.on('message', async (raw) => {
      let msg: any;
      try { msg = JSON.parse(String(raw)); } catch { return; }

      if (!conn.authed) {
        if (msg.type === 'hello') {
          if (this.cb.verifyClient(String(msg.code ?? ''), String(msg.clientId ?? ''))) {
            conn.authed = true;
            conn.name = String(msg.name || 'client').slice(0, 64);
            this.clearAuthFails(ip);
            clearTimeout(authTimeout);
            this.send(ws, {
              type: 'welcome',
              hostName: this.cb.hostName(),
              displays: this.cb.getDisplays(),
            });
            this.cb.onClientsChanged(this.clientCount);
          } else {
            this.recordAuthFail(ip);
            this.send(ws, { type: 'auth-failed' });
            ws.close();
          }
        }
        return;
      }

      switch (msg.type) {
        case 'get-displays':
          this.send(ws, { type: 'displays', displays: this.cb.getDisplays() });
          break;

        case 'create-vdisplay': {
          const res = await this.cb.createVdisplay(
            Number(msg.width) || 1920, Number(msg.height) || 1080, !!msg.hidpi,
            Number(msg.hz) || 60);
          this.send(ws, { type: 'vdisplay-result', reqId: msg.reqId, ...res });
          // Give macOS a moment to register the new display, then broadcast.
          setTimeout(() => this.broadcastDisplays(), 800);
          break;
        }

        case 'destroy-vdisplay':
          await this.cb.destroyVdisplay(Number(msg.token));
          setTimeout(() => this.broadcastDisplays(), 500);
          break;

        case 'start-screen':
        case 'stop-screen':
        case 'rtc-answer':
        case 'rtc-ice':
        case 'input':
        case 'clipboard': {
          const sessionId = String(msg.sessionId || '');
          if (!sessionId) return;
          if (msg.type === 'start-screen') {
            conn.sessions.add(sessionId);
            this.sessionOwner.set(sessionId, conn);
          }
          if (this.sessionOwner.get(sessionId) === conn) {
            this.cb.onEngineMessage(sessionId, msg);
          }
          break;
        }
      }
    });

    ws.on('close', () => {
      clearTimeout(authTimeout);
      this.clients.delete(conn);
      for (const sessionId of conn.sessions) {
        this.sessionOwner.delete(sessionId);
        this.cb.onSessionClosed(sessionId);
      }
      this.cb.onClientsChanged(this.clientCount);
    });
    ws.on('error', () => { /* handled by close */ });
  }

  // Host engine -> the client owning this session
  sendToSession(sessionId: string, msg: any) {
    const conn = this.sessionOwner.get(sessionId);
    if (conn && conn.ws.readyState === WebSocket.OPEN) {
      this.send(conn.ws, { ...msg, sessionId });
    }
  }

  broadcastDisplays() {
    const payload = JSON.stringify({ type: 'displays', displays: this.cb.getDisplays() });
    for (const c of this.clients) {
      if (c.authed && c.ws.readyState === WebSocket.OPEN) c.ws.send(payload);
    }
  }

  broadcast(msg: any) {
    const payload = JSON.stringify(msg);
    for (const c of this.clients) {
      if (c.authed && c.ws.readyState === WebSocket.OPEN) c.ws.send(payload);
    }
  }
}

export function generatePairingCode(): string {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

// Constant-time comparison of the pairing code, so a wrong guess can't be
// refined character-by-character from how long the check takes.
export function safeEqualCode(a: string, b: string): boolean {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) {
    // Still run a fixed comparison so timing doesn't reveal the length.
    crypto.timingSafeEqual(ab, ab);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}
