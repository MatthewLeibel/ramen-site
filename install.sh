#!/usr/bin/env bash
# RAMen installer for Apple Silicon Macs and Linux (x86-64).
#
#   curl -fsSL https://getramenai.com/install.sh | bash
#
# Installs ramen and its llama-server into ~/.ramen/bin and adds that folder to your PATH.
# Nothing else is changed. To remove RAMen: rm -rf ~/.ramen (your saved chats are in ~/.context-engine).
# RAMEN_HOME=/some/dir changes the install folder; RAMEN_PKG=/path/or/url.tar.gz installs a specific package.
set -euo pipefail

REPO="MatthewLeibel/ramen-releases"
DEST="${RAMEN_HOME:-$HOME/.ramen}"

say() { printf '\033[1m%s\033[0m\n' "$*"; }
die() { printf 'RAMen install: %s\n' "$*" >&2; exit 1; }

OS="$(uname -s)"; ARCH="$(uname -m)"
case "$OS-$ARCH" in
    Darwin-arm64) PKG="ramen-macos-arm64" ;;
    Darwin-x86_64) die "RAMen needs a Mac with Apple silicon (M1 or newer). Intel Macs are not supported." ;;
    Linux-x86_64)
        if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L >/dev/null 2>&1; then PKG="ramen-linux-x64-cuda"
        else PKG="ramen-linux-x64-cpu"; fi ;;
    Linux-aarch64|Linux-arm64) die "Linux on ARM is not supported yet. Write to support@getramenai.com and we will tell you when it is." ;;
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
        if [ "$PKG" = "ramen-linux-x64-cuda" ] && [ -z "${RAMEN_PKG:-}" ]; then
            echo "The NVIDIA build could not be downloaded; installing the standard build instead (run the installer again later)."
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
