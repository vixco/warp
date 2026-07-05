/// <reference path="./warp.d.ts" />
// Viewer window: renders one remote display fullscreen on one local monitor,
// captures mouse/keyboard and ships it to the host over a WebRTC data channel.

const params = new URLSearchParams(location.search);
const P = {
  sessionId: params.get('sessionId') || `s-${Math.random().toString(36).slice(2)}`,
  host: params.get('host') || '127.0.0.1',
  port: Number(params.get('port')) || 9750,
  code: params.get('code') || '',
  clientId: params.get('clientId') || '',
  displayId: Number(params.get('displayId')) || 0,
  fps: Number(params.get('fps')) || 60,
  bitrate: Number(params.get('bitrate')) || 150,
  codec: params.get('codec') || 'h264',
  mode: params.get('mode') || 'sharp',
  // Cap the encoded height on the host (0 = native). Default 1440 = "Auto":
  // high-DPI/4K/5K hosts stop encoding native pixels (the main latency win),
  // while 1080p/1440p hosts are left untouched. Tunable live from the menu.
  maxHeight: params.get('maxHeight') != null ? Number(params.get('maxHeight')) : 1440,
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
const overlay = document.getElementById('overlay')!;

ovLabel.textContent = P.label;
document.title = `Warp — ${P.label}`;

let ws: WebSocket | null = null;
let pc: RTCPeerConnection | null = null;
let channel: RTCDataChannel | null = null;       // reliable: keys, clicks, clipboard
let fastChannel: RTCDataChannel | null = null;   // unreliable: continuous mouse move
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
  try { fastChannel?.close(); } catch { /* ignore */ }
  try { pc?.close(); } catch { /* ignore */ }
  if (ws) { ws.onclose = null; try { ws.close(); } catch { /* ignore */ } }
  channel = null; fastChannel = null; pc = null; ws = null;
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
    sock.send(JSON.stringify({ type: 'hello', code: P.code, clientId: P.clientId, name: 'warp-viewer' }));
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
          maxHeight: P.maxHeight,
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
    // The host opens two channels; hold a reference to the unreliable one so
    // high-rate pointer moves can be sent on it (client→host only).
    if (e.channel.label === 'warp-fast') {
      fastChannel = e.channel;
      return;
    }
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
    if (pc.connectionState === 'connected') {
      hideStatus();
      // Re-assert zero playout delay on every receiver once negotiated — some
      // Chromium versions reset the hint after the track is wired up, which
      // silently re-introduces a jitter buffer (the "constant small delay").
      pc.getReceivers().forEach((r) => {
        try {
          (r as any).jitterBufferTarget = 0;
          (r as any).playoutDelayHint = 0;
        } catch { /* best effort */ }
      });
    }
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
  answer.sdp = tuneAnswerVideo(mungeOpus(answer.sdp || ''), P.bitrate);
  await pc.setLocalDescription(answer);
  ws?.send(JSON.stringify({ type: 'rtc-answer', sessionId: P.sessionId, sdp: answer.sdp }));
}

// Prefer stereo, high-bitrate, FEC-protected Opus for the audio we receive.
function mungeOpus(sdp: string): string {
  return sdp.replace(/a=fmtp:(\d+) minptime=10;useinbandfec=1/g,
    'a=fmtp:$1 minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1;maxaveragebitrate=256000');
}

// Advertise a high receive bandwidth on the video m-line of our answer. Without
// this the receiver's bandwidth estimate can cap the sender well below the
// requested bitrate, capping quality regardless of what the host offers.
function tuneAnswerVideo(sdp: string, maxMbps: number): string {
  const maxKbps = Math.max(1000, Math.round(maxMbps * 1000));
  const lines = sdp.split(/\r?\n/);
  const out: string[] = [];
  let inVideo = false;
  for (const l of lines) {
    if (l.startsWith('m=')) inVideo = l.startsWith('m=video');
    out.push(l);
    if (inVideo && l.startsWith('c=')) {
      out.push(`b=AS:${maxKbps}`);
      out.push(`b=TIAS:${maxKbps * 1000}`);
    }
  }
  return out.join('\r\n');
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

// Reliable/ordered path: keystrokes, clicks, clipboard — anything where a drop
// or reorder would corrupt state (a lost keyup leaves a stuck key).
function sendInput(ev: object) {
  if (channel?.readyState === 'open') channel.send(JSON.stringify(ev));
}

// Unreliable/unordered path for high-rate pointer moves: the newest position
// supersedes any dropped one, so movement never head-of-line-blocks behind a
// video retransmit. Falls back to the reliable channel if the fast one isn't
// open yet.
function sendFast(ev: object) {
  const ch = fastChannel?.readyState === 'open' ? fastChannel : channel;
  if (ch?.readyState === 'open') ch.send(JSON.stringify(ev));
}

// Map a client-window point to normalized coords on the remote display,
// accounting for object-fit: contain letterboxing.
function normalizedPos(clientX: number, clientY: number, clamp = true): { x: number; y: number } | null {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return null;
  const ew = video.clientWidth, eh = video.clientHeight;
  const scale = Math.min(ew / vw, eh / vh);
  const dw = vw * scale, dh = vh * scale;
  const ox = (ew - dw) / 2, oy = (eh - dh) / 2;
  const x = (clientX - ox) / dw;
  const y = (clientY - oy) / dh;
  if (clamp) {
    return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
  }
  return { x, y };
}

let menuOpen = false;

let lastMove = 0;
window.addEventListener('pointermove', (e) => {
  if (menuOpen) return;
  const now = performance.now();
  if (now - lastMove < 4) return; // ~250 Hz cap
  lastMove = now;
  // If dragging (buttons > 0), don't clamp so we can cross monitor borders
  const pos = normalizedPos(e.clientX, e.clientY, e.buttons === 0);
  if (pos) sendFast({ t: 'mm', d: P.displayId, x: pos.x, y: pos.y });
});

window.addEventListener('pointerdown', (e) => {
  if (menuOpen) return;
  if ((e.target as HTMLElement).closest('.overlay, .hotzone')) return;
  e.preventDefault();
  // Sync the host position before the button event so the click lands exactly
  // where the pointer is.
  const pos = normalizedPos(e.clientX, e.clientY, true);
  if (pos) sendInput({ t: 'mm', d: P.displayId, x: pos.x, y: pos.y });
  sendInput({ t: 'md', b: e.button === 1 ? 1 : e.button === 2 ? 2 : 0 });
});

window.addEventListener('pointerup', (e) => {
  if (menuOpen) return;
  if ((e.target as HTMLElement).closest('.overlay, .hotzone')) return;
  e.preventDefault();
  // Reliably sync the final position before the release so a drag ends exactly
  // where the pointer is, even if the last unreliable move was dropped.
  const pos = normalizedPos(e.clientX, e.clientY, true);
  if (pos) sendInput({ t: 'mm', d: P.displayId, x: pos.x, y: pos.y });
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
document.getElementById('ovSettings')!.addEventListener('click', () => toggleMenu(true));

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
const menuCodec = document.getElementById('menuCodec') as HTMLSelectElement;
const menuRes = document.getElementById('menuRes') as HTMLSelectElement;
document.getElementById('menuLabel')!.textContent = P.label;

menuBitrate.value = [25, 50, 100, 150, 300, 400, 600].includes(P.bitrate) ? String(P.bitrate) : '150';
// Reflect the per-monitor frame rate this screen was started at. If it's an
// unusual rate not in the preset list (e.g. a 100 Hz panel), add it so the
// menu shows the true value instead of snapping to another.
if (![...menuFps.options].some((o) => o.value === String(P.fps))) {
  menuFps.add(new Option(`${P.fps} fps`, String(P.fps)));
  [...menuFps.options]
    .sort((a, b) => Number(a.value) - Number(b.value))
    .forEach((o) => menuFps.add(o)); // re-append in ascending order
}
menuFps.value = String(P.fps);
menuMode.value = P.mode === 'smooth' ? 'smooth' : 'sharp';
menuCodec.value = ['h264', 'vp9', 'av1'].includes(P.codec) ? P.codec : 'h264';
menuRes.value = [0, 720, 1080, 1440].includes(P.maxHeight) ? String(P.maxHeight) : '1440';

function toggleMenu(open = !menuOpen) {
  menuOpen = open;
  menuEl.classList.toggle('hidden', !menuOpen);
  document.body.classList.toggle('show-cursor', menuOpen);
  // The full menu is its own surface, so the top pill bar shouldn't linger
  // underneath it; the next pointer move near the top re-reveals the bar.
  overlay.classList.remove('show');
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
  // Persist the live choices onto P so a codec switch (which reconnects) keeps
  // the latest settings instead of snapping back to connect-time values.
  P.bitrate = Number(menuBitrate.value);
  P.fps = Number(menuFps.value);
  P.mode = menuMode.value;
  P.maxHeight = Number(menuRes.value);
  sendInput({ t: 'cfg', bitrate: P.bitrate, fps: P.fps, mode: P.mode, maxHeight: P.maxHeight });
}
menuBitrate.addEventListener('change', sendCfg);
menuFps.addEventListener('change', sendCfg);
menuMode.addEventListener('change', sendCfg);
menuRes.addEventListener('change', sendCfg);

// Switching codec means renegotiating the encoder, so we reconnect this screen
// with the new codec (bitrate/fps/mode carry over via P). Quick and reliable —
// a brief black flash, then the stream comes back on the chosen encoder.
menuCodec.addEventListener('change', () => {
  const next = menuCodec.value;
  if (next === P.codec) return;
  P.codec = next;
  toggleMenu(false);
  showStatus(`Switching to ${next.toUpperCase()}…`);
  connect();
});

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

// Reveal the top control bar (and the local OS cursor) the instant the pointer
// nears the top edge — driven from JS rather than a thin CSS :hover strip, so
// the bar shows immediately instead of needing the cursor parked precisely on a
// 14px zone. Over the rest of the picture the cursor stays hidden so the only
// visible pointer is the real macOS cursor captured in the stream.
const TOP_REVEAL_PX = 90;
let overlayHideTimer: ReturnType<typeof setTimeout> | undefined;

function setOverlay(show: boolean) {
  clearTimeout(overlayHideTimer);
  if (show) {
    overlay.classList.add('show');
    document.body.classList.add('show-cursor');
  } else {
    // Small grace period so a quick move away doesn't yank the bar/cursor.
    overlayHideTimer = setTimeout(() => {
      overlay.classList.remove('show');
      if (!menuOpen) document.body.classList.remove('show-cursor');
    }, 250);
  }
}

window.addEventListener('pointermove', (e) => {
  if (menuOpen) return; // OS cursor + bar stay visible while the menu is open
  setOverlay(e.clientY < TOP_REVEAL_PX);
});

// Flash the bar briefly on connect so the Settings button is discoverable,
// then let it tuck away.
function flashOverlay() {
  overlay.classList.add('show');
  clearTimeout(overlayHideTimer);
  overlayHideTimer = setTimeout(() => {
    if (!menuOpen) overlay.classList.remove('show');
  }, 2600);
}

connect();
flashOverlay();
