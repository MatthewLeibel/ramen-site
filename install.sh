#!/usr/bin/env bash
# RAMen installer for Apple Silicon Macs and Linux (x86-64).
#
#   curl -fsSL https://getramenai.com/install.sh | bash
#
# Installs ramen and its llama-server into ~/.ramen/bin and adds that folder to your PATH.
# Nothing else is changed. To remove RAMen: rm -rf ~/.ramen (your saved chats are in ~/.context-engine).
# RAMEN_HOME=/some/dir changes the install folder; RAMEN_PKG=/path/or/url.tar.gz installs a specific package;
# RAMEN_VULKAN=1 installs the preview build for AMD and Intel Arc graphics cards on Linux.
set -euo pipefail

REPO="MatthewLeibel/ramen-releases"
DEST="${RAMEN_HOME:-$HOME/.ramen}"

say() { printf '\033[1m%s\033[0m\n' "$*"; }
die() { printf 'RAMen install: %s\n' "$*" >&2; exit 1; }

OS="$(uname -s)"; ARCH="$(uname -m)"
vulkan_gpu() {   # an AMD graphics card, or an Intel Arc card, with a Vulkan driver: the Vulkan build
    have=""     # (grep -c reads everything: grep -q would stop ldconfig with SIGPIPE, a failure under pipefail)
    [ "$( { ldconfig -p 2>/dev/null || true; } | grep -c 'libvulkan\.so\.1')" -gt 0 ] && have=1
    for f in /usr/lib*/libvulkan.so.1 /usr/lib/*/libvulkan.so.1 /usr/lib*/*/libvulkan.so.1; do [ -e "$f" ] && have=1; done
    [ -n "$have" ] || return 1
    for d in /sys/class/drm/card*/device; do
        v="$(cat "$d/vendor" 2>/dev/null)"; id="$(cat "$d/device" 2>/dev/null)"
        [ "$v" = 0x1002 ] && return 0                                         # AMD
        [ "$v" = 0x8086 ] && case "$id" in 0x56??|0xe2??) return 0;; esac      # Intel Arc (Alchemist, Battlemage)
    done
    return 1
}
case "$OS-$ARCH" in
    Darwin-arm64) PKG="ramen-macos-arm64" ;;
    Darwin-x86_64) die "RAMen needs a Mac with Apple silicon (M1 or newer). Intel Macs are not supported." ;;
    Linux-x86_64)
        if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L >/dev/null 2>&1; then PKG="ramen-linux-x64-cuda"
        elif vulkan_gpu; then
            if [ "${RAMEN_VULKAN:-}" = 1 ]; then PKG="ramen-linux-x64-vulkan"     # preview: not yet tested on every card
            else PKG="ramen-linux-x64-cpu"; VULKAN_HINT=1; fi
        else PKG="ramen-linux-x64-cpu"; fi ;;
    Linux-aarch64|Linux-arm64)                                      # DGX Spark, Graviton, Ampere, Raspberry Pi 5
        [ "$(getconf LONG_BIT 2>/dev/null || echo 64)" = 64 ] || die "RAMen needs a 64-bit system (this one is 32-bit; on a Raspberry Pi, install the 64-bit Raspberry Pi OS)"
        PKG="ramen-linux-arm64-cpu" ;;
    *) die "this installer is for macOS and Linux. On Windows, run in PowerShell: irm https://getramenai.com/install.ps1 | iex" ;;
esac
command -v curl >/dev/null || die "curl is needed"
command -v tar >/dev/null || die "tar is needed"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
URL="${RAMEN_PKG:-https://github.com/$REPO/releases/latest/download/$PKG.tar.gz}"
say "Downloading RAMen ($PKG)"
if [ -f "$URL" ]; then cp "$URL" "$TMP/pkg.tar.gz"; [ -f "$URL.sha256" ] && cp "$URL.sha256" "$TMP/pkg.sha256"
else
    if ! curl -fL --retry 3 --progress-bar -o "$TMP/pkg.tar.gz" "$URL"; then
        if { [ "$PKG" = "ramen-linux-x64-cuda" ] || [ "$PKG" = "ramen-linux-x64-vulkan" ]; } && [ -z "${RAMEN_PKG:-}" ]; then
            echo "The build for your graphics card could not be downloaded; installing the standard build instead (run the installer again later)."
            PKG="ramen-linux-x64-cpu"; URL="https://github.com/$REPO/releases/latest/download/$PKG.tar.gz"
            curl -fL --retry 3 --progress-bar -o "$TMP/pkg.tar.gz" "$URL" || die "could not download $URL"
        else die "could not download $URL"; fi
    fi
    curl -fsSL --retry 3 -o "$TMP/pkg.sha256" "$URL.sha256" || die "could not download the checksum for $URL"
fi
if [ -f "$TMP/pkg.sha256" ]; then
    want="$(awk '{print $1}' "$TMP/pkg.sha256")"
    if command -v shasum >/dev/null 2>&1; then have="$(shasum -a 256 "$TMP/pkg.tar.gz" | awk '{print $1}')"
    else have="$(sha256sum "$TMP/pkg.tar.gz" | awk '{print $1}')"; fi
    [ "$want" = "$have" ] || die "the download is damaged (checksum mismatch); please run the installer again"
fi

tar -xzf "$TMP/pkg.tar.gz" -C "$TMP"
[ -x "$TMP/ramen/bin/ramen" ] || die "the package is incomplete"
if [ -x "$DEST/bin/ramen" ]; then "$DEST/bin/ramen" stop >/dev/null 2>&1 || true; fi   # an update: stop the old one
mkdir -p "$DEST"
rm -rf "$DEST/bin"
cp -R "$TMP/ramen/." "$DEST/"
chmod +x "$DEST/bin/"*

# put ~/.ramen/bin on the PATH for new terminals
LINE="export PATH=\"$DEST/bin:\$PATH\""
added=""
for rc in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.profile"; do
    case "$rc" in
        */.zshrc) [ "$OS" = "Darwin" ] || [ -f "$rc" ] || continue ;;
        */.bashrc) [ -f "$rc" ] || [ "$OS" = "Linux" ] || continue ;;
        */.profile) [ -f "$rc" ] || continue ;;
    esac
    if ! grep -qs "$DEST/bin" "$rc"; then printf '\n# RAMen\n%s\n' "$LINE" >> "$rc"; added="$added $rc"; fi
done

say "RAMen $("$DEST/bin/ramen" version 2>/dev/null | awk '{print $2}') is installed in $DEST"
echo
echo "By using RAMen you agree to its license: https://getramenai.com/terms.html"
echo
case ":$PATH:" in
    *":$DEST/bin:"*) ;;
    *) echo "Open a new terminal window first (or run:  $LINE  )"; echo ;;
esac
echo "Then start it with one command:"
echo "  ramen start"
echo
echo "It picks a model that fits this computer, downloads it and runs in the background."
echo "Connect an app with:  ramen connect cline   (or continue, aider, opencode, openwebui, env)"
if [ -n "${VULKAN_HINT:-}" ]; then
    echo
    echo "This computer has an AMD or Intel Arc graphics card. A preview build that uses it is available:"
    echo "  curl -fsSL https://getramenai.com/install.sh | RAMEN_VULKAN=1 bash"
fi
