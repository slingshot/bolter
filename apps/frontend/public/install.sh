#!/bin/sh
# sendfm installer — curl -fsSL https://send.fm/install.sh | sh
#
# Downloads the release binary for this platform, verifies it against the
# release's checksums.txt, and installs it. Verification is not optional: this
# script is piped into a shell, so a tampered download would run as the user.
set -eu

REPO="slingshot/bolter"
NAME="sendfm"
: "${SENDFM_INSTALL_DIR:=}"
: "${SENDFM_VERSION:=}"

say() { printf '%s\n' "$*" >&2; }
die() { say "error: $*"; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "$1 is required"; }

need uname
need tar

if command -v curl >/dev/null 2>&1; then
    fetch() { curl -fsSL "$1"; }
    fetch_to() { curl -fsSL -o "$2" "$1"; }
elif command -v wget >/dev/null 2>&1; then
    fetch() { wget -qO- "$1"; }
    fetch_to() { wget -qO "$2" "$1"; }
else
    die "curl or wget is required"
fi

os=$(uname -s | tr '[:upper:]' '[:lower:]')
arch=$(uname -m)
case "$os" in
    darwin) os=darwin ;;
    linux) os=linux ;;
    # Windows users get the .zip from the releases page; this script assumes a
    # POSIX shell and tar.
    *) die "unsupported OS: $os. See https://github.com/$REPO/releases" ;;
esac
case "$arch" in
    x86_64 | amd64) arch=x64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) die "unsupported architecture: $arch" ;;
esac

if [ -z "$SENDFM_VERSION" ]; then
    say "Finding the latest release..."
    SENDFM_VERSION=$(
        fetch "https://api.github.com/repos/$REPO/releases/latest" |
            sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n 1
    )
    [ -n "$SENDFM_VERSION" ] || die "could not determine the latest version"
fi
version=${SENDFM_VERSION#v}

asset="$NAME-$version-$os-$arch.tar.gz"
base="https://github.com/$REPO/releases/download/v$version"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM

say "Downloading $asset..."
fetch_to "$base/$asset" "$tmp/$asset" || die "download failed: $base/$asset"

say "Verifying checksum..."
fetch_to "$base/checksums.txt" "$tmp/checksums.txt" || die "could not fetch checksums.txt"
expected=$(grep " $asset\$" "$tmp/checksums.txt" | awk '{print $1}' | head -n 1)
[ -n "$expected" ] || die "no checksum published for $asset"

if command -v sha256sum >/dev/null 2>&1; then
    actual=$(sha256sum "$tmp/$asset" | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then
    actual=$(shasum -a 256 "$tmp/$asset" | awk '{print $1}')
else
    die "sha256sum or shasum is required to verify the download"
fi
[ "$actual" = "$expected" ] || die "checksum mismatch — refusing to install"

tar -xzf "$tmp/$asset" -C "$tmp"
[ -f "$tmp/$NAME" ] || die "archive did not contain $NAME"
chmod +x "$tmp/$NAME"

# Prefer somewhere already on PATH and writable, so the install needs no sudo
# and the binary is immediately usable.
if [ -n "$SENDFM_INSTALL_DIR" ]; then
    target="$SENDFM_INSTALL_DIR"
elif [ -w "/usr/local/bin" ]; then
    target="/usr/local/bin"
elif [ -d "$HOME/.local/bin" ]; then
    target="$HOME/.local/bin"
else
    target="$HOME/.local/bin"
    mkdir -p "$target"
fi

mv "$tmp/$NAME" "$target/$NAME"
say "Installed $NAME $version to $target/$NAME"

case ":$PATH:" in
    *":$target:"*) ;;
    *) say "note: $target is not on your PATH. Add it with:"
       say "  export PATH=\"$target:\$PATH\"" ;;
esac

"$target/$NAME" --version >/dev/null 2>&1 || say "warning: $NAME did not run cleanly"
