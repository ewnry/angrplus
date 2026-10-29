#!/usr/bin/env bash
set -eo pipefail
# Antigravity+ PATCH_VERSION — native Linux/macOS runtime patcher.
# A compatible Node.js is reused, otherwise a verified temporary runtime is downloaded.
PAYLOAD_SHA='PAYLOAD_SHA256'
AGY_BUNDLE_TMP=''
cleanup_bundle() {
  if [ -n "$AGY_BUNDLE_TMP" ]; then
    case "$AGY_BUNDLE_TMP" in "${TMPDIR:-/tmp}"/claugravity.*) rm -rf -- "$AGY_BUNDLE_TMP" ;; esac
  fi
}
trap cleanup_bundle EXIT
checksum() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'; else shasum -a 256 "$1" | awk '{print $1}'; fi
}
ensure_node() {
  if command -v node >/dev/null 2>&1 && node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a<22||(a===22&&b<12)?1:0)' 2>/dev/null; then NODE_BIN="$(command -v node)"; return; fi
  local platform arch expected archive actual
  case "$(uname -s)" in Linux) platform=linux;; Darwin) platform=darwin;; *) echo 'Only Linux and macOS are supported.' >&2; return 1;; esac
  case "$(uname -m)" in x86_64|amd64) arch=x64;; arm64|aarch64) arch=arm64;; *) echo 'Automatic Node.js installation supports x64 and arm64.' >&2; return 1;; esac
  case "$platform-$arch" in
    linux-x64) expected=1084aa36196bba4c3a5e69a1ee388a6e4ff729dad09445fbcd434b28fe3c24af;;
    linux-arm64) expected=5ced2d48d1d7198739b7f86804de0171aefb6823b684b12341d3321afc3cb0b2;;
    darwin-x64) expected=8a677b0219178efd6eb0e475457c4afb452b521a92f6e67845a73bd85727f2a8;;
    darwin-arm64) expected=23b25245dcfb9af7262f8ff142e9e2e0af025368117329e7a7458a51e5922f53;;
  esac
  archive="node-v22.23.3-$platform-$arch.tar.gz"
  printf '%s\n' 'Downloading temporary Node.js 22.23.3 from nodejs.org...'
  curl --fail --show-error --location --proto '=https' --tlsv1.2 --connect-timeout 20 --max-time 300 "https://nodejs.org/dist/v22.23.3/$archive" -o "$AGY_BUNDLE_TMP/node.tar.gz"
  actual="$(checksum "$AGY_BUNDLE_TMP/node.tar.gz")"
  [ "$actual" = "$expected" ] || { echo 'Node.js checksum mismatch.' >&2; return 1; }
  tar -xzf "$AGY_BUNDLE_TMP/node.tar.gz" -C "$AGY_BUNDLE_TMP"
  NODE_BIN="$AGY_BUNDLE_TMP/node-v22.23.3-$platform-$arch/bin/node"
  "$NODE_BIN" --version
}
unpack_bundle() {
  [ -n "$AGY_BUNDLE_TMP" ] && return 0
  AGY_BUNDLE_TMP="$(mktemp -d "${TMPDIR:-/tmp}/claugravity.XXXXXX")"
  if [ "$(uname -s)" = Darwin ]; then emit_payload | base64 -D > "$AGY_BUNDLE_TMP/runtime.tar.gz"; else emit_payload | base64 --decode > "$AGY_BUNDLE_TMP/runtime.tar.gz"; fi
  if command -v sha256sum >/dev/null 2>&1; then ACTUAL_SHA=$(sha256sum "$AGY_BUNDLE_TMP/runtime.tar.gz" | awk '{print $1}'); else ACTUAL_SHA=$(shasum -a 256 "$AGY_BUNDLE_TMP/runtime.tar.gz" | awk '{print $1}'); fi
  [ "$ACTUAL_SHA" = "$PAYLOAD_SHA" ] || { printf '%s\n' 'Installer payload checksum mismatch.' >&2; return 1; }
  tar -xzf "$AGY_BUNDLE_TMP/runtime.tar.gz" -C "$AGY_BUNDLE_TMP"
}
locate_resources() {
  RESOURCES_DIR="${ANTIGRAVITY_RESOURCES:-}"
  if [ -z "$RESOURCES_DIR" ]; then
    for dir in "$HOME/Applications/Antigravity.app/Contents/Resources" /Applications/Antigravity.app/Contents/Resources /Applications/Antigravity\ IDE.app/Contents/Resources "$HOME/.local/share/Programs/antigravity/resources" "$HOME/.local/share/antigravity/resources" /opt/antigravity/resources /opt/Antigravity/resources /usr/lib/antigravity/resources /usr/local/lib/antigravity/resources /usr/share/antigravity/resources; do
      if [ -f "$dir/app.asar" ]; then RESOURCES_DIR="$dir"; break; fi
    done
  fi
}
ensure_closed() {
  local app_dir="$1"
  if [ "$(uname -s)" = Linux ]; then
    for proc in /proc/[0-9]*/exe; do
      executable=$(readlink "$proc" 2>/dev/null || true)
      case "$executable" in "$app_dir"/*) printf '%s\n' 'Close Antigravity and its agent service before installing or restoring.' >&2; return 1 ;; esac
    done
  else
    if ps -axo comm= | grep -F -- "${app_dir%/Contents}/Contents/MacOS/Antigravity" >/dev/null; then printf '%s\n' 'Close Antigravity before installing or restoring.' >&2; return 1; fi
  fi
}
run_patch() {
  local action="$1"; shift
  locate_resources
  [ -n "$RESOURCES_DIR" ] && [ -f "$RESOURCES_DIR/app.asar" ] || { printf '%s\n' 'Antigravity standalone not found. Set ANTIGRAVITY_RESOURCES to its resources directory.' >&2; return 1; }
  if [ "$action" != --check ]; then ensure_closed "$(dirname "$RESOURCES_DIR")"; fi
  unpack_bundle
  ensure_node
  local privilege=()
  if [ "$action" != --check ] && { [ ! -w "$RESOURCES_DIR" ] || [ ! -w "$RESOURCES_DIR/app.asar" ]; }; then
    command -v sudo >/dev/null 2>&1 || { echo 'Write permission required. Run this installer with sudo.' >&2; return 1; }
    printf '%s\n' 'Administrator permission is required only to patch the installed files.'
    sudo -v
    privilege=(sudo)
  fi
  if [ "$action" = --install ]; then "${privilege[@]}" "$NODE_BIN" "$AGY_BUNDLE_TMP/scripts/deploy.mjs" --resources "$RESOURCES_DIR" "$@"; else "${privilege[@]}" "$NODE_BIN" "$AGY_BUNDLE_TMP/scripts/deploy.mjs" --resources "$RESOURCES_DIR" "$action" "$@"; fi
  if [ "$(uname -s)" = Darwin ] && [ "$action" != --check ]; then
    app_path="${RESOURCES_DIR%/Contents/Resources}"
    if [ -d "$app_path/Contents" ]; then "${privilege[@]}" codesign --force --deep --sign - "$app_path"; fi
  fi
  [ "$action" = --check ] || printf '%s\n' 'Done. Antigravity was not started or restarted. Open it manually when ready.'
}
main() {
  local action="${1:-}"
  case "$action" in
    --help|-h) printf '%s\n' 'Antigravity+ PATCH_VERSION for Linux/macOS' 'Usage: bash install.sh [--install|--check|--restore]' 'Set ANTIGRAVITY_RESOURCES=/path/to/resources for a custom installation.' 'Node.js is downloaded automatically if needed and removed after use.' 'Close the app before install/restore. The installer never starts or restarts it.'; return ;;
    --extract-only) unpack_bundle; [ -n "${2:-}" ] || { echo 'Destination directory required' >&2; return 1; }; mkdir -- "$2"; cp -R "$AGY_BUNDLE_TMP/." "$2/"; return ;;
    --install|-i|--silent) run_patch --install; return ;;
    --restore|-r) run_patch --restore; return ;;
    --check|--status|-s) run_patch --check; return ;;
    '') ;;
    *) echo "Unknown argument: $action" >&2; return 2 ;;
  esac
  run_patch --install
}
emit_payload() {
cat <<'AGY_BASE64_PAYLOAD'
BASE64_PAYLOAD
AGY_BASE64_PAYLOAD
}
main "$@"
