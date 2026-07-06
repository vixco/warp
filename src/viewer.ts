/// <reference path="./warp.d.ts" />
// Viewer window: renders one remote display fullscreen on one local monitor,
// captures mouse/keyboard and ships it to the host over a WebRTC data channel.

// The macOS host's screen capture (Chromium/ScreenCaptureKit) tops out near
// 60 fps, so the viewer never offers or reports more than this. Raise it in step
// with the host if a native high-fps capture path is ever added.
const MAX_STREAM_FPS = 60;

const params = new URLSearchParams(location.search);
const P = {
  sessionId: params.get('sessionId') || `s-${Math.random().toString(36).slice(2)}`,
  host: params.get('host') || '127.0.0.1',
  port: Number(params.get('port')) || 9750,
  code: params.get('code') || '',
  clientId: params.get('clientId') || '',
  displayId: Number(params.get('displayId')) || 0,
  // Clamp to the screen-capture ceiling: the macOS host can't capture above
  // ~60 fps, so showing/keeping a higher number here would misrepresent reality.
  fps: Math.min(Number(params.get('fps')) || 60, MAX_STREAM_FPS),
  bitrate: Number(params.get('bitrate')) || 150,
  codec: params.get('codec') || 'h264',
  mode: params.get('mode') || 'sharp',
  // Cap the encoded height on the host (0 = native). Default 2160 = "Auto (4K)":
  // 4K hosts stream their native pixels and 5K hosts downscale to a still-sharp
  // 4K, while 1080p/1440p hosts are left untouched. This is the single biggest
  // sharpness lever — the old 1440p cap softened text on high-DPI Macs. Tunable
  // live from the menu; drop it to trade sharpness for latency on a weak link.
  maxHeight: params.get('maxHeight') != null ? Number(params.get('maxHeight')) : 2160,
  label: params.get('label') || 'Warp',
  screenIndex: Number(params.get('screenIndex')) || 0,
  // Host suppressed the OS cursor in the video → we render our own local cursor.
  clientCursor: params.get('clientCursor') === '1',
};
// Audio passthrough rides on the first screen only (one audio path, not three)
const WANT_AUDIO = P.screenIndex === 0;

// Map of every local monitor being viewed -> the host display shown on it, in
// screen (DIP) coordinates. Lets a drag that crosses into another monitor drive
// the host display shown *there*, regardless of the host's physical layout.
interface ScreenRect { d: number; x: number; y: number; w: number; h: number }
let screenMap: ScreenRect[] = [];
try { screenMap = JSON.parse(params.get('screenMap') || '[]'); } catch { /* single-screen */ }

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

// reconnecting = keep the last decoded frame visible behind a small pill instead
// of covering everything with the opaque dark panel, so a brief network hiccup
// freezes the picture rather than flashing black (much smoother on WiFi).
function showStatus(msg: string, retry = false, reconnecting = false) {
  statusEl.classList.remove('hidden');
  statusEl.classList.toggle('reconnecting', reconnecting);
  statusMsg.textContent = msg;
  statusSpinner.style.display = retry ? 'none' : 'block';
  statusRetry.style.display = retry ? 'block' : 'none';
}

function hideStatus() {
  statusEl.classList.add('hidden');
  statusEl.classList.remove('reconnecting');
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
    showStatus('Reconnecting…', false, true);
    setTimeout(() => { if (!sessionEnded) connect(); }, 2000);
  };
  sock.onerror = () => { /* onclose follows */ };
}

// How much receive-side buffer to hold, in ms. A hard-zero buffer renders every
// frame the instant it arrives — lowest latency, but any network jitter then
// shows up as uneven frame spacing (micro-stutter — the "gaar / niet smooth"
// feel). "Smooth motion" trades a few ms of latency for an even cadence by
// holding ~2.5 frames (clamped 20–50 ms, so even 165 fps buffers only ~20 ms).
// "Sharp text" keeps zero for the crispest, most responsive pointer.
function videoJbMs(): number {
  if (P.mode !== 'smooth') return 0;
  return Math.min(50, Math.max(20, Math.round(2500 / (P.fps || 60))));
}
function applyReceiverLatency(r: RTCRtpReceiver) {
  // Only video is buffered for smoothness; audio always stays at zero delay.
  const jb = r.track?.kind === 'video' ? videoJbMs() : 0;
  try {
    (r as any).jitterBufferTarget = jb;
    (r as any).playoutDelayHint = jb / 1000;
  } catch { /* best effort */ }
}

async function acceptOffer(sdp: string) {
  pc = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  });

  pc.ontrack = (e) => {
    applyReceiverLatency(e.receiver);
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
        else if (msg.t === 'cur') applyCursor(msg);
        else if (msg.t === 'blob' || msg.t === 'blobc') handleBlobMsg(msg);
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
      // Re-assert the playout-delay target on every receiver once negotiated —
      // some Chromium versions reset the hint after the track is wired up, which
      // would otherwise re-introduce Chromium's own (larger) default buffer.
      pc.getReceivers().forEach(applyReceiverLatency);
    }
    if (['failed', 'disconnected'].includes(pc.connectionState) && !sessionEnded) {
      showStatus('Reconnecting…', false, true);
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

// Resolve a global screen point (MouseEvent.screenX/Y, DIP) to the host display
// + normalized position of whichever viewed monitor it falls on. Used mid-drag:
// while a mouse button is held the OS keeps delivering moves to the window the
// press started in, even when the pointer has physically moved onto another
// monitor — so this window must retarget the host display shown there.
function hostPosFromScreen(sx: number, sy: number): { d: number; x: number; y: number } | null {
  for (const m of screenMap) {
    if (sx >= m.x && sx < m.x + m.w && sy >= m.y && sy < m.y + m.h) {
      return { d: m.d, x: (sx - m.x) / m.w, y: (sy - m.y) / m.h };
    }
  }
  return null;
}

// Where a drag's move/release should land on the host: the letterbox-accurate
// position if the pointer is still over this window's picture, otherwise the
// host display of whichever monitor the pointer has physically moved onto.
function dragHostPos(e: PointerEvent): { d: number; x: number; y: number } | null {
  const local = normalizedPos(e.clientX, e.clientY, false);
  if (local && local.x >= 0 && local.x <= 1 && local.y >= 0 && local.y <= 1) {
    return { d: P.displayId, x: local.x, y: local.y };
  }
  const gp = hostPosFromScreen(e.screenX, e.screenY);
  if (gp) return gp;
  return local ? { d: P.displayId, x: local.x, y: local.y } : null;
}

let menuOpen = false;

let lastMove = 0;
let dragging = false; // a mouse button is held — we're dragging, not hovering
window.addEventListener('pointermove', (e) => {
  if (menuOpen) return;
  const now = performance.now();
  if (now - lastMove < 4) return; // ~250 Hz cap
  lastMove = now;
  if (!dragging) {
    // Free hover: unreliable/unordered — the newest position supersedes any
    // dropped one, so movement never head-of-line-blocks.
    const pos = normalizedPos(e.clientX, e.clientY, true);
    if (pos) sendFast({ t: 'mm', d: P.displayId, x: pos.x, y: pos.y });
    return;
  }
  // Dragging: reliable + ordered, on the same channel as the button events, so
  // a dropped or reordered move can't stall the window or drop it at the wrong
  // spot mid-drag (the "stroef / werkt soms niet" cross-monitor drag). The
  // resolver retargets the correct host display once the pointer crosses onto
  // another monitor.
  const hp = dragHostPos(e);
  if (hp) sendInput({ t: 'mm', ...hp });
});

window.addEventListener('pointerdown', (e) => {
  if (menuOpen) return;
  if ((e.target as HTMLElement).closest('.overlay, .hotzone')) return;
  e.preventDefault();
  dragging = true;
  // Capture the pointer for the whole press so a drag that leaves this window
  // (heading for another monitor) keeps delivering moves here instead of
  // stalling at the window edge.
  try { document.documentElement.setPointerCapture(e.pointerId); } catch { /* unsupported */ }
  const b = e.button === 1 ? 1 : e.button === 2 ? 2 : 0;
  const pos = normalizedPos(e.clientX, e.clientY, true);
  // Carry the position inside the button event so it's applied atomically with
  // the press — the click/drag can't land at a stale spot even if a move is
  // still in flight.
  sendInput(pos ? { t: 'md', b, d: P.displayId, x: pos.x, y: pos.y } : { t: 'md', b });
});

window.addEventListener('pointerup', (e) => {
  if (menuOpen) return;
  if ((e.target as HTMLElement).closest('.overlay, .hotzone')) return;
  e.preventDefault();
  try { document.documentElement.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  const b = e.button === 1 ? 1 : e.button === 2 ? 2 : 0;
  // Resolve the release against the monitor the pointer is actually over, so a
  // drag that ended on another monitor drops the window there — instead of
  // snapping back to this display's border.
  const hp = dragHostPos(e);
  sendInput(hp ? { t: 'mu', b, ...hp } : { t: 'mu', b });
  dragging = false;
});

window.addEventListener('wheel', (e) => {
  if (menuOpen) return;
  e.preventDefault();
  sendInput({ t: 'sc', dx: Math.round(e.deltaX), dy: Math.round(e.deltaY) });
}, { passive: false });

window.addEventListener('contextmenu', (e) => e.preventDefault());

const LOCAL_HOTKEYS = new Set(['KeyQ', 'KeyF', 'KeyM']);

// On a Windows keyboard driving a Mac, shortcut muscle-memory is Ctrl-based
// (Ctrl+C/V/W/T…) but the Mac uses ⌘. Default: swap Ctrl↔Win so the user's Ctrl
// becomes the Mac's ⌘ (their shortcuts "just work") and the Mac's Control moves
// to the Windows key — so nothing is lost, only relabeled. Toggle in the menu.
let ctrlCmdSwap = localStorage.getItem('kbd:swap') !== '0';
function remapCode(code: string): string {
  if (!ctrlCmdSwap) return code;
  switch (code) {
    case 'ControlLeft': return 'MetaLeft';
    case 'ControlRight': return 'MetaRight';
    case 'MetaLeft': return 'ControlLeft';
    case 'MetaRight': return 'ControlRight';
    default: return code;
  }
}

window.addEventListener('keydown', (e) => {
  // Local hotkeys (Ctrl+Shift or Win/Cmd+Shift): Q disconnect, F fullscreen,
  // M in-stream menu — Parsec-style. Checked BEFORE remap, so Ctrl+Shift+Q
  // always disconnects locally and can never reach the Mac as ⌘+Shift+Q (logout).
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
  sendInput({ t: 'kd', code: remapCode(e.code), r: e.repeat ? 1 : 0 });
});

window.addEventListener('keyup', (e) => {
  if (menuOpen) return;
  e.preventDefault();
  // Remap keyup with the SAME rule as keydown, else the host's modifier flag
  // (⌘/Control) would stay stuck after a swapped key is released.
  sendInput({ t: 'ku', code: remapCode(e.code) });
});

// Release all keys/buttons on host when this window loses focus.
window.addEventListener('blur', () => { dragging = false; sendInput({ t: 'reset' }); });

// Capture the Windows / Meta key so it reaches the host as Cmd instead of
// popping the Windows Start menu (which also steals focus, tripping the blur
// reset above and dropping the modifier). Keyboard Lock only intercepts
// OS-reserved keys while the page is in *JavaScript-initiated* fullscreen —
// Electron's window-level `fullscreen: true` does NOT satisfy that — so we must
// enter the Fullscreen API first. requestFullscreen needs a transient user
// gesture, so the first pointerdown / keydown kicks it off; we re-assert on
// fullscreenchange and on focus (the lock is released whenever the window loses
// focus). Scoped to the Meta keys so Escape / Alt+Tab keep their local meaning
// and the user can never get trapped.
async function lockKeyboard() {
  try {
    if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
    await navigator.keyboard?.lock(['MetaLeft', 'MetaRight']);
  } catch { /* unsupported, or no user activation yet — retried on next gesture */ }
}
window.addEventListener('pointerdown', lockKeyboard, { once: true });
window.addEventListener('keydown', lockKeyboard, { once: true });
document.addEventListener('fullscreenchange', lockKeyboard);
window.addEventListener('focus', lockKeyboard);

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
// Blob transfer: clipboard images (both ways) and files dropped onto the viewer
// (viewer -> host), chunked over the reliable channel.

const BLOB_CHUNK = 48 * 1024;
const MAX_BLOB_CHARS = 44 * 1024 * 1024; // ~32MB after base64
let lastImgSig = '';
function blobSig(d: string): string { return d.length + '|' + d.slice(-256); }

async function sendBlob(kind: string, dataUrl: string, extra: Record<string, any> = {}) {
  const ch = channel;
  if (ch?.readyState !== 'open' || dataUrl.length > MAX_BLOB_CHARS) return;
  const id = 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const total = Math.ceil(dataUrl.length / BLOB_CHUNK);
  ch.send(JSON.stringify({ t: 'blob', id, kind, total, ...extra }));
  for (let i = 0; i < total; i++) {
    while (ch.bufferedAmount > 8 * 1024 * 1024) await new Promise((r) => setTimeout(r, 20));
    if (ch.readyState !== 'open') return;
    ch.send(JSON.stringify({ t: 'blobc', id, seq: i, d: dataUrl.slice(i * BLOB_CHUNK, (i + 1) * BLOB_CHUNK) }));
  }
}

const incomingBlobs = new Map<string, { kind: string; total: number; parts: string[] }>();
function handleBlobMsg(msg: any) {
  if (msg.t === 'blob') {
    incomingBlobs.set(msg.id, { kind: msg.kind, total: msg.total, parts: [] });
    return;
  }
  const b = incomingBlobs.get(msg.id);
  if (!b) return;
  b.parts[msg.seq] = msg.d;
  let have = 0; for (const p of b.parts) if (p !== undefined) have++;
  if (have < b.total) return;
  incomingBlobs.delete(msg.id);
  const dataUrl = b.parts.join('');
  if (b.kind === 'img') { lastImgSig = blobSig(dataUrl); window.warp.setClipboardImage(dataUrl); }
}

// Client clipboard image -> host.
setInterval(async () => {
  if (channel?.readyState !== 'open') return;
  try {
    const d = await window.warp.getClipboardImage();
    if (d && blobSig(d) !== lastImgSig) { lastImgSig = blobSig(d); sendBlob('img', d); }
  } catch { /* ignore */ }
}, 2500);

// Drag a file onto the viewer -> send it to the host (saved to its Downloads).
window.addEventListener('dragover', (e) => { e.preventDefault(); });
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  const files = e.dataTransfer?.files;
  if (!files || !files.length || channel?.readyState !== 'open') return;
  for (const f of Array.from(files)) {
    if (f.size > 32 * 1024 * 1024) { notify(`${f.name} is too large (max 32 MB)`); continue; }
    notify(`Sending ${f.name}…`);
    try {
      const dataUrl: string = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(String(r.result));
        r.onerror = () => rej(new Error('read failed'));
        r.readAsDataURL(f);
      });
      await sendBlob('file', dataUrl, { name: f.name });
      notify(`Sent ${f.name} to host`);
    } catch { notify(`Failed to send ${f.name}`); }
  }
});

// Small transient toast in the viewer.
let notifyTimer: ReturnType<typeof setTimeout> | undefined;
function notify(msg: string) {
  const el = document.getElementById('notify');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(notifyTimer);
  notifyTimer = setTimeout(() => el.classList.remove('show'), 3000);
}

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
// Drop frame rates the host can't actually capture (> MAX_STREAM_FPS), so the
// menu never offers a number that silently clamps.
for (const o of [...menuFps.options]) {
  if (Number(o.value) > MAX_STREAM_FPS) o.remove();
}
// Reflect the per-monitor frame rate this screen was started at. If it's an
// unusual rate not in the preset list (e.g. a 50 Hz panel), add it so the menu
// shows the true value instead of snapping to another.
if (![...menuFps.options].some((o) => o.value === String(P.fps))) {
  menuFps.add(new Option(`${P.fps} fps`, String(P.fps)));
  [...menuFps.options]
    .sort((a, b) => Number(a.value) - Number(b.value))
    .forEach((o) => menuFps.add(o)); // re-append in ascending order
}
menuFps.value = String(P.fps);
menuMode.value = P.mode === 'smooth' ? 'smooth' : 'sharp';

// Only offer codecs this viewer can actually hardware-decode. HEVC in
// particular only exists as a WebRTC codec on Chromium ≥136 (Electron ≥36), so
// the H.265 option is added at runtime rather than hard-coded — no dead menu
// entry that silently falls back to H.264 when selected.
const CODEC_MIME: Record<string, string> = {
  h264: 'video/h264', hevc: 'video/h265', vp9: 'video/vp9', av1: 'video/av1',
};
function decodableCodecs(): Set<string> {
  const set = new Set<string>(['h264']); // always available
  try {
    const mimes = new Set(
      (RTCRtpReceiver.getCapabilities('video')?.codecs || [])
        .map((c) => c.mimeType.toLowerCase()));
    for (const [key, mime] of Object.entries(CODEC_MIME)) {
      if (mimes.has(mime)) set.add(key);
    }
  } catch { /* keep h264-only */ }
  return set;
}
(function syncCodecMenu() {
  const available = decodableCodecs();
  // Insert HEVC (right after H.264) when supported and not already present.
  if (available.has('hevc') && !menuCodec.querySelector('option[value="hevc"]')) {
    const opt = new Option('H.265 / HEVC — sharper per Mbit', 'hevc');
    menuCodec.add(opt, menuCodec.options[1]); // after H.264
  }
  // Drop any option the viewer can't decode, so selecting it can't dead-end.
  for (const o of [...menuCodec.options]) {
    if (!available.has(o.value)) o.remove();
  }
  const allowed = [...menuCodec.options].map((o) => o.value);
  menuCodec.value = allowed.includes(P.codec) ? P.codec : 'h264';
})();
menuRes.value = [0, 720, 1080, 1440, 2160].includes(P.maxHeight) ? String(P.maxHeight) : '2160';

const menuKbd = document.getElementById('menuKbd') as HTMLSelectElement;
menuKbd.value = ctrlCmdSwap ? 'swap' : 'native';
menuKbd.addEventListener('change', () => {
  ctrlCmdSwap = menuKbd.value === 'swap';
  localStorage.setItem('kbd:swap', ctrlCmdSwap ? '1' : '0');
  sendInput({ t: 'reset' }); // release any held modifiers so the swap can't stick a key
  notify(ctrlCmdSwap ? 'Ctrl now acts as ⌘' : 'Keyboard: native (Ctrl = Control)');
});

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

// Menu changes don't apply only to this screen: they go through the main process
// which persists them as the global default AND fans them out to EVERY open
// viewer, so one tweak changes all screens and is remembered next connect. The
// broadcast comes back to this window too (via onApplyCfg), which is where the
// change is actually applied — so behaviour is identical on the screen you
// touched and the others.
function broadcastMenuCfg() {
  window.warp.viewerApplyAll({
    bitrate: Number(menuBitrate.value),
    fps: Number(menuFps.value),
    mode: menuMode.value,
    maxHeight: Number(menuRes.value),
  });
}
menuBitrate.addEventListener('change', broadcastMenuCfg);
menuFps.addEventListener('change', broadcastMenuCfg);
menuMode.addEventListener('change', broadcastMenuCfg);
menuRes.addEventListener('change', broadcastMenuCfg);

// Switching codec renegotiates the encoder, so it reconnects — broadcast it so
// every screen switches codec together.
menuCodec.addEventListener('change', () => {
  if (menuCodec.value === P.codec) return;
  toggleMenu(false);
  window.warp.viewerApplyAll({ codec: menuCodec.value });
});

// Apply a settings patch to THIS screen (received from the broadcast, so every
// viewer applies it identically). Updates the menu, the live stream, and — for a
// codec change — reconnects. Never re-broadcasts, so there is no loop.
window.warp.onApplyCfg((cfg: any) => {
  if (cfg.bitrate != null) { P.bitrate = Number(cfg.bitrate); menuBitrate.value = String(P.bitrate); }
  if (cfg.fps != null) { P.fps = Number(cfg.fps); if ([...menuFps.options].some((o) => o.value === String(P.fps))) menuFps.value = String(P.fps); }
  if (cfg.mode != null) { P.mode = cfg.mode; menuMode.value = P.mode; }
  if (cfg.maxHeight != null) { P.maxHeight = Number(cfg.maxHeight); menuRes.value = String(P.maxHeight); }
  if (cfg.bitrate != null || cfg.fps != null || cfg.mode != null || cfg.maxHeight != null) {
    sendInput({ t: 'cfg', bitrate: P.bitrate, fps: P.fps, mode: P.mode, maxHeight: P.maxHeight });
    // Picture mode / fps changed the buffer target — re-apply it live.
    pc?.getReceivers().forEach(applyReceiverLatency);
  }
  if (cfg.codec != null && cfg.codec !== P.codec) {
    P.codec = cfg.codec;
    if ([...menuCodec.options].some((o) => o.value === P.codec)) menuCodec.value = P.codec;
    showStatus(`Switching to ${String(P.codec).toUpperCase()}…`);
    connect();
  }
});

document.getElementById('menuFullscreen')!.addEventListener('click', () =>
  window.warp.viewerToggleFullscreen());
document.getElementById('menuResume')!.addEventListener('click', () => toggleMenu(false));
document.getElementById('menuDisconnect')!.addEventListener('click', disconnect);

let lastBytes = 0, lastFrames = 0, lastTs = 0;
let lastLost = 0, lastRecv = 0, lastFec = 0, lastNack = 0;
setInterval(async () => {
  if (!pc || pc.connectionState !== 'connected') { ovStats.textContent = '—'; return; }
  try {
    const stats = await pc.getStats();
    let fps = 0, kbps = 0, rttMs = -1, w = 0, h = 0, audioBytes = 0;
    let decoder = '', hwDecode = false, jbMs = -1, procMs = -1, dropped = 0;
    let lossPct = -1, fecRate = 0, nackRate = 0;
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
        // Network health on the receive side, per interval. Packet loss is the
        // WiFi smoothness killer; fec = packets FlexFEC reconstructed WITHOUT a
        // retransmit (proves FEC is active and helping); nack = retransmits we
        // had to request (the slow, stall-prone path FEC exists to avoid).
        const lost = s.packetsLost || 0;
        const recv = s.packetsReceived || 0;
        const dLost = Math.max(0, lost - lastLost);
        const dRecv = Math.max(0, recv - lastRecv);
        if (dLost + dRecv > 0) lossPct = (dLost / (dLost + dRecv)) * 100;
        fecRate = Math.max(0, (s.fecPacketsReceived || 0) - lastFec);
        nackRate = Math.max(0, (s.nackCount || 0) - lastNack);
        lastLost = lost; lastRecv = recv;
        lastFec = s.fecPacketsReceived || 0; lastNack = s.nackCount || 0;
        w = s.frameWidth; h = s.frameHeight;
        // Is the frame being decoded on the GPU (D3D11/NVDEC) or has Chromium
        // silently fallen back to a software decoder? Software decode of a
        // HiDPI stream is the classic cause of janky, laggy animation. The
        // heuristic mirrors Chrome's own: hardware decoders aren't "power
        // efficient"=false and don't report the software impl names.
        decoder = s.decoderImplementation || '';
        hwDecode = s.powerEfficientDecoder === true ||
          (!!decoder && !/software|libvpx|ffmpeg|openh264|dav1d|unknown/i.test(decoder));
        // Real added latency on the receive side: jitter buffer + total
        // processing (decode) delay, averaged per emitted/decoded frame.
        if (s.jitterBufferEmittedCount > 0) {
          jbMs = Math.round((s.jitterBufferDelay / s.jitterBufferEmittedCount) * 1000);
        }
        if (s.framesDecoded > 0 && s.totalProcessingDelay !== undefined) {
          procMs = Math.round((s.totalProcessingDelay / s.framesDecoded) * 1000);
        }
        dropped = s.framesDropped || 0;
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
    // The menu shows the diagnostic detail: whether decode is on the GPU and
    // how much delay the jitter buffer / decode are adding — so a "laggy
    // animation" report can be pinned to software decode vs network vs encoder.
    const decoderText = decoder
      ? ` · ${hwDecode ? 'HW' : '⚠ SW'} decode` + (jbMs >= 0 ? ` · jb ${jbMs}ms` : '')
      : '';
    // Network line: packet loss (the WiFi jank source), plus how it's being
    // recovered — fec = repaired instantly by FlexFEC, nack = retransmit
    // requested (the slow path). If loss is high and fec stays 0, FlexFEC didn't
    // activate; if fec tracks loss, it's working and the picture should hold.
    const netText = lossPct >= 0
      ? ` · loss ${lossPct.toFixed(1)}%` +
        (fecRate > 0 ? ` · fec ${fecRate}/s` : '') +
        (nackRate > 0 ? ` · nack ${nackRate}/s` : '')
      : '';
    document.getElementById('menuStats')!.textContent = statsText + decoderText + netText;
    // Feed the live diagnostics graph (drawn only while the menu is open).
    diagHist.push({ mbps: kbps / 1000, fps, rtt: rttMs >= 0 ? rttMs : 0 });
    if (diagHist.length > 120) diagHist.shift();
    if (menuOpen) drawDiag();
    if (params.has('debug')) {
      console.log(`warp-stats ${JSON.stringify(
        { w, h, fps, kbps, rttMs, audioBytes, decoder, hwDecode, jbMs, procMs, dropped,
          lossPct: lossPct >= 0 ? Number(lossPct.toFixed(2)) : -1, fecRate, nackRate })}`);
    }
  } catch { /* ignore */ }
}, 1000);

// Live diagnostics graph in the in-stream menu: rolling bitrate / fps / rtt over
// the last ~2 minutes, each normalized to its own scale so you can see trends
// (e.g. bitrate sawtooth = WiFi oscillation, fps dips, rtt spikes) at a glance.
const diagHist: { mbps: number; fps: number; rtt: number }[] = [];
function drawDiag() {
  const c = document.getElementById('diagGraph') as HTMLCanvasElement | null;
  const ctx = c?.getContext('2d');
  if (!c || !ctx) return;
  const W = c.width, H = c.height, pad = 4, n = diagHist.length;
  ctx.clearRect(0, 0, W, H);
  if (n < 2) return;
  const line = (key: 'mbps' | 'fps' | 'rtt', color: string, floorMax: number) => {
    let max = floorMax;
    for (const d of diagHist) if (d[key] > max) max = d[key];
    ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.beginPath();
    diagHist.forEach((d, i) => {
      const x = pad + (i / (n - 1)) * (W - 2 * pad);
      const y = H - pad - (d[key] / max) * (H - 2 * pad);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.stroke();
  };
  line('mbps', '#4f7cff', 10);
  line('fps', '#39d98a', 60);
  line('rtt', '#ffb020', 50);
}

// Reveal the top control bar only after the pointer has DWELT in the top zone
// for a few seconds, so merely moving the cursor up to the top edge (e.g. to
// reach a window's title bar on the host) no longer flashes the bar up. It's a
// deliberate "summon" gesture, not an accidental hover. Over the rest of the
// picture the cursor stays hidden so the only visible pointer is the real macOS
// cursor captured in the stream.
const TOP_REVEAL_PX = 90;
const TOP_HOLD_MS = 5000; // dwell time in the top zone before the bar appears
let overlayHideTimer: ReturnType<typeof setTimeout> | undefined;
let topHoldTimer: ReturnType<typeof setTimeout> | undefined;
let overlayShown = false;

function setOverlay(show: boolean) {
  clearTimeout(overlayHideTimer);
  if (show) {
    overlayShown = true;
    overlay.classList.add('show');
    document.body.classList.add('show-cursor');
  } else {
    // Small grace period so a quick move away doesn't yank the bar/cursor.
    overlayHideTimer = setTimeout(() => {
      overlayShown = false;
      overlay.classList.remove('show');
      if (!menuOpen) document.body.classList.remove('show-cursor');
    }, 250);
  }
}

window.addEventListener('pointermove', (e) => {
  if (menuOpen) return; // OS cursor + bar stay visible while the menu is open
  const inZone = e.clientY < TOP_REVEAL_PX;
  if (inZone) {
    if (overlayShown) { setOverlay(true); return; } // already up — keep it, cancel hide
    // Start the dwell timer on first entering the zone; further moves inside the
    // zone don't restart it, so it fires after a continuous 5 s (even if the
    // pointer then holds perfectly still). Leaving the zone cancels it below.
    if (!topHoldTimer) {
      topHoldTimer = setTimeout(() => { topHoldTimer = undefined; setOverlay(true); }, TOP_HOLD_MS);
    }
  } else {
    if (topHoldTimer) { clearTimeout(topHoldTimer); topHoldTimer = undefined; }
    setOverlay(false);
  }
});

// Flash the bar briefly on connect so the Settings button is discoverable,
// then let it tuck away.
function flashOverlay() {
  overlayShown = true;
  overlay.classList.add('show');
  clearTimeout(overlayHideTimer);
  overlayHideTimer = setTimeout(() => {
    overlayShown = false;
    if (!menuOpen) overlay.classList.remove('show');
  }, 2600);
}

// ---------------------------------------------------------------------------
// Local cursor (Parsec-style): when the host suppressed the OS cursor in the
// video, render the host's ACTUAL cursor image at OUR pointer position, redrawn
// every animation frame — so the pointer tracks the monitor's full refresh rate,
// decoupled from the ~60 fps video. Only the cursor image + hotspot is streamed
// (reliable channel, on shape change); placement is 100% local.
const cursorEl = document.getElementById('cursor') as HTMLImageElement | null;
let curX = 0, curY = 0;
let curFracH = 0.03, curAspect = 0.6, curHotX = 0, curHotY = 0;
let curHidden = false, curReady = false;

function applyCursor(m: any) {
  if (!P.clientCursor || !cursorEl) return;
  if (m.hidden) { curHidden = true; return; }
  curHidden = false;
  if (m.png) { cursorEl.src = 'data:image/png;base64,' + m.png; curReady = true; }
  if (typeof m.fracH === 'number' && m.fracH > 0) curFracH = m.fracH;
  if (typeof m.aspect === 'number' && m.aspect > 0) curAspect = m.aspect;
  if (typeof m.hotFracX === 'number') curHotX = m.hotFracX;
  if (typeof m.hotFracY === 'number') curHotY = m.hotFracY;
}

if (P.clientCursor && cursorEl) {
  // Default arrow so a cursor is always visible — even before the host's first
  // image, or if the cursor helper is unavailable (the video cursor is hidden,
  // so without this the pointer would vanish). Replaced by the exact host cursor
  // the moment it arrives. Hotspot at the tip (0,0).
  cursorEl.src = 'data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12 19">' +
    '<path d="M0 0 L0 16 L4 12 L7 18 L9 17 L6 11 L11 11 Z" ' +
    'fill="#fff" stroke="#000" stroke-width="1.2" stroke-linejoin="round"/></svg>');
  curReady = true; curAspect = 12 / 19; curFracH = 0.032; curHotX = 0; curHotY = 0;
  window.addEventListener('pointermove', (e) => { curX = e.clientX; curY = e.clientY; }, { passive: true });
  const tickCursor = () => {
    requestAnimationFrame(tickCursor);
    const vw = video.videoWidth, vh = video.videoHeight;
    // Hidden over the menu/overlay (real OS cursor is shown there for the
    // controls), when the host app hid the cursor, before the first image, or
    // when the pointer is off the picture (letterbox bars / other monitor).
    if (!curReady || curHidden || menuOpen || overlayShown || !vw || !vh) {
      cursorEl.style.display = 'none'; return;
    }
    const ew = video.clientWidth, eh = video.clientHeight;
    const scale = Math.min(ew / vw, eh / vh);
    const dw = vw * scale, dh = vh * scale;
    const ox = (ew - dw) / 2, oy = (eh - dh) / 2;
    if (curX < ox || curX > ox + dw || curY < oy || curY > oy + dh) {
      cursorEl.style.display = 'none'; return;
    }
    const h = curFracH * dh, w = h * curAspect;
    cursorEl.style.width = `${w}px`;
    cursorEl.style.height = `${h}px`;
    cursorEl.style.transform = `translate3d(${curX - curHotX * w}px, ${curY - curHotY * h}px, 0)`;
    cursorEl.style.display = 'block';
  };
  requestAnimationFrame(tickCursor);
}

// If the chosen codec can't be hardware-decoded on this machine, fall back to
// H.264 (always available) before the first connect — so making HEVC the shipped
// default can never dead-end a viewer whose GPU lacks HEVC decode.
if (!decodableCodecs().has(P.codec)) P.codec = 'h264';

connect();
flashOverlay();
