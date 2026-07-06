// LAN discovery: hosts broadcast presence over UDP; clients listen and build
// a live list of available computers (Parsec-style computer list, no cloud).

import * as dgram from 'dgram';
import * as os from 'os';

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
  mac: string;      // primary LAN MAC, so a client can Wake-on-LAN it later
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
          lastSeen: Date.now(),
        };
        const prev = this.hosts.get(host.hostId);
        this.hosts.set(host.hostId, host);
        if (!prev || prev.ip !== host.ip || prev.name !== host.name ||
            prev.displays !== host.displays || prev.mac !== host.mac) {
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

function broadcastAddresses(): string[] {
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
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces || []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

// MAC of the primary LAN interface, so clients can remember it and wake this
// host later even after it has gone to sleep (and stopped announcing).
export function primaryMac(): string {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces || []) {
      if (iface.family === 'IPv4' && !iface.internal &&
          iface.mac && iface.mac !== '00:00:00:00:00:00') return iface.mac;
    }
  }
  return '';
}

// Send a Wake-on-LAN "magic packet" (6×0xFF + 16×MAC) as a UDP broadcast on the
// usual WoL ports. The target is asleep and has no ARP entry, so it must be a
// broadcast, not a unicast to its last IP.
export function sendWakeOnLan(mac: string): boolean {
  const hex = (mac || '').replace(/[^0-9a-fA-F]/g, '');
  if (hex.length !== 12) return false;
  const macBytes = Buffer.from(hex, 'hex');
  const packet = Buffer.alloc(6 + 16 * 6, 0xff);
  for (let i = 0; i < 16; i++) macBytes.copy(packet, 6 + i * 6);
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  sock.on('error', () => { try { sock.close(); } catch { /* ignore */ } });
  sock.bind(() => {
    try { sock.setBroadcast(true); } catch { /* ignore */ }
    for (const addr of broadcastAddresses()) {
      sock.send(packet, 9, addr, () => { /* best effort */ });
      sock.send(packet, 7, addr, () => { /* best effort */ });
    }
    setTimeout(() => { try { sock.close(); } catch { /* ignore */ } }, 600);
  });
  return true;
}
