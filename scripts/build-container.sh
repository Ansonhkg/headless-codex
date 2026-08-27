#!/bin/sh
set -eu

repo_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
deb_path="${1:-}"
image_name="${HEADLESS_CODEX_IMAGE:-headless-codex:local}"

if [ -z "$deb_path" ] || [ ! -f "$deb_path" ]; then
  echo "usage: $0 /absolute/path/to/chatgpt-linux.deb" >&2
  exit 64
fi

control="$(ar p "$deb_path" control.tar.xz | bsdtar -xOJf - ./control)"
architecture="$(printf '%s\n' "$control" | awk '$1 == "Architecture:" { print $2; exit }')"
case "$architecture" in
  amd64) bun_target="bun-linux-x64"; platform="linux/amd64" ;;
  arm64) bun_target="bun-linux-arm64"; platform="linux/arm64" ;;
  *) echo "unsupported Debian architecture: $architecture" >&2; exit 65 ;;
esac

build_dir="$(mktemp -d "${TMPDIR:-/tmp}/headless-codex-build.XXXXXX")"
trap 'rm -rf "$build_dir"' EXIT INT TERM

bun build "$repo_dir/src/cli.ts" --compile --target="$bun_target" --outfile "$build_dir/headless-codex"
cp "$deb_path" "$build_dir/chatgpt.deb"
cp "$repo_dir/deploy/Dockerfile" "$build_dir/Dockerfile"
cp "$repo_dir/deploy/launch-chatgpt" "$build_dir/launch-chatgpt"
cp "$repo_dir/deploy/entrypoint" "$build_dir/entrypoint"
cp -R "$repo_dir/assets/fonts" "$build_dir/fonts"
mkdir -p "$build_dir/assets"
cp "$repo_dir/assets/headless-codex-logo.png" "$build_dir/assets/headless-codex-logo.png"
chmod 0644 "$build_dir/assets/headless-codex-logo.png"

docker build --platform "$platform" --tag "$image_name" "$build_dir"
echo "Built $image_name for $platform"
