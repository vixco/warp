#!/bin/bash
# Builds the native macOS helpers. No-op on other platforms.
set -e
cd "$(dirname "$0")/.."

if [ "$(uname)" != "Darwin" ]; then
  echo "build-native: not macOS, skipping native helpers"
  exit 0
fi

mkdir -p native/bin

clang -fobjc-arc -O2 \
  -framework Foundation -framework CoreGraphics \
  -framework ApplicationServices \
  -o native/bin/warp-input native/mac/warp-input.m

clang -fobjc-arc -O2 \
  -framework Foundation -framework CoreGraphics \
  -o native/bin/warp-vdisplay native/mac/warp-vdisplay.m

clang -fobjc-arc -O2 \
  -framework Cocoa -framework CoreGraphics \
  -o native/bin/warp-cursor native/mac/warp-cursor.m

echo "build-native: ok -> native/bin/{warp-input,warp-vdisplay,warp-cursor}"
