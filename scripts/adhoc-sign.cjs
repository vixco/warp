// electron-builder afterPack hook: seal the macOS .app with an ad-hoc
// signature when no real signing certificate is configured.
//
// electron-builder skips code signing (and skips the afterSign hook) when no
// "Developer ID Application" identity is present, leaving the bundle only
// *linker-signed*. On Apple Silicon (M1/M4) that produces the misleading
// "Warp is damaged and can't be opened" error — even after stripping the
// quarantine flag, because the bundle signature is invalid (unsealed
// resources). afterPack always runs, so we ad-hoc seal here with
// --deep --force, producing a *valid* sealed signature. That changes
// Gatekeeper's verdict from "damaged" (no bypass) to "unidentified developer"
// (right-click > Open works), and lets the `xattr -dr com.apple.quarantine`
// workaround actually succeed.
//
// We deliberately do NOT pass --options runtime (hardened runtime): that
// enables library validation, which crashes an ad-hoc-signed Electron app at
// launch ("mapping process and mapped file have different Team IDs") because
// the main executable and Electron Framework end up with mismatched
// identities. The linker-signed original has no hardened runtime either.
//
// If a real certificate is configured (CSC_LINK / CSC_KEY_PASSWORD),
// electron-builder will sign after afterPack — leave the bundle alone so we
// don't clobber a real signature.

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  // A real certificate is configured (self-signed in CI, or a Developer ID):
  // let electron-builder do the signing so we don't clobber a valid signature
  // that Squirrel.Mac auto-update depends on.
  if (process.env.CSC_LINK || process.env.CSC_KEY_PASSWORD || process.env.WARP_SIGNED) return;

  let app = context.appOutDir;
  if (!app.endsWith('.app')) {
    const found = fs.readdirSync(app).find((f) => f.endsWith('.app'));
    if (found) app = path.join(app, found);
  }
  if (!app.endsWith('.app')) {
    console.warn(`adhoc-sign: no .app found under ${context.appOutDir}, skipping`);
    return;
  }

  console.log(`adhoc-sign: sealing ${app} with an ad-hoc signature`);
  // Strip resource forks / Finder info / quarantine detritus — codesign refuses
  // to seal a bundle that carries extended attributes. (On CI this fully
  // cleans the bundle; a source tree under iCloud Drive may get xattrs
  // re-stamped by the file provider, in which case verify below warns but the
  // seal still applies.)
  execSync(`xattr -cr "${app}"`, { stdio: 'inherit' });
  execSync(`codesign --sign - --deep --force "${app}"`, { stdio: 'inherit' });
  try {
    execSync(`codesign --verify --deep --strict "${app}"`, { stdio: 'inherit' });
    console.log('adhoc-sign: verified');
  } catch (err) {
    console.warn('adhoc-sign: codesign --verify reported issues (often iCloud xattr re-stamping locally); the ad-hoc seal is still applied.');
  }
  console.log('adhoc-sign: ok');
};