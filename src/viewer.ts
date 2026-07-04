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
  bitrate: Number(params.get('bitrate')) || 150,
  codec: params.get('codec') || 'h264',
  mode: params.get('mode') || 'sharp',
  label: params.get('label') || 'Warp',
  screenIndex: Number(params.get('screenIndex')) || 0,
};
// Audio passthrough rides on the first screen only (one audio path, not three)
const WANT_AUDIO = P.screenIndex === 0;

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
  micStream?.getTracks().forEach((t) => t.stop());
  micStream = null;
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
          mode: P.mode,
          wantAudio: WANT_AUDIO,
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
    if (e.track.kind === 'audio') {
      audioEl.srcObject = e.streams[0] || new MediaStream([e.track]);
      applySink();
      audioEl.play().catch(() => { /* resumes on first interaction */ });
      return;
    }
    video.srcObject = new MediaStream([e.track]);
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

  // Attach the microphone (if enabled) to the audio transceiver before
  // answering, so mic + system audio negotiate in one round trip.
  if (WANT_AUDIO) await attachMic();

  const answer = await pc.createAnswer();
  answer.sdp = mungeOpus(answer.sdp || '');
  await pc.setLocalDescription(answer);
  ws?.send(JSON.stringify({ type: 'rtc-answer', sessionId: P.sessionId, sdp: answer.sdp }));
}

// Prefer stereo, high-bitrate, FEC-protected Opus for the audio we receive.
function mungeOpus(sdp: string): string {
  return sdp.replace(/a=fmtp:(\d+) minptime=10;useinbandfec=1/g,
    'a=fmtp:$1 minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1;maxaveragebitrate=256000');
}

statusRetry.addEventListener('click', () => connect());

// ---------------------------------------------------------------------------
// Audio: host system audio -> chosen speakers; chosen microphone -> host

const audioEl = new Audio();
audioEl.autoplay = true;

let micStream: MediaStream | null = null;

function savedSink(): string { return localStorage.getItem('audio:sink') || 'default'; }
function savedMic(): string { return localStorage.getItem('audio:mic') || 'off'; }

function applySink() {
  const sink = savedSink();
  if (sink !== 'default') {
    (audioEl as any).setSinkId?.(sink).catch(() => { /* device gone: default */ });
  } else {
    (audioEl as any).setSinkId?.('').catch(() => { /* ignore */ });
  }
}

function audioTransceiver(): RTCRtpTransceiver | undefined {
  return pc?.getTransceivers().find((t) =>
    t.receiver.track?.kind === 'audio' || t.sender.track?.kind === 'audio');
}

async function attachMic() {
  const micId = savedMic();
  const tr = audioTransceiver();
  if (!tr) return;
  micStream?.getTracks().forEach((t) => t.stop());
  micStream = null;
  if (micId === 'off') {
    await tr.sender.replaceTrack(null).catch(() => { /* ignore */ });
    return;
  }
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: micId === 'default' ? undefined : { exact: micId },
        echoCancellation: true,   // avoid feeding host audio back to the host
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    tr.direction = 'sendrecv';
    await tr.sender.replaceTrack(micStream.getAudioTracks()[0]);
  } catch (err) {
    console.warn('microphone unavailable', err);
  }
}

async function populateAudioDevices() {
  const spk = document.getElementById('menuSpeakers') as HTMLSelectElement;
  const mic = document.getElementById('menuMic') as HTMLSelectElement;
  if (!spk || !mic) return;
  try {
    // A brief mic open makes device labels available on first run.
    if (!localStorage.getItem('audio:labels')) {
      try {
        const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
        probe.getTracks().forEach((t) => t.stop());
        localStorage.setItem('audio:labels', '1');
      } catch { /* no mic permission — generic labels */ }
    }
    const devices = await navigator.mediaDevices.enumerateDevices();
    spk.innerHTML = '';
    spk.add(new Option('System default', 'default'));
    devices.filter((d) => d.kind === 'audiooutput' && d.deviceId !== 'default')
      .forEach((d, i) => spk.add(new Option(d.label || `Speakers ${i + 1}`, d.deviceId)));
    spk.value = savedSink();
    if (!spk.value) spk.value = 'default';

    mic.innerHTML = '';
    mic.add(new Option('Off', 'off'));
    mic.add(new Option('System default', 'default'));
    devices.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default')
      .forEach((d, i) => mic.add(new Option(d.label || `Microphone ${i + 1}`, d.deviceId)));
    mic.value = savedMic();
    if (!mic.value) mic.value = 'off';
  } catch { /* leave menus empty */ }
}

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

let menuOpen = false;

let lastMove = 0;
window.addEventListener('pointermove', (e) => {
  if (menuOpen) return;
  const now = performance.now();
  if (now - lastMove < 4) return; // ~250 Hz cap
  lastMove = now;
  const pos = normalizedPos(e.clientX, e.clientY);
  if (pos) sendInput({ t: 'mm', d: P.displayId, x: pos.x, y: pos.y });
});

window.addEventListener('pointerdown', (e) => {
  if (menuOpen) return;
  if ((e.target as HTMLElement).closest('.overlay, .hotzone')) return;
  e.preventDefault();
  const pos = normalizedPos(e.clientX, e.clientY);
  if (pos) sendInput({ t: 'mm', d: P.displayId, x: pos.x, y: pos.y });
  sendInput({ t: 'md', b: e.button === 1 ? 1 : e.button === 2 ? 2 : 0 });
});

window.addEventListener('pointerup', (e) => {
  if (menuOpen) return;
  if ((e.target as HTMLElement).closest('.overlay, .hotzone')) return;
  e.preventDefault();
  sendInput({ t: 'mu', b: e.button === 1 ? 1 : e.button === 2 ? 2 : 0 });
});

window.addEventListener('wheel', (e) => {
  if (menuOpen) return;
  e.preventDefault();
  sendInput({ t: 'sc', dx: Math.round(e.deltaX), dy: Math.round(e.deltaY) });
}, { passive: false });

window.addEventListener('contextmenu', (e) => e.preventDefault());

const LOCAL_HOTKEYS = new Set(['KeyQ', 'KeyF', 'KeyM']);

window.addEventListener('keydown', (e) => {
  // Local hotkeys (Ctrl+Shift or Win/Cmd+Shift): Q disconnect, F fullscreen,
  // M in-stream menu — Parsec-style.
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && LOCAL_HOTKEYS.has(e.code)) {
    e.preventDefault();
    if (e.code === 'KeyQ') disconnect();
    if (e.code === 'KeyF') window.warp.viewerToggleFullscreen();
    if (e.code === 'KeyM') toggleMenu();
    return;
  }
  if (menuOpen) {
    if (e.code === 'Escape') { e.preventDefault(); toggleMenu(false); }
    return; // don't forward keys while the menu is open
  }
  e.preventDefault();
  sendInput({ t: 'kd', code: e.code, r: e.repeat ? 1 : 0 });
});

window.addEventListener('keyup', (e) => {
  if (menuOpen) return;
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
  // Disconnecting one screen ends the whole session: every viewer closes.
  sessionEnded = true;
  cleanup();
  window.warp.viewerCloseAll();
}

// ---------------------------------------------------------------------------
// In-stream menu (Ctrl+Shift+M / Win+Shift+M)

const menuEl = document.getElementById('menu')!;
const menuBitrate = document.getElementById('menuBitrate') as HTMLSelectElement;
const menuFps = document.getElementById('menuFps') as HTMLSelectElement;
const menuMode = document.getElementById('menuMode') as HTMLSelectElement;
document.getElementById('menuLabel')!.textContent = P.label;

menuBitrate.value = [25, 50, 100, 150, 300, 400, 600].includes(P.bitrate) ? String(P.bitrate) : '150';
menuFps.value = P.fps === 30 ? '30' : '60';
menuMode.value = P.mode === 'smooth' ? 'smooth' : 'sharp';

function toggleMenu(open = !menuOpen) {
  menuOpen = open;
  menuEl.classList.toggle('hidden', !menuOpen);
  document.body.classList.toggle('show-cursor', menuOpen);
  if (menuOpen) {
    sendInput({ t: 'reset' }); // release held keys/buttons
    populateAudioDevices();
  }
}

// Audio device rows only exist on the screen that carries audio.
if (!WANT_AUDIO) {
  document.getElementById('rowSpeakers')!.style.display = 'none';
  document.getElementById('rowMic')!.style.display = 'none';
}

document.getElementById('menuSpeakers')!.addEventListener('change', (e) => {
  localStorage.setItem('audio:sink', (e.target as HTMLSelectElement).value);
  applySink();
});
document.getElementById('menuMic')!.addEventListener('change', async (e) => {
  localStorage.setItem('audio:mic', (e.target as HTMLSelectElement).value);
  await attachMic();
});

function sendCfg() {
  sendInput({
    t: 'cfg',
    bitrate: Number(menuBitrate.value),
    fps: Number(menuFps.value),
    mode: menuMode.value,
  });
}
menuBitrate.addEventListener('change', sendCfg);
menuFps.addEventListener('change', sendCfg);
menuMode.addEventListener('change', sendCfg);

document.getElementById('menuFullscreen')!.addEventListener('click', () =>
  window.warp.viewerToggleFullscreen());
document.getElementById('menuResume')!.addEventListener('click', () => toggleMenu(false));
document.getElementById('menuDisconnect')!.addEventListener('click', disconnect);

let lastBytes = 0, lastFrames = 0, lastTs = 0;
setInterval(async () => {
  if (!pc || pc.connectionState !== 'connected') { ovStats.textContent = '—'; return; }
  try {
    const stats = await pc.getStats();
    let fps = 0, kbps = 0, rttMs = -1, w = 0, h = 0, audioBytes = 0;
    stats.forEach((s: any) => {
      if (s.type === 'inbound-rtp' && s.kind === 'audio') {
        audioBytes = s.bytesReceived || 0;
      }
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
    const statsText =
      `${w}×${h} · ${fps} fps · ${(kbps / 1000).toFixed(1)} Mbps` +
      (rttMs >= 0 ? ` · ${rttMs} ms` : '');
    ovStats.textContent = statsText;
    document.getElementById('menuStats')!.textContent = statsText;
    if (params.has('debug')) {
      console.log(`warp-stats ${JSON.stringify({ w, h, fps, kbps, rttMs, audioBytes })}`);
    }
  } catch { /* ignore */ }
}, 1000);

// Show the local cursor only near the top hotzone (the remote cursor is in
// the video); hide it elsewhere.
window.addEventListener('pointermove', (e) => {
  if (menuOpen) return; // cursor stays visible while the menu is open
  document.body.classList.toggle('show-cursor', e.clientY < 60);
});

connect();
