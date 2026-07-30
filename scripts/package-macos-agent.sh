#!/bin/sh
set -eu

VERSION="${1:-}"
if ! printf '%s' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'; then
  printf '%s\n' "Usage: package-macos-agent.sh <semantic-version>" >&2
  exit 2
fi
BUNDLE_VERSION="${VERSION%%-*}"

WORKSPACE=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd)
RUNNER_PACK="$WORKSPACE/apps/runner/dist-pack"
MANIFEST="$RUNNER_PACK/runner-tarball.json"
STAGE="$WORKSPACE/dist-agent/macos"
PKG_ROOT="$STAGE/pkg-root"
APP="$PKG_ROOT/Applications/Norns Local Agent.app"
CONTENTS="$APP/Contents"
RESOURCES="$CONTENTS/Resources"
MACOS="$CONTENTS/MacOS"
OUTPUT="$STAGE/installer/Norns-Local-Agent-macOS.pkg"
PACKAGE_SCRIPTS="$STAGE/package-scripts"
NODE_VERSION="24.18.0"

[ -f "$MANIFEST" ] || {
  printf '%s\n' "Runner tarball is missing. Build and pack @norns/runner first." >&2
  exit 1
}
TARBALL_NAME=$(node -e 'const fs=require("fs"); const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(value.filename)' "$MANIFEST")
TARBALL="$RUNNER_PACK/$TARBALL_NAME"
[ -f "$TARBALL" ] || {
  printf 'Runner tarball %s is missing.\n' "$TARBALL_NAME" >&2
  exit 1
}

rm -rf "$STAGE"
mkdir -p "$MACOS" "$RESOURCES/runtime" "$RESOURCES/app" "$STAGE/installer" "$PACKAGE_SCRIPTS"
cp "$WORKSPACE/packaging/macos/package-scripts/preinstall" "$PACKAGE_SCRIPTS/preinstall"
cp "$WORKSPACE/packaging/macos/package-scripts/postinstall" "$PACKAGE_SCRIPTS/postinstall"
chmod 755 "$PACKAGE_SCRIPTS/preinstall" "$PACKAGE_SCRIPTS/postinstall"

for ARCH in arm64 x64; do
  APP_PAYLOAD="$RESOURCES/app/$ARCH"
  npm_config_os=darwin npm_config_cpu="$ARCH" \
    npm install --prefix "$APP_PAYLOAD" --omit=dev --no-audit --no-fund "$TARBALL"

  ARCHIVE="node-v$NODE_VERSION-darwin-$ARCH.tar.gz"
  case "$ARCH" in
    arm64) EXPECTED_SHA256="e1a97e14c99c803e96c7339403282ea05a499c32f8d83defe9ef5ec66f979ed1" ;;
    x64) EXPECTED_SHA256="dfd0dbd3e721503434df7b7205e719f61b3a3a31b2bcf9729b8b91fea240f080" ;;
  esac
  curl --fail --location --silent --show-error \
    "https://nodejs.org/dist/v$NODE_VERSION/$ARCHIVE" \
    --output "$STAGE/$ARCHIVE"
  ACTUAL_SHA256=$(shasum -a 256 "$STAGE/$ARCHIVE" | awk '{print $1}')
  if [ "$ACTUAL_SHA256" != "$EXPECTED_SHA256" ]; then
    printf 'Node %s digest mismatch: expected %s, received %s\n' \
      "$ARCH" "$EXPECTED_SHA256" "$ACTUAL_SHA256" >&2
    exit 1
  fi
  mkdir -p "$RESOURCES/runtime/$ARCH"
  tar -xzf "$STAGE/$ARCHIVE" \
    --strip-components 2 \
    -C "$RESOURCES/runtime/$ARCH" \
    "node-v$NODE_VERSION-darwin-$ARCH/bin/node"
  rm -f "$STAGE/$ARCHIVE"
done

swiftc -O -target arm64-apple-macos13.0 \
  -framework AppKit \
  -framework CryptoKit \
  -framework Security \
  "$WORKSPACE/packaging/macos/NornsLocalAgent.swift" \
  -o "$STAGE/NornsLocalAgent-arm64"
swiftc -O -target x86_64-apple-macos13.0 \
  -framework AppKit \
  -framework CryptoKit \
  -framework Security \
  "$WORKSPACE/packaging/macos/NornsLocalAgent.swift" \
  -o "$STAGE/NornsLocalAgent-x64"
lipo -create "$STAGE/NornsLocalAgent-arm64" "$STAGE/NornsLocalAgent-x64" \
  -output "$MACOS/NornsLocalAgent"
rm -f "$STAGE/NornsLocalAgent-arm64" "$STAGE/NornsLocalAgent-x64"

sed "s/__VERSION__/$BUNDLE_VERSION/g" \
  "$WORKSPACE/packaging/macos/Info.plist.in" >"$CONTENTS/Info.plist"
cp "$WORKSPACE/packaging/macos/agent.sh" "$RESOURCES/agent.sh"
chmod 755 "$MACOS/NornsLocalAgent" "$RESOURCES/agent.sh"
plutil -lint "$CONTENTS/Info.plist" >/dev/null
lipo -archs "$MACOS/NornsLocalAgent" | grep -q arm64
lipo -archs "$MACOS/NornsLocalAgent" | grep -q x86_64
chmod -R u+w "$APP"
xattr -cr "$APP"

COPYFILE_DISABLE=1 pkgbuild \
  --root "$PKG_ROOT" \
  --scripts "$PACKAGE_SCRIPTS" \
  --identifier "com.thenorns.local-agent.pkg" \
  --version "$BUNDLE_VERSION" \
  --install-location / \
  "$OUTPUT"

DIGEST=$(shasum -a 256 "$OUTPUT" | awk '{print $1}')
printf 'Built %s\nSHA256 %s\n' "$OUTPUT" "$DIGEST"
