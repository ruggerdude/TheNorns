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

APPLICATION_KEYCHAIN="$RUNNER_TEMP/norns-application-signing.keychain-db"
INSTALLER_KEYCHAIN="$RUNNER_TEMP/norns-installer-signing.keychain-db"
KEYCHAIN_PASSWORD=$(uuidgen)
APPLICATION_P12="$RUNNER_TEMP/norns-application.p12"
INSTALLER_P12="$RUNNER_TEMP/norns-installer.p12"
NOTARY_KEY="$RUNNER_TEMP/AuthKey_${NOTARY_KEY_ID}.p8"

cleanup() {
  security delete-keychain "$APPLICATION_KEYCHAIN" >/dev/null 2>&1 || true
  security delete-keychain "$INSTALLER_KEYCHAIN" >/dev/null 2>&1 || true
  rm -f "$APPLICATION_P12" "$INSTALLER_P12" "$NOTARY_KEY"
}
trap cleanup EXIT

printf '%s' "$APPLICATION_CERTIFICATE_BASE64" | base64 -D >"$APPLICATION_P12"
printf '%s' "$INSTALLER_CERTIFICATE_BASE64" | base64 -D >"$INSTALLER_P12"
printf '%s' "$NOTARY_KEY_BASE64" | base64 -D >"$NOTARY_KEY"

security create-keychain -p "$KEYCHAIN_PASSWORD" "$APPLICATION_KEYCHAIN"
security create-keychain -p "$KEYCHAIN_PASSWORD" "$INSTALLER_KEYCHAIN"
for keychain in "$APPLICATION_KEYCHAIN" "$INSTALLER_KEYCHAIN"; do
  security set-keychain-settings -lut 21600 "$keychain"
  security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$keychain"
done
# These certificates share one private key, so keep them in separate keychains
# to prevent the second import from collapsing into the first identity.
security import "$APPLICATION_P12" -k "$APPLICATION_KEYCHAIN" \
  -P "$CERTIFICATE_PASSWORD" -T /usr/bin/codesign
security import "$INSTALLER_P12" -k "$INSTALLER_KEYCHAIN" \
  -P "$CERTIFICATE_PASSWORD" -T /usr/bin/pkgbuild -T /usr/bin/productsign
security set-key-partition-list -S apple-tool:,apple: -s \
  -k "$KEYCHAIN_PASSWORD" "$APPLICATION_KEYCHAIN"
security set-key-partition-list -S apple-tool:,apple: -s \
  -k "$KEYCHAIN_PASSWORD" "$INSTALLER_KEYCHAIN"
security list-keychains -d user -s \
  "$APPLICATION_KEYCHAIN" "$INSTALLER_KEYCHAIN"

APPLICATION_IDENTITIES=$(security find-identity -v "$APPLICATION_KEYCHAIN")
INSTALLER_IDENTITIES=$(security find-identity -v "$INSTALLER_KEYCHAIN")
printf '%s\n%s\n' "$APPLICATION_IDENTITIES" "$INSTALLER_IDENTITIES"
if ! printf '%s\n' "$APPLICATION_IDENTITIES" | grep -Fq "$APPLICATION_IDENTITY"; then
  printf 'Application identity is not usable in its CI keychain: %s\n' \
    "$APPLICATION_IDENTITY" >&2
  exit 1
fi
if ! printf '%s\n' "$INSTALLER_IDENTITIES" | grep -Fq "$INSTALLER_IDENTITY"; then
  printf 'Installer identity is not usable in its CI keychain: %s\n' \
    "$INSTALLER_IDENTITY" >&2
  exit 1
fi

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
  --keychain "$INSTALLER_KEYCHAIN" \
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
