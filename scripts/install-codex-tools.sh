#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
version="0.152.1"
sha256="a0ed1b40b1d597b340f09ae00ecebc46670b06cb52aac315b9dc84fed0289fd0"
destination="$project_dir/tools/codex/apply_patch"
[[ -x "$destination" ]] && exit 0

temporary_dir="$(mktemp -d)"
trap 'rm -rf "$temporary_dir"' EXIT
curl -fsSL "https://releases.openai.com/codex/releases/${version}/codex-x86_64-unknown-linux-musl.tar.gz" -o "$temporary_dir/codex.tar.gz"
echo "$sha256  $temporary_dir/codex.tar.gz" | sha256sum -c -
tar -xzf "$temporary_dir/codex.tar.gz" -C "$temporary_dir"
install -Dm755 "$temporary_dir/codex-x86_64-unknown-linux-musl" "$destination"
curl -fsSL "https://raw.githubusercontent.com/openai/codex/rust-v${version}/LICENSE" -o "$temporary_dir/LICENSE"
install -Dm644 "$temporary_dir/LICENSE" "$project_dir/tools/codex/LICENSE"
