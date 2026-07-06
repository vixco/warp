/// <reference path="./warp.d.ts" />
// Main window renderer: UI + host streaming engine + client connect flow.

const $ = <T extends HTMLElement = HTMLElement>(sel: string) =>
  document.querySelector(sel) as T;

const warp = window.warp;

// The practical ceiling for macOS screen capture through Chromium's desktop
// capturer (ScreenCaptureKit, default 1/60 s frame interval). Asking for more
// just makes the capture over-commit and auto-throttle; 60 is the steady target.
const MAX_CAPTURE_FPS = 60;

// ---------------------------------------------------------------------------
// Navigation

document.querySelectorAll<HTMLElement>('.nav-item').forEach((item) => {
  item.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach((n) => n.classList.remove('active'));
    document.querySelectorAll('.page').forEach((p) => p.classList.remove('visible'));
    item.classList.add('active');
    $(`#page-${item.dataset.page}`).classList.add('visible');
  });
});

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(msg: string, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('visible'), 4200);
}

// ---------------------------------------------------------------------------
// Settings page

let settings: any = {};

async function loadSettingsUi() {
  settings = await warp.getSettings();
  ($('#setFps') as HTMLSelectElement).value = String(settings.fps);
  ($('#setBitrate') as HTMLInputElement).value = String(settings.maxBitrateMbps);
  ($('#setCodec') as HTMLSelectElement).value = settings.codec;
  ($('#setStreamMode') as HTMLSelectElement).value = settings.streamMode || 'sharp';
  ($('#setHostName') as HTMLInputElement).value = settings.hostName;
  ($('#setPort') as HTMLInputElement).value = String(settings.port);
  ($('#setPairingCode') as HTMLInputElement).value = settings.pairingCode;
  ($('#setHidpi') as HTMLInputElement).checked = !!settings.hidpiVirtual;
  ($('#setSuppressCursor') as HTMLInputElement).checked = !!settings.suppressCursor;
  ($('#setLaunchAtLogin') as HTMLInputElement).checked = !!settings.launchAtLogin;
  ($('#setAudioEnabled') as HTMLInputElement).checked = settings.audioEnabled !== false;
  await populateHostAudioDevices();
  ($('#setAudioSource') as HTMLSelectElement).value = settings.audioSource || 'auto';
  if (!($('#setAudioSource') as HTMLSelectElement).value) {
    ($('#setAudioSource') as HTMLSelectElement).value = 'auto';
  }
  ($('#setMicSink') as HTMLSelectElement).value = settings.micSink || 'default';
  if (!($('#setMicSink') as HTMLSelectElement).value) {
    ($('#setMicSink') as HTMLSelectElement).value = 'default';
  }
}

async function populateHostAudioDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const src = $('#setAudioSource') as HTMLSelectElement;
    src.innerHTML = '';
    src.add(new Option('Auto (system loopback)', 'auto'));
    devices.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default')
      .forEach((d, i) => src.add(new Option(d.label || `Audio input ${i + 1}`, d.deviceId)));

    const sink = $('#setMicSink') as HTMLSelectElement;
    sink.innerHTML = '';
    sink.add(new Option('Default speakers', 'default'));
    devices.filter((d) => d.kind === 'audiooutput' && d.deviceId !== 'default')
      .forEach((d, i) => sink.add(new Option(d.label || `Audio output ${i + 1}`, d.deviceId)));
  } catch { /* keep defaults */ }
}

$('#saveSettingsBtn').addEventListener('click', async () => {
  settings = await warp.setSettings({
    fps: Number(($('#setFps') as HTMLSelectElement).value),
    maxBitrateMbps: Number(($('#setBitrate') as HTMLInputElement).value),
    codec: ($('#setCodec') as HTMLSelectElement).value,
    streamMode: ($('#setStreamMode') as HTMLSelectElement).value,
    hostName: ($('#setHostName') as HTMLInputElement).value.trim() || settings.hostName,
    port: Number(($('#setPort') as HTMLInputElement).value) || 9750,
    pairingCode: ($('#setPairingCode') as HTMLInputElement).value.replace(/\D/g, ''),
    hidpiVirtual: ($('#setHidpi') as HTMLInputElement).checked,
    suppressCursor: ($('#setSuppressCursor') as HTMLInputElement).checked,
    launchAtLogin: ($('#setLaunchAtLogin') as HTMLInputElement).checked,
    audioEnabled: ($('#setAudioEnabled') as HTMLInputElement).checked,
    audioSource: ($('#setAudioSource') as HTMLSelectElement).value,
    micSink: ($('#setMicSink') as HTMLSelectElement).value,
  });
  toast('Settings saved');
});

// ---------------------------------------------------------------------------
// Host page

function renderHostState(s: any) {
  $('#hostDot').classList.toggle('on', s.hosting);
  $('#hostStatusText').textContent = s.hosting ? 'Hosting on' : 'Hosting off';
  $('#clientCountText').textContent =
    s.hosting && s.clients > 0 ? `${s.clients} client(s) connected` : '';
  ($('#hostToggle') as HTMLInputElement).checked = s.hosting;
  $('#hostInfo').style.display = s.hosting ? 'block' : 'none';
  $('#hostOnlyMac').style.display = s.canHost ? 'none' : 'block';
  ($('#hostToggle') as HTMLInputElement).disabled = !s.canHost;
  $('#permPanel').style.display = s.platform === 'darwin' ? 'block' : 'none';

  if (s.hosting) {
    $('#pairingCode').textContent = s.code;
    $('#hostAddr').textContent = `${s.ip}:${s.port}`;
    $('#hostClients').textContent = String(s.clients);

    const list = $('#hostDisplayList');
    list.innerHTML = '';
    for (const d of s.displays) {
      const row = document.createElement('div');
      row.className = 'display-row';
      row.innerHTML = `
        <div>
          <div class="dlabel"></div>
          <div class="dmeta"></div>
        </div>
        <div class="spacer"></div>`;
      row.querySelector('.dlabel')!.textContent = d.label;
      row.querySelector('.dmeta')!.textContent = `${d.width} × ${d.height}`;
      if (d.primary) row.insertAdjacentHTML('beforeend', '<span class="tag primary">PRIMARY</span>');
      if (d.virtual) {
        row.insertAdjacentHTML('beforeend', '<span class="tag virtual">VIRTUAL</span>');
        const rm = document.createElement('button');
        rm.className = 'btn secondary small';
        rm.textContent = 'Remove';
        rm.addEventListener('click', () => warp.destroyVdisplay(d.vdisplayToken));
        row.appendChild(rm);
      }
      list.appendChild(row);
    }
  }

  const permTag = (el: HTMLElement, status: string) => {
    const ok = status === 'granted';
    el.textContent = ok ? 'GRANTED' : status.toUpperCase();
    el.className = `tag ${ok ? 'good' : 'bad'}`;
  };
  permTag($('#permScreen'), s.permissions.screen);
  permTag($('#permAccessibility'), s.permissions.accessibility);
}

($('#hostToggle') as HTMLInputElement).addEventListener('change', async (e) => {
  const on = (e.target as HTMLInputElement).checked;
  if (on) {
    const res = await warp.startHosting();
    if (!res.ok) {
      toast(res.error || 'Could not start hosting', true);
      (e.target as HTMLInputElement).checked = false;
    }
  } else {
    await warp.stopHosting();
    hostEngine.stopAll();
  }
});

$('#addVdisplayBtn').addEventListener('click', async () => {
  toast('Creating virtual display…');
  const out = await warp.createVdisplay(1920, 1080);
  if (!out.ok) toast(out.error || 'Failed to create virtual display', true);
});

document.querySelectorAll<HTMLElement>('[data-perm]').forEach((btn) => {
  btn.addEventListener('click', () => warp.openPermissionSettings(btn.dataset.perm!));
});

warp.onHostState(renderHostState);
warp.onHostingStopped(() => hostEngine.stopAll());
warp.onUpdateReady((version) => {
  toast(`Update v${version} downloaded — restart Warp to apply`);
  $('#updStatus').textContent = `v${version} ready`;
  $('#updRestartBtn').style.display = 'inline-flex';
});

// On unsigned macOS builds, quitAndInstall() silently no-ops. The main process
// detects that, opens the releases page in the browser, and fires this event
// so we can tell the user what just happened instead of leaving them with a
// button that does nothing.
warp.onUpdateInstallFailed(() => {
  $('#updStatus').textContent = 'Auto-install unavailable — download page opened';
  toast('Auto-install not available on this build — download page opened. Install manually.', true);
});

// ---------------------------------------------------------------------------
// Updates panel

warp.getAppVersion().then((v) => { $('#updVersion').textContent = `Warp v${v}`; });

$('#updCheckBtn').addEventListener('click', async () => {
  const btn = $('#updCheckBtn') as HTMLButtonElement;
  const status = $('#updStatus');
  btn.disabled = true;
  status.textContent = 'Checking…';
  try {
    const res = await warp.checkForUpdates();
    if (!res.ok) {
      status.textContent = res.error || 'Check failed';
    } else if (res.downloaded) {
      status.textContent = `v${res.latestVersion} ready`;
      $('#updRestartBtn').style.display = 'inline-flex';
    } else if (res.updateAvailable) {
      status.textContent = `v${res.latestVersion} found — downloading…`;
    } else {
      status.textContent = `Up to date (v${res.currentVersion})`;
    }
  } finally {
    btn.disabled = false;
  }
});

$('#updRestartBtn').addEventListener('click', () => warp.installUpdate());

// ---------------------------------------------------------------------------
// Host streaming engine (runs while hosting; one PeerConnection per session)

interface HostSession {
  pc: RTCPeerConnection;
  stream: MediaStream | null;
  channel: RTCDataChannel | null;      // reliable/ordered: keys, clicks, clipboard
  fastChannel: RTCDataChannel | null;  // unreliable/unordered: continuous mouse move
  displayId: number;
  sender: RTCRtpSender | null;
  track: MediaStreamTrack | null;
  captureHeight: number;               // physical capture height, for resolution scaling
  scaleFactor: number;                 // host display backing-scale, for cursor sizing
  reqBitrate: number;                  // this screen's requested ceiling (Mbps), pre-sharing
  audioStream: MediaStream | null;   // system audio being sent to the client
  micPlayer: HTMLAudioElement | null; // client microphone played on the host
  // Adaptive-quality control state (AIMD on an absolute per-session bitrate cap).
  adaptCapMbps: number;   // effective ceiling this loop owns; starts = shared share
  lossEwma: number;       // smoothed receiver-reported fractionLost
  rttEwma: number; rttBaseMs: number;
  stableTicks: number;    // consecutive clean ticks (gate for raising)
  holdTicks: number;      // ticks left blocking a raise after a cut
  coolTicks: number;      // ticks left blocking a further cut after a cut
  qlBwTicks: number;      // consecutive 'bandwidth' quality-limitation ticks
  lastBytesSent: number; lastStatTs: number;
}

// Adaptive-quality (AIMD) tuning. The controller keeps the send bitrate just
// below what the link can sustain so WebRTC's congestion control never probes up
// into WiFi loss and oscillates ("gaar"). It is a strict no-op on a clean link:
// with fractionLost ~0 and no 'bandwidth' quality-limitation, no cut ever fires,
// so the cap stays pinned at the full shared share.
const ADAPT_INTERVAL_MS = 1000;   // one control tick per RTCP report interval
const LOSS_HIGH = 0.02;           // >2% smoothed receiver loss → back off
const LOSS_SEVERE = 0.08;         // >8% → a harder one-shot cut
const LOSS_LOW = 0.005;           // <0.5% → clean enough to consider raising
const BETA = 0.85;                // multiplicative decrease: gentle −15% reads smooth
const BETA_SEVERE = 0.70;         // harder cut when severe loss
const AVAIL_HEADROOM = 0.95;      // on a cut, snap to 95% of GCC's own estimate
const STEP_MBPS = 2;              // additive increase per clean tick
const UP_STABLE_TICKS = 5;        // must be clean this many ticks before raising
const DOWN_COOLDOWN_TICKS = 2;    // after a cut, block further cuts (let RR catch up)
const UP_HOLD_TICKS = 8;          // after a cut, block raises (don't re-probe the loss)
const QL_BW_TICKS = 2;            // debounce 'bandwidth' quality-limitation
const RTT_INFLATE_MS = 30;        // RTT rise over baseline that signals bufferbloat

class HostEngine {
  sessions = new Map<string, HostSession>();

  // macOS/Electron desktop capture is NOT safe to acquire concurrently: when
  // several viewer windows connect at once (multi-monitor), their start-screen
  // messages all land in this single host renderer and race inside
  // getUserMedia({chromeMediaSource:'desktop'}) — the first ones succeed and a
  // later one deadlocks (the classic "monitor 3 just hangs" symptom). We fund
  // one shared lock so each screen's capture is acquired strictly one after
  // another; three concurrent streams then run fine once each is set up.
  private captureLock: Promise<unknown> = Promise.resolve();
  private serializeCapture<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.captureLock.then(fn, fn);
    this.captureLock = run.catch(() => { /* keep the chain alive on failure */ });
    return run;
  }

  // Every viewer monitor opens its own PeerConnection, but they all share ONE
  // physical link, encoder and (client) decoder. Left alone, three streams each
  // ramp toward the full user ceiling with no knowledge of each other; their
  // independent congestion controllers then fight over the same WiFi, and
  // whichever ramps last (the 3rd screen) loses the race — its bitrate collapses
  // and latency spikes. That is the "3e monitor lagt heeel erg". So we treat the
  // configured ceiling as a budget SHARED across the active screens: each screen
  // gets its requested ceiling divided by the number of live screens, keeping the
  // aggregate near the single-stream ceiling instead of N× it. A floor prevents a
  // many-monitor split from starving any one screen into mush.
  private static readonly PER_STREAM_FLOOR_MBPS = 8;
  private perStreamBitrateMbps(s: HostSession): number {
    const n = Math.max(1, this.sessions.size);
    return Math.max(HostEngine.PER_STREAM_FLOOR_MBPS, Math.round(s.reqBitrate / n));
  }

  // The ceiling actually applied to the encoder: the smaller of this screen's
  // shared share and the adaptive controller's cap (never below the floor). The
  // adaptive loop only ever writes `adaptCapMbps`; every place that applies a
  // bitrate goes through here, so on a clean link (adaptCap == share) it's a
  // no-op, and the multi-monitor split still owns the share.
  private effectiveBitrateMbps(s: HostSession): number {
    const share = this.perStreamBitrateMbps(s);
    const cap = s.adaptCapMbps ?? share;
    return Math.max(HostEngine.PER_STREAM_FLOOR_MBPS, Math.min(share, Math.round(cap)));
  }

  // Re-apply each live screen's shared bitrate ceiling. Called whenever the set
  // of active screens changes (a monitor connects or disconnects), so the split
  // widens back out the instant a screen closes and tightens when one joins.
  private async rebalanceBitrates() {
    for (const s of this.sessions.values()) {
      if (!s.sender) continue;
      // The share may have shrunk (a screen joined) — clamp the adaptive cap into
      // the new band so the aggregate never exceeds the link. A widened share (a
      // screen left) is re-probed additively by the loop, never burst.
      s.adaptCapMbps = Math.min(this.perStreamBitrateMbps(s), s.adaptCapMbps ?? this.perStreamBitrateMbps(s));
      try {
        const params = s.sender.getParameters();
        params.encodings = params.encodings?.length ? params.encodings : [{}];
        params.encodings[0].maxBitrate = this.effectiveBitrateMbps(s) * 1_000_000;
        await s.sender.setParameters(params);
      } catch { /* a transient renegotiation can reject setParameters; next call fixes it */ }
    }
  }

  // Latest cursor image from the native helper, forwarded to every viewer so it
  // can render an exact local cursor. Only populated when cursor suppression is on.
  private lastCursor: any = null;

  constructor() {
    warp.onEngineMessage(({ sessionId, msg }) => this.handle(sessionId, msg));
    warp.onCursorUpdate((m) => this.onCursorUpdate(m));
    setInterval(() => this.syncClipboard(), 1500);
    // Adaptive-quality control tick: one AIMD step per session per second.
    setInterval(() => { for (const [id, s] of this.sessions) this.adaptTick(id, s); }, ADAPT_INTERVAL_MS);
  }

  // One adaptive-quality step for a session: read the receiver-reported loss and
  // the encoder/transport stats, then nudge this session's absolute bitrate cap
  // down (multiplicatively, on real loss) or up (additively, only when clean and
  // actually pushing against the cap). Provably a no-op on a clean link.
  private async adaptTick(id: string, s: HostSession) {
    if (!s.sender || s.pc.connectionState !== 'connected') return;
    let stats: RTCStatsReport;
    try { stats = await s.pc.getStats(); } catch { return; }

    let fracLost = 0, rttMs = -1, availMbps = -1, qlr = 'none';
    let bytesSent = 0, ts = 0, haveRemote = false;
    stats.forEach((r: any) => {
      if (r.type === 'remote-inbound-rtp' && r.kind === 'video') {
        fracLost = r.fractionLost ?? 0; haveRemote = true;
        if (r.roundTripTime != null) rttMs = r.roundTripTime * 1000;
      } else if (r.type === 'outbound-rtp' && r.kind === 'video') {
        qlr = r.qualityLimitationReason || 'none';
        bytesSent = r.bytesSent || 0; ts = r.timestamp;
      } else if (r.type === 'candidate-pair' &&
                 (r.nominated || r.state === 'succeeded') &&
                 r.availableOutgoingBitrate != null) {
        availMbps = r.availableOutgoingBitrate / 1e6;
        if (rttMs < 0 && r.currentRoundTripTime != null) rttMs = r.currentRoundTripTime * 1000;
      }
    });
    if (!haveRemote) return; // no RTCP report yet — leave everything alone

    s.lossEwma = 0.4 * fracLost + 0.6 * s.lossEwma;
    if (rttMs >= 0) {
      s.rttEwma = s.rttEwma ? 0.4 * rttMs + 0.6 * s.rttEwma : rttMs;
      const base = Math.min(s.rttBaseMs, rttMs);
      s.rttBaseMs = base + 0.01 * (rttMs - base); // fast to track down, slow to drift up
    }
    let sendMbps = 0;
    if (s.lastStatTs && ts > s.lastStatTs) {
      sendMbps = (bytesSent - s.lastBytesSent) * 8 / ((ts - s.lastStatTs) / 1000) / 1e6;
    }
    s.lastBytesSent = bytesSent; s.lastStatTs = ts;
    s.qlBwTicks = qlr === 'bandwidth' ? s.qlBwTicks + 1 : 0;

    const applied = this.effectiveBitrateMbps(s);
    const share = this.perStreamBitrateMbps(s);
    const pushing = sendMbps >= 0.85 * applied; // GCC pinned against our ceiling

    const down =
      s.lossEwma > LOSS_HIGH ||
      (s.qlBwTicks >= QL_BW_TICKS && pushing) ||
      (rttMs >= 0 && s.rttEwma > s.rttBaseMs + RTT_INFLATE_MS && pushing);

    if (down && s.coolTicks === 0) {
      const beta = s.lossEwma > LOSS_SEVERE ? BETA_SEVERE : BETA;
      let next = applied * beta;
      if (availMbps > 0) next = Math.min(next, availMbps * AVAIL_HEADROOM); // snap to real estimate
      s.adaptCapMbps = Math.max(HostEngine.PER_STREAM_FLOOR_MBPS, next);
      s.coolTicks = DOWN_COOLDOWN_TICKS; s.holdTicks = UP_HOLD_TICKS; s.stableTicks = 0;
      await this.applyEffective(s);
      return;
    }
    if (s.coolTicks > 0) s.coolTicks--;
    if (s.holdTicks > 0) s.holdTicks--;

    if (s.lossEwma < LOSS_LOW && qlr !== 'bandwidth') s.stableTicks++; else s.stableTicks = 0;
    const canUp = s.stableTicks >= UP_STABLE_TICKS && s.holdTicks === 0 &&
                  sendMbps >= 0.8 * applied && s.adaptCapMbps < share;
    if (canUp) {
      s.adaptCapMbps = Math.min(share, s.adaptCapMbps + STEP_MBPS);
      s.stableTicks = 0;
      await this.applyEffective(s);
    }
  }

  private async applyEffective(s: HostSession) {
    if (!s.sender) return;
    try {
      const p = s.sender.getParameters();
      p.encodings = p.encodings?.length ? p.encodings : [{}];
      p.encodings[0].maxBitrate = this.effectiveBitrateMbps(s) * 1_000_000;
      await s.sender.setParameters(p);
    } catch { /* transient renegotiation; next tick fixes it */ }
  }

  // A new cursor image (or hidden state) arrived from the host: remember it and
  // push it to every connected screen. Placement is done entirely client-side at
  // the viewer's own pointer, so only the image + hotspot + size is streamed, and
  // only when the cursor shape actually changes.
  private onCursorUpdate(m: any) {
    this.lastCursor = m;
    for (const s of this.sessions.values()) this.sendCursorToSession(s, m);
  }

  private sendCursorToSession(s: HostSession, m: any) {
    if (!m || s.channel?.readyState !== 'open') return;
    try {
      if (m.hidden) { s.channel.send(JSON.stringify({ t: 'cur', hidden: 1 })); return; }
      // Size the cursor as a fraction of the host display height so the viewer
      // can scale it correctly through any encode-downscale / letterbox / viewer
      // DPI: cursor points × host backing-scale ÷ captured pixel height.
      const fracH = (Number(m.sh) * (s.scaleFactor || 1)) / (s.captureHeight || 1080);
      s.channel.send(JSON.stringify({
        t: 'cur', png: m.png, fracH,
        hotFracX: m.sw ? m.hx / m.sw : 0,
        hotFracY: m.sh ? m.hy / m.sh : 0,
        aspect: m.ph ? m.pw / m.ph : 1,
      }));
    } catch { /* ignore */ }
  }

  private lastClip = '';
  private async syncClipboard() {
    if (this.sessions.size === 0) return;
    try {
      const text = await warp.getClipboard();
      if (text && text !== this.lastClip) {
        this.lastClip = text;
        for (const s of this.sessions.values()) {
          if (s.channel?.readyState === 'open') {
            s.channel.send(JSON.stringify({ t: 'clip', s: text }));
          }
        }
      }
    } catch { /* ignore */ }
  }

  private async handle(sessionId: string, msg: any) {
    try {
      switch (msg.type) {
        case 'start-screen':
          return await this.serializeCapture(() => this.startScreen(sessionId, msg));
        case 'rtc-answer': {
          const s = this.sessions.get(sessionId);
          if (s) await s.pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
          break;
        }
        case 'rtc-ice': {
          const s = this.sessions.get(sessionId);
          if (s && msg.candidate) await s.pc.addIceCandidate(msg.candidate);
          break;
        }
        case 'stop-screen': return this.stopScreen(sessionId);
      }
    } catch (err) {
      console.error('host engine error', err);
    }
  }

  private async startScreen(sessionId: string, msg: any) {
    this.stopScreen(sessionId);
    const displayId = Number(msg.displayId);
    const source = await warp.getCaptureSource(displayId);
    if (!source) {
      warp.toSession(sessionId, { type: 'error', error: 'display not found' });
      return;
    }

    // Clamp to the real screen-capture ceiling. macOS ScreenCaptureKit (which
    // Chromium's desktop capturer uses) defaults to a 1/60 s frame interval, so
    // the capturer cannot deliver more than ~60 fps no matter what we ask for —
    // requesting 120/165 only makes the pipeline over-commit and Chromium
    // auto-throttle harder, which is what dropped delivery to ~30. Targeting a
    // realistic 60 lets it hold a steady 60 during motion. (>60 needs a native
    // capture path, out of scope here.)
    const fps = Math.min(Number(msg.fps) || 60, MAX_CAPTURE_FPS);
    const src = source as any;
    const hostSettings = await warp.getSettings();
    const wantAudio = !!msg.wantAudio;
    const audioSource = hostSettings.audioSource || 'auto';
    const useLoopback = wantAudio && hostSettings.audioEnabled !== false &&
      audioSource === 'auto';

    // Capture at the display's native physical size and let the WebRTC encoder
    // downscale to maxHeight (scaleResolutionDownBy). We tried pinning the
    // capture itself to the smaller encode target to save pixels, but on macOS a
    // *scaled* desktop capture (min=max set below native) is very slow to
    // establish per display — and because captures are serialized (below), each
    // extra screen then waited minutes before its picture appeared. Native
    // capture negotiates instantly, so all monitors come up at once.
    let captureHeight = Number(src.height) || 1080;
    const scaleFactor = Number(src.scaleFactor) || 1;

    // When cursor suppression is on, the OS cursor must NOT be baked into the
    // video (the viewer draws its own). Only getDisplayMedia can drop it
    // (cursor:'never' → ScreenCaptureKit showsCursor=NO); the legacy getUserMedia
    // desktop path has no cursor option. We keep NATIVE size via `ideal` (never
    // exact/min=max — that scaled path is what once made monitors black/slow) and
    // queue the target display for the main-process handler. Otherwise (default)
    // keep the proven getUserMedia path with the real cursor in frames.
    const suppressCursor = hostSettings.suppressCursor === true;
    let stream: MediaStream;
    try {
      let capture: Promise<MediaStream>;
      if (suppressCursor) {
        warp.queueCaptureDisplay(displayId);
        capture = (navigator.mediaDevices as any).getDisplayMedia({
          audio: false,
          video: {
            cursor: 'never',
            frameRate: fps,
            width: { ideal: src.width || 1920 },
            height: { ideal: src.height || 1080 },
          },
        }) as Promise<MediaStream>;
      } else {
        capture = (navigator.mediaDevices as any).getUserMedia({
          audio: false,
          video: {
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: src.id,
              minWidth: src.width || 640,
              minHeight: src.height || 480,
              maxWidth: src.width || 8192,
              maxHeight: src.height || 8192,
              maxFrameRate: fps,
            },
          },
        }) as Promise<MediaStream>;
      }
      // Never let a wedged capture hold the shared lock forever — bound it so a
      // failed screen surfaces an error and lets the next screen proceed.
      stream = await Promise.race([
        capture,
        new Promise<MediaStream>((_, rej) =>
          setTimeout(() => rej(new Error('capture timed out')), 12000)),
      ]);
      // getDisplayMedia may report logical rather than physical pixels — trust
      // the track's real height so scaleResolutionDownBy / cursor sizing stay right.
      if (suppressCursor) {
        const st = stream.getVideoTracks()[0]?.getSettings();
        if (st?.height) captureHeight = st.height;
      }
    } catch (err: any) {
      console.error('display capture failed', err);
      warp.toSession(sessionId, {
        type: 'error',
        error: `screen capture unavailable: ${err?.message || err}`,
      });
      return;
    }

    // System audio: captured from a virtual audio device (BlackHole & co) via
    // plain getUserMedia. Note: SCK loopback (getDisplayMedia audio) stalls
    // ALL screen capture on recent macOS + Electron, so it is not used.
    let audioTrack: MediaStreamTrack | null = null;
    let audioCapture: MediaStream | null = null;
    if (wantAudio && hostSettings.audioEnabled !== false) {
      let deviceId: string | null = audioSource;
      if (useLoopback) deviceId = await findVirtualAudioDevice();
      if (deviceId && deviceId !== 'auto') {
        audioCapture = await this.captureSystemAudio(deviceId);
        audioTrack = audioCapture?.getAudioTracks()[0] ?? null;
      }
    }

    const track = stream.getVideoTracks()[0];
    // 'detail' preserves text sharpness at high bitrate; 'smooth' favors
    // fluid motion (gaming/video) — switchable live from the client menu.
    track.contentHint = msg.mode === 'smooth' ? 'motion' : 'detail';

    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    });
    const session: HostSession = {
      pc, stream, channel: null, fastChannel: null, displayId, sender: null, track,
      captureHeight, scaleFactor, reqBitrate: Number(msg.bitrate) || 150,
      audioStream: audioCapture, micPlayer: null,
      adaptCapMbps: Number(msg.bitrate) || 150,
      lossEwma: 0, rttEwma: 0, rttBaseMs: 1e9,
      stableTicks: 0, holdTicks: 0, coolTicks: 0, qlBwTicks: 0,
      lastBytesSent: 0, lastStatTs: 0,
    };
    this.sessions.set(sessionId, session);
    session.adaptCapMbps = this.perStreamBitrateMbps(session); // start at the full share → no-op

    // Two data channels so continuous mouse movement never gets stuck behind a
    // video retransmit:
    //  • 'warp'      — reliable + ordered: keystrokes, clicks, clipboard.
    //  • 'warp-fast' — unordered, no retransmit: high-rate pointer moves, where
    //    the newest position supersedes any dropped one, so waiting on a resend
    //    would only add latency.
    const channel = pc.createDataChannel('warp', { ordered: true });
    session.channel = channel;
    channel.onmessage = (e) => this.onChannelMessage(sessionId, e.data);
    // Send the current cursor to this screen the moment its channel opens, so a
    // freshly-connected viewer shows the right cursor immediately (not only after
    // the next shape change). Harmless when suppression is off (no cursor data).
    channel.onopen = () => {
      if (this.lastCursor) this.sendCursorToSession(session, this.lastCursor);
      else warp.requestCursorSnapshot();
    };

    const fastChannel = pc.createDataChannel('warp-fast', {
      ordered: false, maxRetransmits: 0,
    });
    session.fastChannel = fastChannel;
    fastChannel.onmessage = (e) => this.onChannelMessage(sessionId, e.data);

    const transceiver = pc.addTransceiver(track, {
      direction: 'sendonly',
      streams: [stream],
    });
    session.sender = transceiver.sender;
    preferCodec(transceiver, String(msg.codec || 'h264'));

    // Audio passthrough rides on the first screen's connection only:
    // host system audio -> client, client microphone -> host.
    if (wantAudio) {
      // sendrecv even without a host track so the client can still send mic.
      const audioTransceiver = pc.addTransceiver(audioTrack ?? 'audio', {
        direction: 'sendrecv',
      });
      void audioTransceiver;

      pc.ontrack = (e) => {
        if (e.track.kind !== 'audio') return;
        try { (e.receiver as any).jitterBufferTarget = 0; } catch { /* ignore */ }
        const player = new Audio();
        player.srcObject = e.streams[0] || new MediaStream([e.track]);
        player.autoplay = true;
        const sink = hostSettings.micSink;
        if (sink && sink !== 'default') {
          (player as any).setSinkId?.(sink).catch(() => { /* fall back to default */ });
        }
        session.micPlayer?.pause();
        session.micPlayer = player;
      };
    }

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        warp.toSession(sessionId, { type: 'rtc-ice', candidate: e.candidate.toJSON() });
      }
    };
    pc.onconnectionstatechange = () => {
      if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
        // Client will retry / session cleaned by ws close; just log.
        console.log(`session ${sessionId}: ${pc.connectionState}`);
      }
    };

    const mbps = Number(msg.bitrate) || 150;
    const mode = msg.mode === 'smooth' ? 'smooth' : 'sharp';
    const maxHeight = Number(msg.maxHeight) || 0; // 0 = native, else cap encode height

    const offer = await pc.createOffer();
    // Tune the encoder's bitrate envelope in the SDP (see tuneVideoSdp): high
    // ceiling + high start for instant quality, low floor for minimal idle
    // bandwidth. Must happen before setLocalDescription so the local encoder
    // picks it up. The start-bitrate is divided by the number of live screens so
    // three connecting monitors don't collectively burst 3× the link's capacity
    // on the very first frames (which is what collapses the 3rd stream).
    const tunedSdp = tuneVideoSdp(offer.sdp || '', mbps, this.sessions.size);
    await pc.setLocalDescription({ type: 'offer', sdp: tunedSdp });
    warp.toSession(sessionId, { type: 'rtc-offer', sdp: tunedSdp });

    // Apply bitrate/framerate caps once connected. maxBitrate is the SHARED
    // per-screen slice (ceiling ÷ live screens), so the streams never fight for
    // more than the link can carry.
    const sender = transceiver.sender;
    const applyParams = async () => {
      try {
        const params = sender.getParameters();
        params.encodings = params.encodings?.length ? params.encodings : [{}];
        params.encodings[0].maxBitrate = this.effectiveBitrateMbps(session) * 1_000_000;
        params.encodings[0].maxFramerate = fps;
        params.encodings[0].scaleResolutionDownBy = scaleFor(captureHeight, maxHeight);
        (params.encodings[0] as any).priority = 'high';
        (params.encodings[0] as any).networkPriority = 'high';
        (params as any).degradationPreference = degradationFor(mode);
        await sender.setParameters(params);
      } catch (err) { console.warn('setParameters failed', err); }
    };
    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'connected') applyParams();
    });

    // A new screen just joined the shared budget: tighten every already-running
    // screen's slice now, so the aggregate stays within the link instead of
    // over-committing until each stream happens to re-apply on its own.
    this.rebalanceBitrates();
  }

  private onChannelMessage(sessionId: string, data: any) {
    try {
      const msg = JSON.parse(String(data));
      if (msg.t === 'clip') {
        this.lastClip = msg.s;
        warp.setClipboard(msg.s);
      } else if (msg.t === 'cfg') {
        this.applyConfig(sessionId, msg);
      } else {
        // Everything else is an input event; displayId is attached client-side
        warp.injectInput(msg);
      }
    } catch { /* ignore */ }
  }

  // Live quality changes from the client's in-stream menu.
  private async applyConfig(sessionId: string, cfg: any) {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    try {
      if (s.track && cfg.mode) {
        s.track.contentHint = cfg.mode === 'smooth' ? 'motion' : 'detail';
      }
      if (s.sender) {
        const params = s.sender.getParameters();
        params.encodings = params.encodings?.length ? params.encodings : [{}];
        // Live bitrate change updates this screen's requested ceiling. A manual
        // change is an explicit user action, so reset the adaptive cap to the new
        // share (try what they asked) and clear the loss history so we don't cut
        // on stale readings; the loop pulls back again if the link can't hold it.
        if (cfg.bitrate) {
          s.reqBitrate = Number(cfg.bitrate) || s.reqBitrate;
          s.adaptCapMbps = this.perStreamBitrateMbps(s);
          s.lossEwma = 0; s.stableTicks = 0; s.holdTicks = 0; s.coolTicks = 0;
          params.encodings[0].maxBitrate = this.effectiveBitrateMbps(s) * 1_000_000;
        }
        // Clamp to the screen-capture ceiling — the capturer can't exceed it, so
        // asking for more only invites throttling (see MAX_CAPTURE_FPS).
        if (cfg.fps) {
          params.encodings[0].maxFramerate = Math.min(Number(cfg.fps), MAX_CAPTURE_FPS);
        }
        // Live resolution cap: fewer pixels to encode/transmit/decode is the
        // biggest latency lever on a high-DPI host.
        if (cfg.maxHeight !== undefined) {
          params.encodings[0].scaleResolutionDownBy =
            scaleFor(s.captureHeight, Number(cfg.maxHeight) || 0);
        }
        // Keep the sacrifice-order aligned with the live picture-mode switch.
        if (cfg.mode) (params as any).degradationPreference = degradationFor(cfg.mode);
        await s.sender.setParameters(params);
      }
      if (s.track && cfg.fps) {
        await s.track.applyConstraints({
          frameRate: { max: Math.min(Number(cfg.fps), MAX_CAPTURE_FPS) },
        });
      }
    } catch (err) { console.warn('applyConfig failed', err); }
  }

  // System audio from a dedicated input device (e.g. a BlackHole virtual
  // device). The 'auto' loopback path is handled inside startScreen, where
  // audio is captured together with the video in a single stream.
  private async captureSystemAudio(deviceId: string): Promise<MediaStream | null> {
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: { exact: deviceId },
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 2,
        },
      });
    } catch (err) {
      console.warn('system audio capture unavailable:', err);
      return null;
    }
  }

  stopScreen(sessionId: string) {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    this.sessions.delete(sessionId);
    try { s.channel?.close(); } catch { /* ignore */ }
    try { s.fastChannel?.close(); } catch { /* ignore */ }
    try { s.pc.close(); } catch { /* ignore */ }
    s.stream?.getTracks().forEach((t) => t.stop());
    s.audioStream?.getTracks().forEach((t) => t.stop());
    if (s.micPlayer) { s.micPlayer.pause(); s.micPlayer.srcObject = null; }
    warp.injectInput({ t: 'reset' });
    // A screen left the shared budget — widen the remaining screens' slices back
    // out so a lone survivor gets the full ceiling again.
    this.rebalanceBitrates();
  }

  stopAll() {
    for (const id of [...this.sessions.keys()]) this.stopScreen(id);
  }
}

// Auto-detect a virtual loopback audio device (the Sunshine/OBS approach for
// macOS system audio): BlackHole, Loopback, Soundflower, VB-Cable, …
async function findVirtualAudioDevice(): Promise<string | null> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const virtual = devices.find((d) =>
      d.kind === 'audioinput' &&
      /blackhole|loopback|soundflower|vb-?cable|virtual/i.test(d.label));
    if (virtual) console.log(`system audio via virtual device: ${virtual.label}`);
    return virtual?.deviceId ?? null;
  } catch { return null; }
}

// Downscale factor to cap the encoded height at `maxHeight` (0/native = 1).
// Fewer pixels to encode, transmit and decode is the single biggest lever on
// latency and encoder overload — a Retina/4K/5K host pushing native pixels at a
// high frame rate saturates even the hardware encoder, so frames queue and the
// felt latency grows. Returns a divisor for scaleResolutionDownBy.
function scaleFor(captureHeight: number, maxHeight: number): number {
  if (!maxHeight || maxHeight <= 0 || captureHeight <= maxHeight) return 1;
  return captureHeight / maxHeight;
}

// Under network/CPU constraint, decide what to sacrifice first. 'smooth'
// (gaming/video) holds the frame rate and lets resolution soften. 'sharp'
// (desktop/text) uses 'balanced': it sheds a little of both resolution and
// frame rate so a transient WiFi hiccup recovers in a frame or two instead of
// stalling on full-resolution frames — which is what reads as a lag spike.
function degradationFor(mode: string): 'balanced' | 'maintain-framerate' {
  return mode === 'smooth' ? 'maintain-framerate' : 'balanced';
}

// Widen the video encoder's bitrate envelope directly in the offer SDP. This
// is the real quality/bandwidth/latency lever:
//   • Chromium silently caps WebRTC video near ~2 Mbps unless the SDP raises
//     it — setParameters(maxBitrate) alone is not enough on every path, so we
//     set b=AS / b=TIAS AND x-google-max-bitrate.
//   • start-bitrate high → the first frames are already sharp (no multi-second
//     ramp-up that reads as "blurry / laggy" on connect).
//   • min-bitrate low → a static desktop sends almost nothing (true VBR), so
//     bandwidth stays minimal until motion or detail actually needs it.
// The result: barely any bandwidth on a still screen, up to the full user cap
// (e.g. 200 Mbps) the instant something moves, with no quality ramp delay.
function tuneVideoSdp(sdp: string, maxMbps: number, shareCount = 1): string {
  const maxKbps = Math.max(1000, Math.round(maxMbps * 1000));
  // Start high-but-safe, NOT at the full ceiling. Blasting e.g. 200 Mbps on the
  // very first frames bursts the link; if it can't sustain that, congestion
  // control collapses the bitrate and spikes latency for a second or two before
  // recovering — exactly the "laggy + low quality right when I connect" feel.
  // ~30 Mbps is already crisp for desktop/text immediately, and GCC climbs to
  // the real ceiling within about a second on a link that can carry it. With
  // several screens connecting at once we divide the start burst between them so
  // the combined first-frame burst still fits the link (no 3-monitor collapse).
  const share = Math.max(1, shareCount);
  const startKbps = Math.max(4000, Math.round(Math.min(maxKbps, 30000) / share));
  const minKbps = 500;                          // sip bandwidth when idle (VBR floor)

  const lines = sdp.split(/\r?\n/);
  const videoPts = new Set<string>();
  for (const l of lines) {
    if (l.startsWith('m=video')) l.split(' ').slice(3).forEach((pt) => videoPts.add(pt));
  }

  const out: string[] = [];
  let inVideo = false;
  for (const l of lines) {
    if (l.startsWith('m=')) inVideo = l.startsWith('m=video');
    // Never negotiate the color-space RTP header extension: when present it can
    // knock Chromium's receiver off hardware decode onto the software FFmpeg
    // decoder (documented on NVIDIA), which is the classic cause of janky,
    // lagging animation at high resolution. We stream SDR desktops, so the HDR
    // color metadata it carries buys nothing — dropping it keeps decode on the
    // GPU (D3D11VA/NVDEC).
    if (inVideo && l.includes('rtp-hdrext/color-space')) continue;
    out.push(l);
    // Bandwidth lines belong right after the section's c= line (m,c,b,a order).
    if (inVideo && l.startsWith('c=')) {
      out.push(`b=AS:${maxKbps}`);
      out.push(`b=TIAS:${maxKbps * 1000}`);
    }
    if (inVideo && l.startsWith('a=fmtp:')) {
      const pt = l.slice('a=fmtp:'.length).split(' ')[0];
      if (videoPts.has(pt) && !l.includes('x-google-max-bitrate')) {
        out[out.length - 1] = l +
          `;x-google-start-bitrate=${startKbps}` +
          `;x-google-min-bitrate=${minKbps}` +
          `;x-google-max-bitrate=${maxKbps}`;
      }
    }
  }
  return out.join('\r\n');
}

function preferCodec(transceiver: RTCRtpTransceiver, codec: string) {
  const mime = codec === 'av1' ? 'video/av1' : codec === 'vp9' ? 'video/vp9'
    : codec === 'hevc' ? 'video/h265' : 'video/h264';
  try {
    // setCodecPreferences requires a subset of the *receiver* capabilities.
    const caps = RTCRtpReceiver.getCapabilities('video');
    if (!caps) return;
    const isH264 = mime === 'video/h264';
    const preferred = caps.codecs.filter((c) => c.mimeType.toLowerCase() === mime);
    // For H.264, put High profile (level-idc 64xxxx) ahead of Constrained
    // Baseline (42xxxx). High profile compresses far more efficiently — same
    // bitrate yields a visibly sharper picture, which matters most for text.
    if (isH264 && preferred.length > 1) {
      const rank = (p: string | undefined) => {
        const m = p ? /profile-level-id=([0-9a-f]{6})/i.exec(p) : null;
        const prof = m ? m[1].slice(0, 2) : 'ff';
        return prof === '64' ? 0 : prof === '4e' ? 1 : prof === '42' ? 2 : 3;
      };
      preferred.sort((a, b) => rank(a.sdpFmtpLine) - rank(b.sdpFmtpLine));
    }
    const rest = caps.codecs.filter((c) => c.mimeType.toLowerCase() !== mime);
    if (preferred.length) transceiver.setCodecPreferences([...preferred, ...rest]);
  } catch { /* codec preference is best-effort */ }
}

const hostEngine = new HostEngine();

// ---------------------------------------------------------------------------
// Computers page (client side)

interface HostEntry { hostId: string; name: string; ip: string; port: number; platform: string; displays: number }

function renderHosts(hosts: HostEntry[]) {
  const grid = $('#computersGrid');
  grid.innerHTML = '';
  $('#computersEmpty').style.display = hosts.length ? 'none' : 'block';
  for (const h of hosts) {
    const card = document.createElement('div');
    card.className = 'computer-card';
    card.innerHTML = `
      <div class="screen-art">🖥</div>
      <div class="name"></div>
      <div class="meta"></div>
      <div class="card-actions" style="margin-top: 10px; display: flex; justify-content: flex-end; gap: 8px;">
        <button class="btn secondary small configure-btn" style="display: none;">Configure</button>
      </div>`;
    card.querySelector('.name')!.textContent = h.name;
    card.querySelector('.meta')!.textContent =
      `${h.ip} · ${h.displays} display(s) · ${h.platform === 'darwin' ? 'macOS' : h.platform}`;
    
    const isPaired = localStorage.getItem(`paired:${h.hostId}`) === '1';
    const configBtn = card.querySelector('.configure-btn') as HTMLButtonElement;
    if (isPaired && configBtn) {
      configBtn.style.display = 'inline-flex';
      configBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openConnectModal(h.ip, h.port, h.name, h.hostId, true);
      });
    }

    card.addEventListener('click', () => openConnectModal(h.ip, h.port, h.name, h.hostId, false));
    grid.appendChild(card);
  }
}

warp.onDiscoveredHosts(renderHosts);
warp.getDiscoveredHosts().then(renderHosts);

$('#manualConnectBtn').addEventListener('click', () => {
  const host = ($('#manualHost') as HTMLInputElement).value.trim();
  const port = Number(($('#manualPort') as HTMLInputElement).value) || 9750;
  if (!host) { toast('Enter a host address', true); return; }
  openConnectModal(host, port, host, `manual-${host}`);
});

// ---------------------------------------------------------------------------
// Connect modal & screen mapping

interface RemoteDisplay { id: number; label: string; width: number; height: number; refreshRate?: number; primary: boolean; virtual: boolean }

let cm = {
  host: '', port: 9750, name: '', hostId: '',
  ws: null as WebSocket | null,
  displays: [] as RemoteDisplay[],
  localMonitors: [] as any[],
  reqSeq: 1,
  pendingVd: new Map<number, (res: any) => void>(),
};

// Stable per-installation identity so the host can remember this client
// after the first successful pairing and skip the code on later connects.
function clientId(): string {
  let id = localStorage.getItem('warp:clientId');
  if (!id) {
    // This id is a persistent bearer credential (a trusted client skips the
    // pairing code), so it must be unguessable — never Math.random.
    id = crypto.randomUUID?.() ??
      [...crypto.getRandomValues(new Uint8Array(16))]
        .map((b) => b.toString(16).padStart(2, '0')).join('');
    localStorage.setItem('warp:clientId', id);
  }
  return id;
}

let forceConfigure = false;

function openConnectModal(host: string, port: number, name: string, hostId: string, forceConfig = false) {
  cm.host = host; cm.port = port; cm.name = name; cm.hostId = hostId;
  $('#cmTitle').textContent = `Connect to ${name}`;
  $('#connectModal').classList.add('visible');
  forceConfigure = forceConfig;

  if (localStorage.getItem(`paired:${hostId}`) === '1') {
    // Already paired with this host before — skip the code prompt and
    // reconnect automatically. The host trusts our clientId.
    $('#cmStepCode').style.display = 'none';
    $('#cmStepScreens').style.display = 'none';
    $('#cmSub').textContent = forceConfig ? 'Connecting for configuration…' : 'Reconnecting…';
    runConnect('').catch(() => {
      // Host no longer trusts this client (e.g. its paired-devices list was
      // cleared) — fall back to asking for the pairing code again.
      localStorage.removeItem(`paired:${hostId}`);
      showCodeStep();
    });
    return;
  }
  showCodeStep();
}

function showCodeStep() {
  $('#cmTitle').textContent = `Connect to ${cm.name}`;
  $('#cmSub').textContent = 'Enter the pairing code shown on the host.';
  $('#cmStepCode').style.display = 'block';
  $('#cmStepScreens').style.display = 'none';
  ($('#cmCode') as HTMLInputElement).value = localStorage.getItem(`code:${cm.hostId}`) || '';
  ($('#cmCode') as HTMLInputElement).focus();
}

function closeConnectModal() {
  $('#connectModal').classList.remove('visible');
  if (cm.ws) { cm.ws.onclose = null; cm.ws.close(); cm.ws = null; }
}

$('#cmCancelBtn').addEventListener('click', closeConnectModal);
$('#cmBackBtn').addEventListener('click', closeConnectModal);
($('#cmCode') as HTMLInputElement).addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#cmConnectBtn').click();
});

// Open the WebSocket, send `hello` (with code + clientId), await `welcome`,
// and advance the modal to the screen-mapping step. Throws on auth failure /
// connection errors so the caller can decide whether to fall back to the
// code-entry step.
async function runConnect(code: string): Promise<void> {
  const btn = $('#cmConnectBtn') as HTMLButtonElement;
  btn.disabled = true;
  try {
    const ws = new WebSocket(`ws://${cm.host}:${cm.port}`);
    cm.ws = ws;
    const welcome: any = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Connection timed out')), 8000);
      ws.onopen = () => ws.send(JSON.stringify({
        type: 'hello', code, clientId: clientId(), name: 'warp-client',
      }));
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === 'welcome') { clearTimeout(timer); resolve(msg); }
        if (msg.type === 'auth-failed') { clearTimeout(timer); reject(new Error('Wrong pairing code')); }
      };
      ws.onerror = () => { clearTimeout(timer); reject(new Error('Could not reach host')); };
      ws.onclose = () => { clearTimeout(timer); reject(new Error('Connection closed')); };
    });

    // Remember both the pairing (so we skip the prompt next time) and the
    // code (as a fallback if the host ever forgets this client).
    localStorage.setItem(`paired:${cm.hostId}`, '1');
    if (code) localStorage.setItem(`code:${cm.hostId}`, code);

    cm.displays = welcome.displays;
    ws.onclose = () => { toast('Host connection lost', true); };
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'displays') { cm.displays = msg.displays; renderMapRows(); }
      if (msg.type === 'vdisplay-result' && cm.pendingVd.has(msg.reqId)) {
        cm.pendingVd.get(msg.reqId)!(msg);
        cm.pendingVd.delete(msg.reqId);
      }
    };

    cm.localMonitors = await warp.getLocalDisplays();

    // Reconnecting to a host we've configured before: restore the saved
    // arrangement without asking. The saved mapping is resolved by monitor
    // *identity* (attributes), not by array index or raw display id — both of
    // which drift across a reboot — so "which monitor showed what" survives even
    // a day later when macOS has reshuffled its display IDs. If nothing resolves
    // (the whole setup changed), fall through to the mapping dialog.
    const saved = loadSavedMapping();
    const isReconnect = !code;
    if (saved && isReconnect && !forceConfigure) {
      const resolved = resolveSavedSlots(saved);
      const slots = [...resolved.entries()]
        .filter(([, v]) => v.choice !== 'none')
        .map(([monIndex, v]) => ({ monIndex, choice: v.choice, res: v.res, fps: v.fps }));
      if (slots.length) {
        $('#cmSub').textContent = 'Starting streams…';
        await startStreamingWithSlots(slots, false);
        return;
      }
    }

    $('#cmTitle').textContent = `Screens on ${welcome.hostName}`;
    $('#cmSub').textContent = 'Choose what each of your monitors shows.';
    $('#cmStepCode').style.display = 'none';
    $('#cmStepScreens').style.display = 'block';
    renderMapRows();
  } catch (err) {
    if (cm.ws) { cm.ws.onclose = null; cm.ws.close(); cm.ws = null; }
    throw err;
  } finally {
    btn.disabled = false;
  }
}

$('#cmConnectBtn').addEventListener('click', async () => {
  const code = ($('#cmCode') as HTMLInputElement).value.trim();
  if (!/^\d{4,8}$/.test(code)) { toast('Enter the numeric pairing code', true); return; }
  try { await runConnect(code); }
  catch (err: any) { toast(err.message, true); }
});

const RESOLUTIONS = ['1920x1080', '2560x1440', '3440x1440', '3840x2160'];

// Frame rates offered per monitor. Capped at BOTH the panel's refresh rate and
// MAX_CAPTURE_FPS — macOS screen capture can't exceed ~60 fps, so offering 120/
// 165 would just be a number the host silently clamps (the "I set 165 but see
// 30" confusion). When a native path lifts the capture ceiling, raise the cap.
const FPS_LADDER = [24, 30, 48, 50, 60, 75, 90, 100, 120, 144, 165, 200, 240, 360];

function fpsOptionsFor(refreshRate: number): number[] {
  const native = Math.min(Math.round(refreshRate) || 60, MAX_CAPTURE_FPS);
  const set = new Set(FPS_LADDER.filter((f) => f <= native));
  set.add(Math.min(60, MAX_CAPTURE_FPS)); // always a safe baseline
  set.add(native);                        // the panel's exact rate (capped)
  return [...set].sort((a, b) => a - b);
}

// A saved mapping is stored per host. Each slot records BOTH the local monitor
// it applies to and what that monitor should show — described by stable
// attributes (label, resolution, position, primary) rather than the volatile
// numeric ids that macOS/Windows reassign across reboots. That is what lets the
// arrangement survive "a day later": we re-match by identity, not by id/index.
interface MonRef { label: string; w: number; h: number; x: number; y: number; primary: boolean }
interface HostRef {
  id: number; label: string; width: number; height: number;
  primary: boolean; virtual: boolean; refreshRate?: number;
}
// kind: 'host' = an existing host display (matched by attributes), 'new' = a
// virtual display we recreate each session, 'none' = this monitor is unused.
interface SavedSlot {
  mon: MonRef;
  kind: 'host' | 'new' | 'none';
  host?: HostRef;
  res: string;
  fps: string;
}
interface SavedMapping { version: 2; slots: SavedSlot[] }

function monRefOf(mon: any): MonRef {
  return {
    label: String(mon.label || ''),
    w: mon.width, h: mon.height,
    x: mon.bounds?.x ?? 0, y: mon.bounds?.y ?? 0,
    primary: !!mon.primary,
  };
}

// How strongly a saved local-monitor ref matches a current monitor. Same size is
// the anchor; matching label and exact position add confidence so two identical
// panels are told apart by where they sit.
function scoreMon(a: MonRef, b: MonRef): number {
  let s = 0;
  if (a.label && a.label === b.label) s += 3;
  if (a.w === b.w && a.h === b.h) s += 3;
  if (a.x === b.x && a.y === b.y) s += 2;
  if (a.primary === b.primary) s += 1;
  return s;
}

// How strongly a saved host-display ref matches a current host display. Label is
// the best signal (survives id churn); resolution anchors it; primary/refresh
// break ties between identical panels.
function scoreHost(ref: HostRef, d: RemoteDisplay): number {
  let s = 0;
  if (ref.label && ref.label === d.label) s += 4;
  if (ref.width === d.width && ref.height === d.height) s += 3;
  if (ref.primary === !!d.primary) s += 1;
  if (ref.refreshRate && d.refreshRate && ref.refreshRate === d.refreshRate) s += 1;
  return s;
}

function loadSavedMapping(): SavedMapping | null {
  try {
    const raw = localStorage.getItem(`map:${cm.hostId}`);
    if (!raw) return null;
    const m = JSON.parse(raw);
    if (m && m.version === 2 && Array.isArray(m.slots)) return m as SavedMapping;
    // A pre-v2 mapping (index/id based). Upgrade it in place to the identity
    // schema so existing users keep their arrangement without reconfiguring —
    // as long as every slot is recoverable (virtual/unused, or a host display
    // that's still present so we can capture its attributes). If any slot points
    // at a physical display whose id is already stale, we can't recover its
    // identity, so we bail to the mapping dialog for a one-time reconfigure.
    return migrateLegacyMapping(m);
  } catch { return null; }
}

// Best-effort upgrade of the old { monCount, slots:[{choice,res,fps}] } mapping,
// paired by index with the current monitors, to the stable v2 schema.
function migrateLegacyMapping(old: any): SavedMapping | null {
  if (!old || !Array.isArray(old.slots) || !old.slots.length) return null;
  const slots: SavedSlot[] = [];
  for (let i = 0; i < old.slots.length; i++) {
    const s = old.slots[i];
    const mon = cm.localMonitors[i];
    if (!mon) continue; // fewer monitors now — drop the extra slot
    const monRef = monRefOf(mon);
    const res = s.res || 'auto';
    const fps = s.fps || '60';
    if (s.choice === 'none') { slots.push({ mon: monRef, kind: 'none', res, fps }); continue; }
    if (s.choice === 'new') { slots.push({ mon: monRef, kind: 'new', res, fps }); continue; }
    const d = cm.displays.find((dd) => String(dd.id) === String(s.choice));
    if (!d) return null; // stale physical id, identity unrecoverable → reconfigure
    slots.push({
      mon: monRef, kind: 'host', res, fps,
      host: { id: d.id, label: d.label, width: d.width, height: d.height,
        primary: !!d.primary, virtual: !!d.virtual, refreshRate: d.refreshRate },
    });
  }
  if (!slots.length) return null;
  const migrated: SavedMapping = { version: 2, slots };
  try { localStorage.setItem(`map:${cm.hostId}`, JSON.stringify(migrated)); } catch { /* ignore */ }
  return migrated;
}

// Resolve a saved host reference to a concrete choice value for the current
// session: a live host display's id, 'new' (recreate a virtual display), or
// 'none' if the referenced physical display is simply gone. `used` holds the
// host display ids already claimed by earlier slots, so two saved slots can't
// both grab the same physical display (which would happen with two identical
// unlabeled monitors) — the second falls through to the next-best match.
function resolveHostChoice(slot: SavedSlot, used?: Set<number>): string {
  if (slot.kind === 'new') return 'new';
  if (slot.kind === 'none' || !slot.host) return 'none';
  let best: RemoteDisplay | null = null;
  let bestScore = 0;
  for (const d of cm.displays) {
    if (used?.has(d.id)) continue;
    const sc = scoreHost(slot.host, d);
    if (sc > bestScore) { bestScore = sc; best = d; }
  }
  if (best && bestScore >= 3) { // size- or label-level match
    used?.add(best.id);
    return String(best.id);
  }
  // The saved target is absent. A virtual display we made before can just be
  // recreated; a real monitor that's unplugged is left unused.
  return slot.host.virtual ? 'new' : 'none';
}

// Match each current local monitor to at most one saved slot by identity, then
// translate that slot into { choice, res, fps }. Greedy on the strongest matches
// first so two identical monitors don't steal each other's slot. Returns a map
// keyed by the current monitor's index.
function resolveSavedSlots(saved: SavedMapping): Map<number, { choice: string; res: string; fps: string }> {
  const out = new Map<number, { choice: string; res: string; fps: string }>();
  const pairs: { mi: number; si: number; score: number }[] = [];
  cm.localMonitors.forEach((mon, mi) => {
    const mref = monRefOf(mon);
    saved.slots.forEach((slot, si) => {
      const score = scoreMon(mref, slot.mon);
      if (score >= 3) pairs.push({ mi, si, score }); // require at least size or label
    });
  });
  pairs.sort((a, b) => b.score - a.score);
  const usedMon = new Set<number>();
  const usedSlot = new Set<number>();
  const usedHostIds = new Set<number>();
  for (const p of pairs) {
    if (usedMon.has(p.mi) || usedSlot.has(p.si)) continue;
    usedMon.add(p.mi); usedSlot.add(p.si);
    const slot = saved.slots[p.si];
    out.set(p.mi, {
      choice: resolveHostChoice(slot, usedHostIds),
      res: slot.res || 'auto',
      fps: slot.fps || '60',
    });
  }
  return out;
}

function renderMapRows() {
  const rows = $('#cmMapRows');
  const prevChoice = [...rows.querySelectorAll('select.sel-display')]
    .map((s) => (s as HTMLSelectElement).value);
  const prevRes = [...rows.querySelectorAll('select.sel-res')]
    .map((s) => (s as HTMLSelectElement).value);
  const prevFps = [...rows.querySelectorAll('select.sel-fps')]
    .map((s) => (s as HTMLSelectElement).value);
  const saved = prevChoice.length ? null : loadSavedMapping();
  // Resolve the saved arrangement to THIS session's monitors/displays by
  // identity, so the dialog pre-selects the same choices it will actually
  // restore — even after ids/indices shifted overnight.
  const resolved = saved ? resolveSavedSlots(saved) : null;
  rows.innerHTML = '';

  cm.localMonitors.forEach((mon, i) => {
    const refreshRate = Math.round(mon.refreshRate) || 60;
    const row = document.createElement('div');
    row.className = 'map-row';
    const monDiv = document.createElement('div');
    monDiv.className = 'mon';
    monDiv.innerHTML = `Monitor ${i + 1}${mon.primary ? ' ★' : ''}<small></small>`;
    monDiv.querySelector('small')!.textContent =
      `${mon.width} × ${mon.height} · ${refreshRate} Hz`;

    const right = document.createElement('div');
    right.style.display = 'flex';
    right.style.flexDirection = 'column';
    right.style.gap = '6px';

    const select = document.createElement('select');
    select.className = 'sel-display';
    select.dataset.monIndex = String(i);
    select.add(new Option('— not used —', 'none'));
    for (const d of cm.displays) {
      const tagBits = [d.primary ? 'primary' : '', d.virtual ? 'virtual' : ''].filter(Boolean).join(', ');
      const hz = d.refreshRate ? ` @ ${d.refreshRate}Hz` : '';
      const label = `${d.label} (${d.width}×${d.height}${hz}${tagBits ? ', ' + tagBits : ''})`;
      select.add(new Option(label, String(d.id)));
    }
    select.add(new Option('✦ New virtual display', 'new'));

    const resSelect = document.createElement('select');
    resSelect.className = 'sel-res';
    resSelect.add(new Option(`Auto — match monitor (${mon.width}×${mon.height})`, 'auto'));
    for (const r of RESOLUTIONS) {
      resSelect.add(new Option(r.replace('x', ' × '), r));
    }

    // Per-monitor frame rate: options capped at this panel's native refresh
    // rate, defaulting to it (a 165 Hz monitor streams at 165 fps by default).
    const fpsSelect = document.createElement('select');
    fpsSelect.className = 'sel-fps';
    for (const f of fpsOptionsFor(refreshRate)) {
      const label = f === refreshRate ? `${f} fps (native)` : `${f} fps`;
      fpsSelect.add(new Option(label, String(f)));
    }

    // Restore: in-dialog state > resolved saved mapping > default (all virtual,
    // auto). The saved values are resolved by identity (resolveSavedSlots), so a
    // reboot that renumbered displays still lands on the right choice here.
    const rs = resolved?.get(i);
    const wantedChoice = prevChoice[i] ?? rs?.choice ?? 'new';
    select.value = wantedChoice;
    if (select.value !== wantedChoice) select.value = 'new'; // stale display id
    resSelect.value = prevRes[i] ?? rs?.res ?? 'auto';
    if (!resSelect.value) resSelect.value = 'auto';
    const defaultFps = String(Math.min(refreshRate, MAX_CAPTURE_FPS));
    fpsSelect.value = prevFps[i] ?? rs?.fps ?? defaultFps;
    if (!fpsSelect.value) fpsSelect.value = defaultFps;

    const syncResVisibility = () => {
      resSelect.style.display = select.value === 'new' ? 'block' : 'none';
    };
    select.addEventListener('change', syncResVisibility);
    syncResVisibility();

    right.appendChild(select);
    right.appendChild(resSelect);
    right.appendChild(fpsSelect);
    row.appendChild(monDiv);
    row.appendChild(right);
    rows.appendChild(row);
  });
}

function createVdisplayOverWs(width: number, height: number, hz: number): Promise<any> {
  return new Promise((resolve) => {
    const reqId = cm.reqSeq++;
    cm.pendingVd.set(reqId, resolve);
    // hz is the client monitor's target frame rate — the virtual display is
    // created at that refresh rate so the host can capture it at e.g. 165 fps.
    cm.ws!.send(JSON.stringify({ type: 'create-vdisplay', reqId, width, height, hz, hidpi: false }));
    setTimeout(() => {
      if (cm.pendingVd.has(reqId)) {
        cm.pendingVd.delete(reqId);
        resolve({ ok: false, error: 'timeout creating virtual display' });
      }
    }, 10000);
  });
}

async function startStreamingWithSlots(
  slots: { monIndex: number; choice: string; res: string; fps: string }[],
  persist = true,
) {
  const wanted = slots.filter((w) => w.choice !== 'none');
  if (!wanted.length) { toast('Select at least one screen', true); return; }

  const screens: { displayId: number; targetDisplayId: number; label: string; fps: number }[] = [];
  for (const w of wanted) {
    const mon = cm.localMonitors[w.monIndex];
    const fps = Number(w.fps) || Math.round(mon.refreshRate) || 60;
    let displayId: number;

    let choice = w.choice;
    if (choice !== 'new' && choice !== 'none') {
      const exists = cm.displays.some((d) => String(d.id) === choice);
      if (!exists) choice = 'new'; // stale display ID fallback
    }

    if (choice === 'new') {
      let width = mon.width, height = mon.height;
      if (w.res !== 'auto') {
        const [rw, rh] = w.res.split('x').map(Number);
        if (rw && rh) { width = rw; height = rh; }
      }
      const res = await createVdisplayOverWs(width, height, fps);
      if (!res.ok) throw new Error(res.error || 'Could not create virtual display');
      displayId = res.displayId;
    } else {
      displayId = Number(choice);
    }
    screens.push({
      displayId,
      targetDisplayId: mon.id,
      label: `${cm.name} · screen ${screens.length + 1}`,
      fps,
    });
  }

  // Remember this setup so the next connect restores it automatically. Persist
  // ALL rows (including unused ones) keyed by stable monitor identity, and record
  // each chosen host display's attributes — never just its volatile id — so the
  // arrangement can be re-matched after a reboot. (Skipped when we're merely
  // replaying an already-saved mapping on auto-reconnect.)
  if (persist) {
    const savedSlots: SavedSlot[] = slots.map((s) => {
      const mon = cm.localMonitors[s.monIndex];
      const monRef = monRefOf(mon);
      if (s.choice === 'none') return { mon: monRef, kind: 'none', res: s.res, fps: s.fps };
      if (s.choice === 'new') return { mon: monRef, kind: 'new', res: s.res, fps: s.fps };
      const d = cm.displays.find((dd) => String(dd.id) === s.choice);
      const host: HostRef = d
        ? { id: d.id, label: d.label, width: d.width, height: d.height,
            primary: !!d.primary, virtual: !!d.virtual, refreshRate: d.refreshRate }
        : { id: Number(s.choice), label: '', width: mon.width, height: mon.height,
            primary: false, virtual: false };
      return { mon: monRef, kind: 'host', host, res: s.res, fps: s.fps };
    });
    localStorage.setItem(`map:${cm.hostId}`, JSON.stringify({
      version: 2, slots: savedSlots,
    } satisfies SavedMapping));
  }

  const code = localStorage.getItem(`code:${cm.hostId}`) || '';
  await warp.openViewers({ host: cm.host, port: cm.port, code, clientId: clientId(), screens });
  closeConnectModal();
  toast(`Streaming ${screens.length} screen(s) from ${cm.name}`);
}

$('#cmStartBtn').addEventListener('click', async () => {
  const rows = $('#cmMapRows');
  const displaySelects = [...rows.querySelectorAll('select.sel-display')] as HTMLSelectElement[];
  const resSelects = [...rows.querySelectorAll('select.sel-res')] as HTMLSelectElement[];
  const fpsSelects = [...rows.querySelectorAll('select.sel-fps')] as HTMLSelectElement[];

  const slots = displaySelects.map((s, i) => ({
    monIndex: Number(s.dataset.monIndex),
    choice: s.value,
    res: resSelects[i]?.value || 'auto',
    fps: fpsSelects[i]?.value || '60',
  }));

  const btn = $('#cmStartBtn') as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = 'Preparing…';

  try {
    await startStreamingWithSlots(slots);
  } catch (err: any) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Start streaming';
  }
});

// ---------------------------------------------------------------------------

loadSettingsUi();
warp.getHostState().then(renderHostState);
