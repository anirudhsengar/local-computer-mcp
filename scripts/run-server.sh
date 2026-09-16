#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
user_dir="$(getent passwd "$(id -u)" | cut -d: -f6)"
export PATH="$project_dir/node_modules/.bin:$user_dir/.local/bin:$user_dir/.local/share/mise/shims:$user_dir/.local/share/mise/installs/node/latest/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"
node_command="${LOCAL_COMPUTER_MCP_NODE:-$(command -v node || true)}"
[[ -n "$node_command" && -x "$node_command" ]] || { echo 'Node.js is unavailable; reinstall the service with Node.js 22+ on PATH.' >&2; exit 1; }
export PATH="$(dirname "$node_command"):$PATH"
export LOCAL_COMPUTER_MCP_SERVER=1
exec "$node_command" "$project_dir/src/server.mjs"
