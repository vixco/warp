// Manages the native macOS helper processes (input injection + virtual displays).

import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { app } from 'electron';
import { macKeycodeFor } from './keymap';

function helperPath(name: string): string {
  const candidates = [
    path.join(process.resourcesPath || '', 'native', name),
    path.join(app.getAppPath(), 'native', 'bin', name),
    path.join(__dirname, '..', '..', 'native', 'bin', name),
  ];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch { /* ignore */ }
  }
  return candidates[1];
}

class LineProcess {
  proc: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private nextId = 1;
  private pending = new Map<number, (msg: any) => void>();
  onEvent: ((msg: any) => void) | null = null;

  constructor(private binName: string) {}

  get running(): boolean { return !!this.proc && this.proc.exitCode === null; }

  start(): boolean {
    if (this.running) return true;
    if (process.platform !== 'darwin') return false;
    const bin = helperPath(this.binName);
    if (!fs.existsSync(bin)) {
      console.error(`helper missing: ${bin}`);
      return false;
    }
    this.proc = spawn(bin, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      let idx;
      while ((idx = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 1);
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id && this.pending.has(msg.id)) {
            const cb = this.pending.get(msg.id)!;
            this.pending.delete(msg.id);
            cb(msg);
          } else if (this.onEvent) {
            this.onEvent(msg);
          }
        } catch { /* ignore malformed */ }
      }
    });
    this.proc.stderr.on('data', (d) => console.error(`[${this.binName}]`, String(d).trim()));
    this.proc.on('exit', () => { this.proc = null; this.pending.clear(); });
    return true;
  }

  stop() {
    if (this.proc) { this.proc.kill(); this.proc = null; }
  }

  write(obj: unknown) {
    if (!this.running) this.start();
    if (this.running) this.proc!.stdin.write(JSON.stringify(obj) + '\n');
  }

  request(obj: Record<string, unknown>, timeoutMs = 5000): Promise<any> {
    if (!this.running && !this.start()) {
      return Promise.resolve({ ok: false, error: 'helper unavailable' });
    }
    const id = this.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: 'helper timeout' });
      }, timeoutMs);
      this.pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      this.write({ ...obj, id });
    });
  }
}

export class NativeHelpers {
  private input = new LineProcess('warp-input');
  private vdisplay = new LineProcess('warp-vdisplay');
  private caffeinate: ReturnType<typeof spawn> | null = null;
  private hosting = false;
  // Backoff so a broken caffeinate binary can't spin a respawn loop. Reset to 0
  // whenever a process lives longer than 30s, so repeated healthy lid-close
  // cycles never exhaust the budget.
  private caffeinateRestarts = 0;
  private caffeinateTimer: ReturnType<typeof setTimeout> | null = null;
  private caffeinateSpawnedAt = 0;

  startHosting() {
    if (process.platform !== 'darwin') return;
    this.hosting = true;
    this.input.start();
    this.ensureAwake();
  }

  // (Re)assert the keep-awake power assertion. Called on host start and again
  // after power events (resume, switch to AC) so a lid-close that slipped past
  // caffeinate, or a caffeinate that died in its sleep, gets re-armed. The -s
  // flag prevents system sleep on AC power — the only reliable no-sudo way to
  // keep a MacBook running with the lid closed (clamshell). -d keeps the
  // (virtual) display alive so capture keeps producing frames.
  ensureAwake() {
    if (process.platform !== 'darwin' || !this.hosting) return;
    if (this.caffeinate) return; // already armed
    if (this.caffeinateRestarts >= 5) return; // give up after repeated fast crashes
    this.caffeinateSpawnedAt = Date.now();
    this.caffeinate = spawn('caffeinate', ['-dimsu'], { stdio: 'ignore' });
    this.caffeinate.on('exit', () => {
      const livedMs = Date.now() - this.caffeinateSpawnedAt;
      this.caffeinate = null;
      if (!this.hosting) return;
      // A process that stayed alive a while was healthy — reset the budget so
      // many lid-close/wake cycles over a long session never exhaust it.
      if (livedMs > 30_000) this.caffeinateRestarts = 0;
      // Respawn after a short, capped backoff — macOS sometimes kills the
      // assertion on lid-close; we want it back the moment we wake.
      this.caffeinateRestarts++;
      const delay = Math.min(2000 * this.caffeinateRestarts, 15000);
      this.caffeinateTimer = setTimeout(() => this.ensureAwake(), delay);
    });
  }

  stopHosting() {
    this.hosting = false;
    this.input.write({ t: 'reset' });
    this.input.stop();
    this.vdisplay.stop(); // tears down all virtual displays
    if (this.caffeinateTimer) { clearTimeout(this.caffeinateTimer); this.caffeinateTimer = null; }
    if (this.caffeinate) { this.caffeinate.kill(); this.caffeinate = null; }
    this.caffeinateRestarts = 0;
  }

  // Input events arrive from the client data channel in a compact form.
  injectInput(ev: any) {
    switch (ev.t) {
      case 'mm': case 'md': case 'mu': case 'sc': case 'txt': case 'reset':
        this.input.write(ev);
        break;
      case 'kd': case 'ku': {
        const k = macKeycodeFor(ev.code);
        if (k !== undefined) this.input.write({ t: ev.t, k, r: ev.r ? 1 : 0 });
        break;
      }
    }
  }

  async createVirtualDisplay(width: number, height: number, hidpi: boolean, name: string):
      Promise<{ ok: boolean; token?: number; displayId?: number; error?: string }> {
    if (process.platform !== 'darwin') return { ok: false, error: 'macOS only' };
    return this.vdisplay.request({ cmd: 'create', width, height, hz: 60, hidpi: hidpi ? 1 : 0, name });
  }

  async destroyVirtualDisplay(token: number): Promise<{ ok: boolean }> {
    return this.vdisplay.request({ cmd: 'destroy', token });
  }

  async listVirtualDisplays(): Promise<{ token: number; displayId: number }[]> {
    if (!this.vdisplay.running) return [];
    const res = await this.vdisplay.request({ cmd: 'list' });
    return res.ok ? res.displays : [];
  }
}
