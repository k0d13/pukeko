#!/bin/sh
# Pukeko installer for Linux and macOS (x64 or arm64)
#   curl -fsSL https://raw.githubusercontent.com/k0d13/pukeko/main/install.sh | sh
# Env: PUKEKO_REPO (owner/repo), PUKEKO_VERSION (tag, default latest), PUKEKO_BIN_DIR
set -eu

repo="${PUKEKO_REPO:-k0d13/pukeko}"
version="${PUKEKO_VERSION:-latest}"
bin_dir="${PUKEKO_BIN_DIR:-$HOME/.local/bin}"

say() { printf '\033[1m%s\033[0m\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) die "unsupported OS $(uname -s); Pukeko runs on Linux and macOS" ;;
esac
case "$(uname -m)" in
  aarch64 | arm64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *) die "unsupported CPU $(uname -m); Pukeko needs 64-bit x64 or arm64" ;;
esac

if [ "$version" = latest ]; then
  url="https://github.com/$repo/releases/latest/download/pukeko-$os-$arch"
else
  url="https://github.com/$repo/releases/download/$version/pukeko-$os-$arch"
fi

say "Downloading pukeko ($os-$arch)"
mkdir -p "$bin_dir"
curl -fL --progress-bar "$url" -o "$bin_dir/pukeko.tmp" || die "download failed: $url"
chmod +x "$bin_dir/pukeko.tmp"
mv "$bin_dir/pukeko.tmp" "$bin_dir/pukeko"

if ! command -v claude >/dev/null 2>&1; then
  say "Installing Claude Code"
  curl -fsSL https://claude.ai/install.sh | bash
fi

# The agent's shell sandbox needs these on Linux
if [ "$os" = linux ] && ! { command -v bwrap && command -v socat; } >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    say "Installing sandbox dependencies (bubblewrap, socat)"
    sudo apt-get install -y bubblewrap socat
  else
    say "Install bubblewrap and socat with your package manager, or set [agent] sandbox = false"
  fi
fi

case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *) say "Add $bin_dir to your PATH, e.g. echo 'export PATH=\"$bin_dir:\$PATH\"' >> ~/.profile" ;;
esac

# Re-running this upgrades, so pick up the new binary if the service is running
if command -v systemctl >/dev/null 2>&1 && systemctl --user is-active --quiet pukeko 2>/dev/null; then
  say "Restarting the pukeko service"
  "$bin_dir/pukeko" restart
  exit 0
fi

# Under `curl | sh` stdin is this script, so init's prompts read the terminal instead
if : </dev/tty 2>/dev/null; then
  "$bin_dir/pukeko" init </dev/tty
else
  "$bin_dir/pukeko" init
fi

cat <<EOF

Next:
  1. Any token you skipped goes in .env (CLAUDE_CODE_OAUTH_TOKEN, DISCORD_TOKEN)
  2. pukeko                     to try it in the foreground
  3. pukeko service             to keep it running (pukeko logs, restart, upgrade)
EOF
