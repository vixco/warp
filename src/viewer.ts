/// <reference path="./warp.d.ts" />
// Viewer window: renders one remote display fullscreen on one local monitor,
// captures mouse/keyboard and ships it to the host over a WebRTC data channel.

const params = new URLSearchParams(location.search);
const P = {
  sessionId: params.get('sessionId') || `s-${Math.random().toString(36).slice(2)}`,
  host: params.get('host') || '127.0.0.1',
  port: Number(params.get('port')) || 9750,
  code: params.get('code') || '',
  displayId: Number(params.get('displayId')) || 0,
  fps: Number(params.get('fps')) || 60,
  bitrate: Number(params.get('bitrate')) || 20,
  codec: params.get('codec') || 'h264',
  label: params.get('label') || 'Warp',
};

const video = document.getElementById('video') as HTMLVideoElement;
const statusEl = document.getElementById('status')!;
const statusMsg = document.getElementById('statusMsg')!;
const statusSpinner = document.getElementById('statusSpinner')!;
const statusRetry = document.getElementById('statusRetry') as HTMLButtonElement;
const ovLabel = document.getElementById('ovLabel')!;
const ovStats = document.getElementById('ovStats')!;

ovLabel.textContent = P.label;
document.title = `Warp — ${P.label}`;

let ws: WebSocket | null = null;
let pc: RTCPeerConnection | null = null;
let channel: RTCDataChannel | null = null;
let sessionEnded = false;

function showStatus(msg: string, retry = false) {
  statusEl.classList.remove('hidden');
  statusMsg.textContent = msg;
  statusSpinner.style.display = retry ? 'none' : 'block';
  statusRetry.style.display = retry ? 'block' : 'none';
}

function hideStatus() {
  statusEl.classList.add('hidden');
}

function cleanup() {
  try { channel?.close(); } catch { /* ignore */ }
  try { pc?.close(); } catch { /* ignore */ }
  if (ws) { ws.onclose = null; try { ws.close(); } catch { /* ignore */ } }
  channel = null; pc = null; ws = null;
}

function connect() {
  cleanup();
  sessionEnded = false;
  showStatus(`Connecting to ${P.host}…`);

  const sock = new WebSocket(`ws://${P.host}:${P.port}`);
  ws = sock;

  sock.onopen = () => {
    sock.send(JSON.stringify({ type: 'hello', code: P.code, name: 'warp-viewer' }));
  };

  sock.onmessage = async (e) => {
    const msg = JSON.parse(e.data);
    switch (msg.type) {
      case 'welcome':
        showStatus('Starting stream…');
        sock.send(JSON.stringify({
          type: 'start-screen',
          sessionId: P.sessionId,
          displayId: P.displayId,
          fps: P.fps,
          bitrate: P.bitrate,
          codec: P.codec,
        }));
        break;

      case 'auth-failed':
        sessionEnded = true;
        showStatus('Wrong pairing code.', true);
        break;

      case 'rtc-offer':
        if (msg.sessionId !== P.sessionId) return;
        await acceptOffer(msg.sdp);
        break;

      case 'rtc-ice':
        if (msg.sessionId !== P.sessionId) return;
        try { await pc?.addIceCandidate(msg.candidate); } catch { /* ignore */ }
        break;

      case 'error':
        showStatus(`Host error: ${msg.error}`, true);
        break;
    }
  };

  sock.onclose = () => {
    if (sessionEnded) return;
    showStatus('Connection lost. Reconnecting…');
    setTimeout(() => { if (!sessionEnded) connect(); }, 2000);
  };
  sock.onerror = () => { /* onclose follows */ };
}

async function acceptOffer(sdp: string) {
  pc = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  });

  pc.ontrack = (e) => {
    // Parsec-style latency: no jitter buffering, render frames immediately.
    try {
      (e.receiver as any).jitterBufferTarget = 0;
      (e.receiver as any).playoutDelayHint = 0;
    } catch { /* best effort */ }
    video.srcObject = e.streams[0] || new MediaStream([e.track]);
    video.play().catch(() => { /* autoplay is allowed (muted) */ });
    hideStatus();
  };

  pc.ondatachannel = (e) => {
    channel = e.channel;
    channel.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data));
        if (msg.t === 'clip') window.warp.setClipboard(msg.s);
      } catch { /* ignore */ }
    };
  };

  pc.onicecandidate = (e) => {
    if (e.candidate && ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'rtc-ice', sessionId: P.sessionId, candidate: e.candidate.toJSON(),
      }));
    }
  };

  pc.onconnectionstatechange = () => {
    if (!pc) return;
    if (pc.connectionState === 'connected') hideStatus();
    if (['failed', 'disconnected'].includes(pc.connectionState) && !sessionEnded) {
      showStatus('Stream interrupted. Reconnecting…');
      setTimeout(() => { if (!sessionEnded) connect(); }, 1500);
    }
  };

  await pc.setRemoteDescription({ type: 'offer', sdp });
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  ws?.send(JSON.stringify({ type: 'rtc-answer', sessionId: P.sessionId, sdp: answer.sdp }));
}

statusRetry.addEventListener('click', () => connect());

// ---------------------------------------------------------------------------
// Input capture

function sendInput(ev: object) {
  if (channel?.readyState === 'open') channel.send(JSON.stringify(ev));
}

// Map a client-window point to normalized coords on the remote display,
// accounting for object-fit: contain letterboxing.
function normalizedPos(clientX: number, clientY: number): { x: number; y: number } | null {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return null;
  const ew = video.clientWidth, eh = video.clientHeight;
  const scale = Math.min(ew / vw, eh / vh);
  const dw = vw * scale, dh = vh * scale;
  const ox = (ew - dw) / 2, oy = (eh - dh) / 2;
  const x = (clientX - ox) / dw;
  const y = (clientY - oy) / dh;
  return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
}

let lastMove = 0;
window.addEventListener('pointermove', (e) => {
  const now = performance.now();
  if (now - lastMove < 4) return; // ~250 Hz cap
  lastMove = now;
  const pos = normalizedPos(e.clientX, e.clientY);
  if (pos) sendInput({ t: 'mm', d: P.displayId, x: pos.x, y: pos.y });
});

window.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  const pos = normalizedPos(e.clientX, e.clientY);
  if (pos) sendInput({ t: 'mm', d: P.displayId, x: pos.x, y: pos.y });
  sendInput({ t: 'md', b: e.button === 1 ? 1 : e.button === 2 ? 2 : 0 });
});

window.addEventListener('pointerup', (e) => {
  e.preventDefault();
  sendInput({ t: 'mu', b: e.button === 1 ? 1 : e.button === 2 ? 2 : 0 });
});

window.addEventListener('wheel', (e) => {
  e.preventDefault();
  sendInput({ t: 'sc', dx: Math.round(e.deltaX), dy: Math.round(e.deltaY) });
}, { passive: false });

window.addEventListener('contextmenu', (e) => e.preventDefault());

const LOCAL_HOTKEYS = new Set(['KeyQ', 'KeyF']);

window.addEventListener('keydown', (e) => {
  // Local hotkeys: Ctrl+Shift+Q disconnect, Ctrl+Shift+F fullscreen
  if (e.ctrlKey && e.shiftKey && LOCAL_HOTKEYS.has(e.code)) {
    e.preventDefault();
    if (e.code === 'KeyQ') disconnect();
    if (e.code === 'KeyF') window.warp.viewerToggleFullscreen();
    return;
  }
  e.preventDefault();
  sendInput({ t: 'kd', code: e.code, r: e.repeat ? 1 : 0 });
});

window.addEventListener('keyup', (e) => {
  e.preventDefault();
  sendInput({ t: 'ku', code: e.code });
});

// Release all keys/buttons on host when this window loses focus.
window.addEventListener('blur', () => sendInput({ t: 'reset' }));

// Capture OS-level keys (Alt+Tab, etc.) where the platform allows it.
async function lockKeyboard() {
  try { await navigator.keyboard?.lock(); } catch { /* unsupported */ }
}
lockKeyboard();
document.addEventListener('fullscreenchange', lockKeyboard);

// ---------------------------------------------------------------------------
// Clipboard: client -> host

let lastClip = '';
setInterval(async () => {
  if (channel?.readyState !== 'open') return;
  try {
    const text = await window.warp.getClipboard();
    if (text && text !== lastClip) {
      lastClip = text;
      channel.send(JSON.stringify({ t: 'clip', s: text }));
    }
  } catch { /* ignore */ }
}, 2000);

// ---------------------------------------------------------------------------
// Overlay: stats + controls

document.getElementById('ovDisconnect')!.addEventListener('click', disconnect);
document.getElementById('ovFullscreen')!.addEventListener('click', () =>
  window.warp.viewerToggleFullscreen());

function disconnect() {
  sessionEnded = true;
  cleanup();
  window.warp.viewerClose();
}

let lastBytes = 0, lastFrames = 0, lastTs = 0;
setInterval(async () => {
  if (!pc || pc.connectionState !== 'connected') { ovStats.textContent = '—'; return; }
  try {
    const stats = await pc.getStats();
    let fps = 0, kbps = 0, rttMs = -1, w = 0, h = 0;
    stats.forEach((s: any) => {
      if (s.type === 'inbound-rtp' && s.kind === 'video') {
        const now = s.timestamp;
        if (lastTs) {
          const dt = (now - lastTs) / 1000;
          if (dt > 0) {
            fps = Math.round((s.framesDecoded - lastFrames) / dt);
            kbps = Math.round(((s.bytesReceived - lastBytes) * 8) / dt / 1000);
          }
        }
        lastTs = now; lastFrames = s.framesDecoded; lastBytes = s.bytesReceived;
        w = s.frameWidth; h = s.frameHeight;
      }
      if (s.type === 'candidate-pair' && s.state === 'succeeded' &&
          s.currentRoundTripTime !== undefined) {
        rttMs = Math.round(s.currentRoundTripTime * 1000);
      }
    });
    ovStats.textContent =
      `${w}×${h} · ${fps} fps · ${(kbps / 1000).toFixed(1)} Mbps` +
      (rttMs >= 0 ? ` · ${rttMs} ms` : '');
    if (params.has('debug')) {
      console.log(`warp-stats ${JSON.stringify({ w, h, fps, kbps, rttMs })}`);
    }
  } catch { /* ignore */ }
}, 1000);

// Show the local cursor only near the top hotzone (the remote cursor is in
// the video); hide it elsewhere.
window.addEventListener('pointermove', (e) => {
  document.body.classList.toggle('show-cursor', e.clientY < 60);
});

connect();
