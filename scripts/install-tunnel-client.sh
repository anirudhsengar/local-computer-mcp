#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
version=v0.0.14
archive="tunnel-client-${version}-linux-amd64.zip"
expected=15bd17e805cad39d412199115bb9e10a978dd35258a114cdf25dd2ae6681c7d3
[[ "$(uname -s)-$(uname -m)" == Linux-x86_64 ]] || { echo 'This pinned installer supports this computer (Linux x86_64) only.' >&2; exit 1; }
temp_dir="$(mktemp -d)"
trap 'rm -rf "$temp_dir"' EXIT
curl --fail --location --proto '=https' --tlsv1.2 \
  "https://persistent.oaistatic.com/tunnel-client/${version}/${archive}" -o "$temp_dir/$archive"
echo "$expected  $temp_dir/$archive" | sha256sum --check --status || { echo 'Tunnel archive checksum mismatch.' >&2; exit 1; }
unzip -oq "$temp_dir/$archive" -d "$project_dir/tools/tunnel"
chmod 755 "$project_dir/tools/tunnel/tunnel-client" "$project_dir/tools/tunnel/cloudflared"
"$project_dir/tools/tunnel/tunnel-client" --version
