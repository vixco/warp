# ⚡ Warp

Low-latency remote desktop streaming, Parsec-style. Host on **macOS**, connect
from **Windows** (or another Mac) — with full **multi-monitor** support,
including **virtual displays** so your Windows PC's 3 monitors can each show a
remote screen while your MacBook stays closed.

## How it works

- **Host (macOS)** captures each display and streams it over WebRTC with
  hardware H.264 encoding at the display's full physical resolution, at a
  **per-monitor frame rate** (60 / 120 / 144 / 165 / 240 Hz — each screen its
  own), up to 200 Mbps per screen, with a zero jitter-buffer receiver for the
  lowest possible latency.
- **Client (Windows/macOS)** opens one fullscreen viewer window per monitor.
  Mouse, keyboard, scroll and clipboard are forwarded to the host over a
  WebRTC data channel.
- **Virtual displays** are created on the host with the private
  `CGVirtualDisplay` API — one per client monitor, matching its exact
  resolution — so you get real extra screens, not mirrors.
- **Discovery**: hosts announce themselves over UDP broadcast; they appear
  automatically in the client's *Computers* list. Manual `ip:port` connection
  is also supported.
- **Pairing**: a 6-digit code (random per session, or fixed in Settings).

## Requirements

| Role | OS | Notes |
|------|----|----|
| Host | macOS 13+ (Apple Silicon or Intel) | Xcode Command Line Tools to build the native helpers |
| Client | Windows 10/11 or macOS | No special permissions needed |

Both machines need Node.js 20+ **only for building**. Packaged installers run
standalone.

## Build & run (development)

```bash
npm install
npm start        # builds TypeScript + native helpers, launches the app
```

On Windows, `npm start` skips the native helpers automatically (they are
macOS-only, and only needed for hosting).

## Packaging installers

```bash
npm run dist:mac   # .dmg / .zip for the macOS host
npm run dist:win   # .exe (NSIS) / .zip for the Windows client
```

Artifacts land in `release/` (or `dist/`-adjacent folder configured by
electron-builder).

## First-time host setup (macOS)

1. Open Warp → **Host** tab → enable hosting.
2. Grant the two permissions shown in the Host tab:
   - **Screen recording** (System Settings → Privacy & Security → Screen Recording)
   - **Accessibility** (System Settings → Privacy & Security → Accessibility)
   Restart Warp after granting.
3. Note the pairing code and address.

## Connecting with 3 monitors (Windows)

1. Start Warp on the Windows PC. The Mac appears under **Computers**
   (same network), or connect manually with its IP.
2. Enter the pairing code.
3. In the screen mapping dialog every local monitor gets dropdowns:
   - **Which screen**: Monitor 1 → the Mac's built-in/primary display,
     Monitor 2 → **New virtual display** (created at that monitor's
     resolution), Monitor 3 → **New virtual display**
   - **Frame rate**: each monitor picks its own — options are capped at that
     panel's native refresh rate and default to it, so a 165 Hz monitor
     streams at 165 fps and a 60 Hz one at 60 fps. New virtual displays are
     created at the chosen refresh rate so the host can genuinely capture
     that fast.
4. **Start streaming** — each monitor becomes a fullscreen remote screen at
   its own frame rate.

### Closing the MacBook lid (clamshell)

- Keep the MacBook connected to **power**.
- Warp runs `caffeinate` while hosting so the machine stays awake.
- Because the virtual displays keep a "screen" active, the Mac keeps rendering
  with the lid closed. Tip: make a virtual display the primary display before
  closing the lid.

## In-stream hotkeys

| Keys | Action |
|------|--------|
| `Ctrl+Shift+F` | Toggle fullscreen for that viewer |
| `Ctrl+Shift+Q` | Disconnect that screen |
| Move mouse to top edge | Overlay with stats (resolution · fps · Mbps · ping) |

## Settings

- **Default frame rate**: fallback rate (30 / 60 / 90 / 120 / 144 / 165 / 240
  fps) used when a monitor doesn't pick its own. Per-monitor frame rate is
  chosen in the connect dialog and can be changed live in the in-stream menu
  (Ctrl+Shift+M).
- **Max bitrate**: per-screen VBR *ceiling* (default 200 Mbps). It's a cap,
  not a target — a still desktop sends almost nothing, and the stream only
  climbs toward the ceiling when motion or fine detail actually needs it, so
  quality is maximal while idle bandwidth stays minimal. Lower it only if your
  link can't sustain the peaks.
- **Codec**: H.264 (hardware, lowest latency), VP9, AV1
- **Retina virtual displays**: HiDPI mode (sharper, 4× encode cost)
- **Fixed pairing code** and host port (default 9750)

## Architecture

```
┌────────────── macOS host ──────────────┐      ┌────────── Windows client ─────────┐
│ Electron main: WS server :9750         │◄────►│ per-monitor viewer window          │
│  ├─ UDP announce :9751                 │  WS  │  ├─ WebSocket (signaling)          │
│  ├─ warp-vdisplay (CGVirtualDisplay)   │      │  ├─ RTCPeerConnection (H.264 vid)  │
│  └─ warp-input   (CGEvent injection)   │◄────►│  └─ data channel (input/clipboard) │
│ Renderer: per-session desktop capture  │ RTC  └────────────────────────────────────┘
│  └─ getDisplayMedia → addTrack         │
└────────────────────────────────────────┘
```

- One WebRTC peer connection **per screen** — three monitors = three
  independent streams, each at its own frame rate (e.g. a 240 Hz gaming
  monitor and a 60 Hz secondary side by side).
- Input events carry normalized display-relative coordinates; the host maps
  them through `CGDisplayBounds`, so multi-display pointer routing is exact.

## Latency & quality

Warp is tuned for the "maximum quality, minimal delay, minimal wasted
bandwidth" corner of the trade-off — the sweet spot on a wired LAN:

- **Wide VBR envelope.** The encoder's bitrate is set with a *low floor* and a
  *high ceiling* (`x-google-min/start/max-bitrate` written into the offer SDP,
  reinforced by `setParameters`). A static screen sends almost nothing; the
  moment something moves it ramps to the full ceiling. You get top quality
  without paying for it while the picture is still.
- **Instant sharp image.** A high *start bitrate* (~40 Mbps) means the first
  frames on connect are already crisp — no multi-second ramp-up that looks
  blurry and laggy.
- **Lifted Chromium cap.** WebRTC video is silently limited to ~2 Mbps unless
  the SDP raises it; Warp raises it so high bitrates actually take effect.
- **Zero jitter buffer.** The receiver renders frames immediately
  (`jitterBufferTarget = 0`, `playoutDelayHint = 0`) — no buffering delay,
  Parsec-style. Audio uses the same zero-buffer path.
- **Smart degradation.** Under pressure, *Sharp text* mode holds resolution and
  drops frames (readable text); *Smooth motion* mode holds frame rate and lets
  resolution soften (fluid gaming). Switchable live in the in-stream menu.
- **Hardware H.264** (VideoToolbox on the host, D3D/VT on the client) keeps
  encode/decode latency to a couple of milliseconds.

## Auto-updates

Every push to the repo triggers GitHub Actions (`.github/workflows/release.yml`),
which builds the macOS and Windows installers and publishes them as a GitHub
release versioned `0.1.<run>`. Installed apps check the release feed 15 seconds
after launch and every 15 minutes, download updates in the background, and
apply them on restart (tray menu → *Restart to update*, or automatically on
the next quit).

Notes:

- The GitHub repo must be **public** for clients to reach the update feed
  (private repos would require shipping a GitHub token with the app).
- Windows auto-update works with unsigned builds.
- macOS auto-update works with a **free self-signed certificate** (no Apple
  Developer ID). Run `bash scripts/gen-signing-cert.sh` once, then add the two
  printed values as repo secrets `MAC_CSC_LINK` and `MAC_CSC_KEY_PASSWORD`. CI
  signs every build with that cert; Squirrel.Mac accepts updates because each
  update's signature matches the running app's designated requirement (leaf
  cert hash — clients need no trust in the cert). Because the current ad-hoc
  build has a different signature, the **first** self-signed build must be
  installed manually once; every update after that is automatic.
- The first-download Gatekeeper quarantine ("Warp is damaged") is the only
  thing that still needs a paid Developer ID + notarization; it is unrelated to
  updating (clear it once with `xattr -cr ~/Downloads/Warp-*-arm64.dmg`).

### Opening the macOS dmg (no Apple Developer ID)

The CI build has no signing certificate, so it ad-hoc seals the `.app`
(`scripts/adhoc-sign.cjs`). The seal itself is valid — but because the app is
not *notarized* by Apple, macOS Gatekeeper quarantines the browser download and
refuses to open it. On Apple Silicon this shows up as "*Warp* is damaged and
can't be opened" (the right-click → *Open* bypass does **not** work for ad-hoc
apps there). Strip the quarantine flag once and it opens normally.

Easiest — clear it from the downloaded dmg **before** you open it, so the app
inside never inherits quarantine:

```sh
xattr -cr ~/Downloads/Warp-*-arm64.dmg
```

…then double-click the dmg, drag Warp to Applications, and launch. Alternatively
strip it from the installed app after dragging:

```sh
xattr -dr com.apple.quarantine /Applications/Warp.app
```

A paid Apple Developer ID + notarization would remove this step entirely.

## Audio passthrough

Warp streams audio in both directions on the first screen's connection, as a
stereo Opus track (up to 256 kbps, FEC on, jitter buffer forced to 0 for
minimal delay):

- **Host system audio → client speakers.** The client picks its output device
  under *Speakers* in the in-stream menu (Ctrl+Shift+M).
- **Client microphone → host.** The client picks its input device under
  *Microphone* in the same menu (default: Off). Live device switching uses
  `replaceTrack`, so no renegotiation/glitch.

### macOS system-audio capture

macOS has no built-in "record system audio" for third-party apps, so — exactly
like Sunshine/OBS — Warp captures system sound from a **virtual audio device**.
Install one (all free) and Warp auto-detects it:

- [BlackHole](https://existential.audio/blackhole/) (recommended), Loopback,
  Soundflower, or VB-Cable.

Then either:

1. Create a **Multi-Output Device** (Audio MIDI Setup) that plays to both your
   speakers and BlackHole — so you hear audio locally *and* it streams, or
2. Set BlackHole as system output (audio only streams, silent locally).

In Warp → Settings → *Audio (host)* you can also pick the source device
explicitly and choose where the client's microphone plays on the host (handy
for routing the remote mic into a meeting app via a virtual device).

If no virtual device is present, video/input still work; only system audio is
silent. The client microphone path needs no host-side driver.

## Current limitations

- Hosting is macOS-only (Windows/Linux hosting not yet implemented).
- For connections across the internet, forward TCP port 9750 (signaling);
  WebRTC uses STUN for the media path.
