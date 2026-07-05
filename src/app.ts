/// <reference path="./warp.d.ts" />
// Main window renderer: UI + host streaming engine + client connect flow.

const $ = <T extends HTMLElement = HTMLElement>(sel: string) =>
  document.querySelector(sel) as T;

const warp = window.warp;

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
  channel: RTCDataChannel | null;
  displayId: number;
  sender: RTCRtpSender | null;
  track: MediaStreamTrack | null;
  audioStream: MediaStream | null;   // system audio being sent to the client
  micPlayer: HTMLAudioElement | null; // client microphone played on the host
}

class HostEngine {
  sessions = new Map<string, HostSession>();

  constructor() {
    warp.onEngineMessage(({ sessionId, msg }) => this.handle(sessionId, msg));
    setInterval(() => this.syncClipboard(), 1500);
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
        case 'start-screen': return await this.startScreen(sessionId, msg);
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

    const fps = Number(msg.fps) || 60;
    const src = source as any;
    const hostSettings = await warp.getSettings();
    const wantAudio = !!msg.wantAudio;
    const audioSource = hostSettings.audioSource || 'auto';
    const useLoopback = wantAudio && hostSettings.audioEnabled !== false &&
      audioSource === 'auto';

    // Per-display capture, pinned to the display's physical pixel size so
    // Retina/HiDPI displays stream at full resolution. Each screen names its
    // own source id explicitly (chromeMediaSourceId) — no shared global slot,
    // so three concurrent screens never race for the wrong display. The real
    // OS cursor stays in the frames so the user sees the true macOS pointer
    // (arrow/beam/resize/hand) moving across every screen.
    let stream: MediaStream;
    try {
      stream = await (navigator.mediaDevices as any).getUserMedia({
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
      }) as MediaStream;
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
      pc, stream, channel: null, displayId, sender: null, track,
      audioStream: audioCapture, micPlayer: null,
    };
    this.sessions.set(sessionId, session);

    const channel = pc.createDataChannel('warp', { ordered: true });
    session.channel = channel;
    channel.onmessage = (e) => this.onChannelMessage(sessionId, e.data);

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

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    warp.toSession(sessionId, { type: 'rtc-offer', sdp: offer.sdp });

    // Apply bitrate/framerate caps once connected.
    const mbps = Number(msg.bitrate) || 150;
    const sender = transceiver.sender;
    const applyParams = async () => {
      try {
        const params = sender.getParameters();
        params.encodings = params.encodings?.length ? params.encodings : [{}];
        params.encodings[0].maxBitrate = mbps * 1_000_000;
        params.encodings[0].maxFramerate = fps;
        params.encodings[0].scaleResolutionDownBy = 1; // never downscale
        (params.encodings[0] as any).priority = 'high';
        (params.encodings[0] as any).networkPriority = 'high';
        // Under constraint, drop frames before dropping resolution (keeps
        // text sharp, like Parsec's constant-resolution stream).
        (params as any).degradationPreference = 'maintain-resolution';
        await sender.setParameters(params);
      } catch (err) { console.warn('setParameters failed', err); }
    };
    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'connected') applyParams();
    });
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
        if (cfg.bitrate) params.encodings[0].maxBitrate = Number(cfg.bitrate) * 1_000_000;
        if (cfg.fps) params.encodings[0].maxFramerate = Number(cfg.fps);
        await s.sender.setParameters(params);
      }
      if (s.track && cfg.fps) {
        await s.track.applyConstraints({ frameRate: { max: Number(cfg.fps) } });
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
    try { s.pc.close(); } catch { /* ignore */ }
    s.stream?.getTracks().forEach((t) => t.stop());
    s.audioStream?.getTracks().forEach((t) => t.stop());
    if (s.micPlayer) { s.micPlayer.pause(); s.micPlayer.srcObject = null; }
    warp.injectInput({ t: 'reset' });
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

function preferCodec(transceiver: RTCRtpTransceiver, codec: string) {
  const mime = codec === 'av1' ? 'video/av1' : codec === 'vp9' ? 'video/vp9' : 'video/h264';
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
      <div class="meta"></div>`;
    card.querySelector('.name')!.textContent = h.name;
    card.querySelector('.meta')!.textContent =
      `${h.ip} · ${h.displays} display(s) · ${h.platform === 'darwin' ? 'macOS' : h.platform}`;
    card.addEventListener('click', () => openConnectModal(h.ip, h.port, h.name, h.hostId));
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
    id = Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 8);
    localStorage.setItem('warp:clientId', id);
  }
  return id;
}

function openConnectModal(host: string, port: number, name: string, hostId: string) {
  cm.host = host; cm.port = port; cm.name = name; cm.hostId = hostId;
  $('#cmTitle').textContent = `Connect to ${name}`;
  $('#connectModal').classList.add('visible');

  if (localStorage.getItem(`paired:${hostId}`) === '1') {
    // Already paired with this host before — skip the code prompt and
    // reconnect automatically. The host trusts our clientId.
    $('#cmStepCode').style.display = 'none';
    $('#cmStepScreens').style.display = 'none';
    $('#cmSub').textContent = 'Reconnecting…';
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

// Standard frame rates we offer per monitor. The list shown for a given
// monitor is capped at its native refresh rate (you can't display more than
// the panel refreshes), and always includes the exact native rate plus 60 as
// a safe baseline — so a 165 Hz monitor offers up to 165, a 240 Hz up to 240.
const FPS_LADDER = [24, 30, 48, 50, 60, 75, 90, 100, 120, 144, 165, 200, 240, 360];

function fpsOptionsFor(refreshRate: number): number[] {
  const native = Math.round(refreshRate) || 60;
  const set = new Set(FPS_LADDER.filter((f) => f <= native));
  set.add(60);       // always a safe baseline
  set.add(native);   // always offer the panel's exact rate
  return [...set].sort((a, b) => a - b);
}

interface SavedMapping { monCount: number; slots: { choice: string; res: string; fps: string }[] }

function loadSavedMapping(): SavedMapping | null {
  try {
    const raw = localStorage.getItem(`map:${cm.hostId}`);
    if (!raw) return null;
    const m = JSON.parse(raw) as SavedMapping;
    return m.monCount === cm.localMonitors.length ? m : null;
  } catch { return null; }
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

    // Restore: in-dialog state > saved mapping > default (all virtual, auto).
    const wantedChoice = prevChoice[i] ?? saved?.slots[i]?.choice ?? 'new';
    select.value = wantedChoice;
    if (select.value !== wantedChoice) select.value = 'new'; // stale display id
    resSelect.value = prevRes[i] ?? saved?.slots[i]?.res ?? 'auto';
    if (!resSelect.value) resSelect.value = 'auto';
    fpsSelect.value = prevFps[i] ?? saved?.slots[i]?.fps ?? String(refreshRate);
    if (!fpsSelect.value) fpsSelect.value = String(refreshRate);

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
  const wanted = slots.filter((w) => w.choice !== 'none');

  if (!wanted.length) { toast('Select at least one screen', true); return; }
  const btn = $('#cmStartBtn') as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = 'Preparing…';

  try {
    const screens: { displayId: number; targetDisplayId: number; label: string; fps: number }[] = [];
    for (const w of wanted) {
      const mon = cm.localMonitors[w.monIndex];
      const fps = Number(w.fps) || Math.round(mon.refreshRate) || 60;
      let displayId: number;
      if (w.choice === 'new') {
        let width = mon.width, height = mon.height;
        if (w.res !== 'auto') {
          const [rw, rh] = w.res.split('x').map(Number);
          if (rw && rh) { width = rw; height = rh; }
        }
        // Create the virtual display at the chosen frame rate so the host can
        // actually capture it that fast (a 60 Hz display caps capture at 60).
        const res = await createVdisplayOverWs(width, height, fps);
        if (!res.ok) throw new Error(res.error || 'Could not create virtual display');
        displayId = res.displayId;
      } else {
        displayId = Number(w.choice);
      }
      screens.push({
        displayId,
        targetDisplayId: mon.id,
        label: `${cm.name} · screen ${screens.length + 1}`,
        fps,
      });
    }

    // Remember this setup so the next connect restores it automatically.
    localStorage.setItem(`map:${cm.hostId}`, JSON.stringify({
      monCount: cm.localMonitors.length,
      slots: slots.map(({ choice, res, fps }) => ({ choice, res, fps })),
    } satisfies SavedMapping));

    const code = localStorage.getItem(`code:${cm.hostId}`) || '';
    await warp.openViewers({ host: cm.host, port: cm.port, code, clientId: clientId(), screens });
    closeConnectModal();
    toast(`Streaming ${screens.length} screen(s) from ${cm.name}`);
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
