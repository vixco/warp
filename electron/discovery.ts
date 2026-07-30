// LAN discovery: hosts broadcast presence over UDP; clients listen and build
// a live list of available computers (Parsec-style computer list, no cloud).

import * as dgram from 'dgram';
import * as os from 'os';
import { execFileSync } from 'child_process';

export const DISCOVERY_PORT = 9751;
const ANNOUNCE_INTERVAL = 2000;
const HOST_TTL = 6000;

export interface DiscoveredHost {
  hostId: string;
  name: string;
  ip: string;
  port: number;
  platform: string;
  displays: number;
  mac: string;      // first wake address, retained for older clients
  macs: string[];   // all plausible physical/current interface addresses
  lastSeen: number;
}

export class Discovery {
  private socket: dgram.Socket | null = null;
  private announceTimer: NodeJS.Timeout | null = null;
  private pruneTimer: NodeJS.Timeout | null = null;
  private hosts = new Map<string, DiscoveredHost>();
  private announcePayload: (() => object) | null = null;

  onHostsChanged: ((hosts: DiscoveredHost[]) => void) | null = null;

  start() {
    if (this.socket) return;
    this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.socket.on('error', (err) => console.error('discovery socket error', err));
    this.socket.on('message', (buf, rinfo) => {
      try {
        const msg = JSON.parse(buf.toString('utf8'));
        if (msg.warp !== 1 || msg.type !== 'announce') return;
        const host: DiscoveredHost = {
          hostId: String(msg.hostId),
          name: String(msg.name || 'Unknown'),
          ip: rinfo.address,
          port: Number(msg.port) || 9750,
          platform: String(msg.platform || '?'),
          displays: Number(msg.displays) || 1,
          mac: String(msg.mac || ''),
          macs: normalizeMacList(Array.isArray(msg.macs) ? msg.macs : [msg.mac]),
          lastSeen: Date.now(),
        };
        const prev = this.hosts.get(host.hostId);
        this.hosts.set(host.hostId, host);
        if (!prev || prev.ip !== host.ip || prev.name !== host.name ||
            prev.displays !== host.displays || prev.mac !== host.mac ||
            prev.macs.join(',') !== host.macs.join(',')) {
          this.emitHosts();
        }
      } catch { /* not ours */ }
    });
    this.socket.bind(DISCOVERY_PORT, () => {
      try { this.socket!.setBroadcast(true); } catch { /* ignore */ }
    });
    this.pruneTimer = setInterval(() => {
      const now = Date.now();
      let changed = false;
      for (const [id, h] of this.hosts) {
        if (now - h.lastSeen > HOST_TTL) { this.hosts.delete(id); changed = true; }
      }
      if (changed) this.emitHosts();
    }, 2000);
  }

  startAnnouncing(payload: () => object) {
    this.announcePayload = payload;
    if (this.announceTimer) return;
    this.announceTimer = setInterval(() => this.announce(), ANNOUNCE_INTERVAL);
    this.announce();
  }

  stopAnnouncing() {
    if (this.announceTimer) { clearInterval(this.announceTimer); this.announceTimer = null; }
    this.announcePayload = null;
  }

  private announce() {
    if (!this.socket || !this.announcePayload) return;
    const data = Buffer.from(JSON.stringify({ warp: 1, type: 'announce', ...this.announcePayload() }));
    for (const addr of broadcastAddresses()) {
      this.socket.send(data, DISCOVERY_PORT, addr, () => { /* best effort */ });
    }
  }

  private emitHosts() {
    if (this.onHostsChanged) this.onHostsChanged([...this.hosts.values()]);
  }

  getHosts(): DiscoveredHost[] { return [...this.hosts.values()]; }

  stop() {
    this.stopAnnouncing();
    if (this.pruneTimer) { clearInterval(this.pruneTimer); this.pruneTimer = null; }
    if (this.socket) { this.socket.close(); this.socket = null; }
  }
}

export function broadcastAddresses(): string[] {
  const out = new Set<string>(['255.255.255.255']);
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces || []) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      const ip = iface.address.split('.').map(Number);
      const mask = iface.netmask.split('.').map(Number);
      const bcast = ip.map((oct, i) => (oct & mask[i]) | (~mask[i] & 255)).join('.');
      out.add(bcast);
    }
  }
  return [...out];
}

export function primaryLanIp(): string {
  for (const [, ifaces] of rankedNetworkInterfaces()) {
    for (const iface of ifaces) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

// MAC of the primary LAN interface, so clients can remember it and wake this
// host later even after it has gone to sleep (and stopped announcing).
function rankedNetworkInterfaces() {
  return Object.entries(os.networkInterfaces())
    .map(([name, entries]) => [name, entries || []] as const)
    .sort(([a], [b]) => interfaceRank(a) - interfaceRank(b) || a.localeCompare(b));
}

function interfaceRank(name: string): number {
  if (name === 'en0') return 0;
  if (/^en\d+$/.test(name)) return 1;
  if (/^(eth|ethernet)\d*$/i.test(name)) return 2;
  if (/^(bridge|anpi|awdl|llw|utun|vmnet|vbox|docker|tailscale)/i.test(name)) return 20;
  return 10;
}

export function normalizeMac(value: unknown): string | null {
  const hex = String(value || '').replace(/[^0-9a-fA-F]/g, '').toLowerCase();
  if (hex.length !== 12 || hex === '000000000000') return null;
  return hex.match(/.{2}/g)!.join(':');
}

export function normalizeMacList(values: unknown[]): string[] {
  const unique = new Set<string>();
  for (const value of values) {
    const mac = normalizeMac(value);
    if (mac) unique.add(mac);
  }
  return [...unique];
}

export function parseHardwarePortMacs(output: string): string[] {
  const matches = [...String(output).matchAll(/Ethernet Address:\s*([0-9a-f:]{17})/gi)];
  return normalizeMacList(matches.map((match) => match[1]));
}

let cachedHardwareMacs: string[] | null = null;
function hardwareMacAddresses(): string[] {
  if (process.platform !== 'darwin') return [];
  if (cachedHardwareMacs) return cachedHardwareMacs;
  try {
    const output = execFileSync('/usr/sbin/networksetup', ['-listallhardwareports'], {
      encoding: 'utf8',
      timeout: 1500,
      maxBuffer: 256 * 1024,
    });
    cachedHardwareMacs = parseHardwarePortMacs(output);
  } catch {
    cachedHardwareMacs = [];
  }
  return cachedHardwareMacs;
}

// Advertise both the currently-associated MAC (important when Private Wi-Fi
// Address is enabled) and the hardware MACs. Different Mac/network combinations
// listen for one or the other while asleep, so sending to all is more reliable.
export function wakeMacAddresses(): string[] {
  const current: string[] = [];
  for (const [, ifaces] of rankedNetworkInterfaces()) {
    for (const iface of ifaces) {
      if (iface.family === 'IPv4' && !iface.internal) {
        current.push(iface.mac);
      }
    }
  }
  return normalizeMacList([...current, ...hardwareMacAddresses()]);
}

export function buildMagicPacket(mac: string): Buffer | null {
  const normalized = normalizeMac(mac);
  if (!normalized) return null;
  const hex = normalized.replace(/:/g, '');
  const macBytes = Buffer.from(hex, 'hex');
  const packet = Buffer.alloc(6 + 16 * 6, 0xff);
  for (let i = 0; i < 16; i++) macBytes.copy(packet, 6 + i * 6);
  return packet;
}

export interface WakeResult {
  ok: boolean;
  packets: number;
  error?: string;
}

function wait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

// Broadcast a short burst on both standard WoL ports. This resolves after the
// kernel accepted (or rejected) every send; it does not claim that the sleeping
// machine woke, which can still be blocked by macOS power/network settings.
export async function sendWakeOnLan(macs: string[]): Promise<WakeResult> {
  const packets = normalizeMacList(macs)
    .map(buildMagicPacket)
    .filter((packet): packet is Buffer => !!packet);
  if (!packets.length) return { ok: false, packets: 0, error: 'No valid MAC address saved' };

  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      socket.once('error', onError);
      socket.bind(0, () => {
        socket.off('error', onError);
        resolve();
      });
    });
    socket.setBroadcast(true);
    socket.on('error', () => { /* individual send callbacks report failures */ });

    let sent = 0;
    const targets = broadcastAddresses();
    for (let burst = 0; burst < 3; burst++) {
      if (burst) await wait(burst === 1 ? 200 : 500);
      const sends: Promise<void>[] = [];
      for (const packet of packets) {
        for (const address of targets) {
          for (const port of [9, 7]) {
            sends.push(new Promise((resolve) => {
              socket.send(packet, port, address, (error) => {
                if (!error) sent++;
                resolve();
              });
            }));
          }
        }
      }
      await Promise.all(sends);
    }
    return sent > 0
      ? { ok: true, packets: sent }
      : { ok: false, packets: 0, error: 'UDP broadcast failed' };
  } catch (error) {
    return {
      ok: false,
      packets: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    try { socket.close(); } catch { /* ignore */ }
  }
}
