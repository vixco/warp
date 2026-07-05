# Security Policy

## Threat model

Warp is designed for **streaming between machines you own on a trusted local
network** (home / office LAN), Parsec-style. It is *not* hardened for hostile or
shared networks, and should not be exposed directly to the public internet.

Concretely, when you host with Warp:

- Anyone who can reach the host's port (default `9750`) **and** knows the pairing
  code — or is a previously paired client — can control the host's mouse,
  keyboard and clipboard and view its screens.
- Signaling runs over plaintext WebSocket (`ws://`) on the LAN. The WebRTC
  media/data path itself is encrypted (DTLS-SRTP), but the pairing handshake and
  SDP are not. **Treat your LAN as the trust boundary.**

For access across the internet, tunnel Warp over a VPN (e.g.
WireGuard/Tailscale) rather than forwarding the port to the open internet.

## What is hardened

- **Pairing brute-force protection.** Wrong codes are rate-limited per source
  address with an escalating lockout, so the 6-digit code space can't be swept
  over the network.
- **Constant-time code comparison**, so a code can't be recovered from response
  timing.
- **Unguessable client identity.** The persistent per-client id — which lets a
  paired client skip the code on later connects — is generated with a CSPRNG.
- **Electron hardening.** Renderers run with `contextIsolation: true`,
  `nodeIntegration: false`, a `contextBridge` preload, no `webview` tag, and a
  Content-Security-Policy; no remote content is ever loaded.
- **Defensive input parsing.** The native input helper validates event type,
  key-code and button ranges and bounds its text buffers.

## Known limitations

- Signaling transport is not yet TLS (`wss://`) — planned. Until then, the LAN
  is the trust boundary (see above).
- Paired clients stay trusted until you reset the host's pairing settings; there
  is not yet a per-device revoke UI. To revoke all clients, clear
  `trustedClients` in the app's `settings.json` (in the app's userData
  directory) or change the pairing code.
- LAN discovery is an unauthenticated UDP broadcast (host name, IP and display
  count are visible to anyone on the LAN); this is inherent to zero-config
  discovery.

## Reporting a vulnerability

Please report security issues **privately** to **toshan@tovix.nl** rather than
opening a public issue. Include steps to reproduce and the affected version. We
aim to acknowledge reports within a few days and will coordinate a fix and
disclosure with you.

## Supported versions

Warp auto-updates to the latest release; only the latest published version is
supported. Please make sure you are up to date before reporting.
