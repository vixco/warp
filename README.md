# ⚡ Warp

Low-latency remote desktop streaming, Parsec-style. Host on **macOS**, connect
from **Windows** (or another Mac) — with full **multi-monitor** support,
including **virtual displays** so your Windows PC's 3 monitors can each show a
remote screen while your MacBook stays closed.

## How it works

- **Host (macOS)** captures each display and streams it over WebRTC with
  hardware H.264 encoding at the display's full physical resolution, 60 fps,
  up to 200 Mbps per screen, with a zero jitter-buffer receiver for the lowest
  possible latency.
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
3. In the screen mapping dialog every local monitor gets a dropdown:
   - Monitor 1 → the Mac's built-in/primary display
   - Monitor 2 → **New virtual display** (created at that monitor's resolution)
   - Monitor 3 → **New virtual display**
4. **Start streaming** — each monitor becomes a fullscreen remote screen.

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

- **Frame rate**: 30/60 fps
- **Max bitrate**: per-screen encoder cap (default 50 Mbps — raise it on a
  wired LAN for near-lossless quality)
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
  independent 60 fps streams.
- Input events carry normalized display-relative coordinates; the host maps
  them through `CGDisplayBounds`, so multi-display pointer routing is exact.

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
- Windows auto-update works with unsigned builds. macOS **requires a code
  signing certificate** for auto-install; unsigned Mac builds log the update
  and keep running — install the new dmg manually or add signing later.

### Opening the macOS dmg (no Apple Developer ID)

The CI build has no signing certificate, so it ad-hoc seals the `.app`
(`scripts/adhoc-sign.cjs`). macOS Gatekeeper still quarantines the download
because it isn't notarized — on first open you'll see "*Warp* cannot be
opened because the developer cannot be verified" (or "damaged"). Either:

- **Right-click** Warp.app → *Open* → *Open* in the dialog, **or**
- strip the quarantine flag once after dragging it to Applications:

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
