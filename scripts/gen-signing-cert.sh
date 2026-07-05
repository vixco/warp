#!/bin/bash
# Generates a FREE self-signed code-signing certificate for macOS.
#
# Why: electron-updater's macOS auto-update (Squirrel.Mac) only applies an
# update whose code signature satisfies the *running* app's designated
# requirement. That requirement, for a self-signed app, is just "same leaf
# certificate" — no Apple Developer ID and no notarization needed. As long as
# every build is signed with THIS SAME certificate, "Check for updates" +
# "Restart to update" work automatically, exactly like on Windows.
#
# Run this ONCE. It prints two values to paste into GitHub repo secrets:
#   MAC_CSC_LINK          (base64 of the .p12)
#   MAC_CSC_KEY_PASSWORD  (the random password)
# electron-builder reads CSC_LINK / CSC_KEY_PASSWORD from those in CI and signs
# each build with the cert. Keep the .p12 safe: if it's ever lost, a new cert
# breaks the auto-update chain and users must reinstall once.
#
# Usage: bash scripts/gen-signing-cert.sh [output-dir]
set -euo pipefail

OUT="${1:-$HOME/.warp-signing}"
mkdir -p "$OUT"
CN="Warp Self-Signed"
PASS="$(openssl rand -base64 18 | tr -d '/+=' | head -c 24)"

cat > "$OUT/cert.conf" <<'EOF'
[req]
distinguished_name = dn
x509_extensions = v3
prompt = no
[dn]
CN = Warp Self-Signed
O = Tovix
[v3]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
EOF

openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
  -keyout "$OUT/key.pem" -out "$OUT/cert.pem" -config "$OUT/cert.conf" >/dev/null 2>&1

openssl pkcs12 -export -legacy \
  -inkey "$OUT/key.pem" -in "$OUT/cert.pem" \
  -name "$CN" -out "$OUT/warp-signing.p12" -passout "pass:$PASS" >/dev/null 2>&1 \
|| openssl pkcs12 -export \
  -inkey "$OUT/key.pem" -in "$OUT/cert.pem" \
  -name "$CN" -out "$OUT/warp-signing.p12" -passout "pass:$PASS" >/dev/null 2>&1

base64 -i "$OUT/warp-signing.p12" | tr -d '\n' > "$OUT/warp-signing.p12.b64"

echo "cert written to: $OUT/warp-signing.p12"
echo "----- MAC_CSC_KEY_PASSWORD -----"
echo "$PASS"
echo "----- MAC_CSC_LINK (base64, first/last 20 chars) -----"
head -c 20 "$OUT/warp-signing.p12.b64"; echo " ... $(tail -c 20 "$OUT/warp-signing.p12.b64")"
echo "(full base64 is in $OUT/warp-signing.p12.b64)"
