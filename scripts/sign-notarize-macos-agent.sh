#!/bin/bash
set -euo pipefail

VERSION="${1:?installer version required}"
if ! printf '%s' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'; then
  printf '%s\n' "A semantic installer version is required." >&2
  exit 2
fi
BUNDLE_VERSION="${VERSION%%-*}"
WORKSPACE=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
STAGE="$WORKSPACE/dist-agent/macos"
PKG_ROOT="$STAGE/pkg-root"
APP="$PKG_ROOT/Applications/Norns Local Agent.app"
PKG="$STAGE/installer/Norns-Local-Agent-macOS.pkg"
PACKAGE_SCRIPTS="$STAGE/package-scripts"
COMPONENT_PLIST="$WORKSPACE/packaging/macos/component.plist"
ENTITLEMENTS="$WORKSPACE/packaging/macos/node-entitlements.plist"
PUBLISH_RELEASE="${PUBLISH_RELEASE:-false}"

required=(
  APPLICATION_CERTIFICATE_BASE64
  INSTALLER_CERTIFICATE_BASE64
  CERTIFICATE_PASSWORD
  APPLICATION_IDENTITY
  INSTALLER_IDENTITY
  NOTARY_KEY_BASE64
  NOTARY_KEY_ID
  NOTARY_ISSUER_ID
)
missing=()
for name in "${required[@]}"; do
  if [ -z "${!name:-}" ]; then missing+=("$name"); fi
done

if [ "${#missing[@]}" -gt 0 ]; then
  if [ "$PUBLISH_RELEASE" = "true" ]; then
    printf 'Publishing requires all Apple signing and notarization values. Missing: %s\n' \
      "${missing[*]}" >&2
    exit 1
  fi
  printf '%s\n' "notarized=false" >>"${GITHUB_OUTPUT:-/dev/null}"
  printf '%s\n' "No Apple identity configured; retaining this build as a CI artifact only."
  exit 0
fi

[ -d "$APP" ] || { printf '%s\n' "macOS app bundle is missing." >&2; exit 1; }
[ -f "$PKG" ] || { printf '%s\n' "macOS installer package is missing." >&2; exit 1; }
[ -d "$PACKAGE_SCRIPTS" ] || { printf '%s\n' "macOS package scripts are missing." >&2; exit 1; }
[ -f "$COMPONENT_PLIST" ] || { printf '%s\n' "macOS component plist is missing." >&2; exit 1; }

KEYCHAIN="$RUNNER_TEMP/norns-signing.keychain-db"
KEYCHAIN_PASSWORD=$(uuidgen)
APPLICATION_P12="$RUNNER_TEMP/norns-application.p12"
INSTALLER_P12="$RUNNER_TEMP/norns-installer.p12"
NOTARY_KEY="$RUNNER_TEMP/AuthKey_${NOTARY_KEY_ID}.p8"

cleanup() {
  security delete-keychain "$KEYCHAIN" >/dev/null 2>&1 || true
  rm -f "$APPLICATION_P12" "$INSTALLER_P12" "$NOTARY_KEY"
}
trap cleanup EXIT

printf '%s' "$APPLICATION_CERTIFICATE_BASE64" | base64 -D >"$APPLICATION_P12"
printf '%s' "$INSTALLER_CERTIFICATE_BASE64" | base64 -D >"$INSTALLER_P12"
printf '%s' "$NOTARY_KEY_BASE64" | base64 -D >"$NOTARY_KEY"

security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN"
security set-keychain-settings -lut 21600 "$KEYCHAIN"
security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN"
# The application and installer certificates may share one private key. The
# first import owns that key's ACL, so grant every signing tool access on both
# imports instead of relying on the duplicate-key import to update it.
security import "$APPLICATION_P12" -k "$KEYCHAIN" -P "$CERTIFICATE_PASSWORD" \
  -T /usr/bin/codesign -T /usr/bin/pkgbuild -T /usr/bin/productsign
security import "$INSTALLER_P12" -k "$KEYCHAIN" -P "$CERTIFICATE_PASSWORD" \
  -T /usr/bin/codesign -T /usr/bin/pkgbuild -T /usr/bin/productsign
security set-key-partition-list -S apple-tool:,apple: -s \
  -k "$KEYCHAIN_PASSWORD" "$KEYCHAIN"
security list-keychains -d user -s "$KEYCHAIN"

IDENTITIES=$(security find-identity -v "$KEYCHAIN")
printf '%s\n' "$IDENTITIES"
for identity in "$APPLICATION_IDENTITY" "$INSTALLER_IDENTITY"; do
  if ! printf '%s\n' "$IDENTITIES" | grep -Fq "$identity"; then
    printf 'Signing identity is not usable in the CI keychain: %s\n' \
      "$identity" >&2
    exit 1
  fi
done

chmod -R u+w "$APP"
xattr -cr "$APP"
while IFS= read -r -d '' candidate; do
  if file "$candidate" | grep -q "Mach-O"; then
    if [[ "$candidate" == */runtime/*/node ]]; then
      codesign --force --timestamp --options runtime \
        --entitlements "$ENTITLEMENTS" \
        --sign "$APPLICATION_IDENTITY" "$candidate"
    else
      codesign --force --timestamp --options runtime \
        --sign "$APPLICATION_IDENTITY" "$candidate"
    fi
  fi
done < <(find "$APP" -type f -print0)

codesign --force --timestamp --options runtime \
  --sign "$APPLICATION_IDENTITY" "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"

rm -f "$PKG"
COPYFILE_DISABLE=1 pkgbuild \
  --root "$PKG_ROOT" \
  --scripts "$PACKAGE_SCRIPTS" \
  --component-plist "$COMPONENT_PLIST" \
  --identifier "com.thenorns.local-agent.pkg" \
  --version "$BUNDLE_VERSION" \
  --install-location / \
  --sign "$INSTALLER_IDENTITY" \
  --keychain "$KEYCHAIN" \
  "$PKG"
pkgutil --check-signature "$PKG"

xcrun notarytool submit "$PKG" \
  --key "$NOTARY_KEY" \
  --key-id "$NOTARY_KEY_ID" \
  --issuer "$NOTARY_ISSUER_ID" \
  --wait
xcrun stapler staple "$PKG"
xcrun stapler validate "$PKG"
spctl --assess --type install --verbose=2 "$PKG"

printf '%s\n' "notarized=true" >>"${GITHUB_OUTPUT:-/dev/null}"
