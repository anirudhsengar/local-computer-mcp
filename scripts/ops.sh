#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
runtime_dir="$project_dir/runtime"
service_name="local-computer-mcp.service"
legacy_service="laptop-workspace-mcp.service"
root_helper="/usr/local/libexec/local-computer-mcp-root"
root_rule="/etc/sudoers.d/local-computer-mcp"

download_checked() {
  source_url="$1"
  destination="$2"
  expected_sha="$3"
  if [[ -f "$destination" ]] && echo "$expected_sha  $destination" | sha256sum -c - >/dev/null 2>&1; then return; fi
  mkdir -p "$(dirname "$destination")"
  temporary_file="$destination.download"
  curl -fsSL "$source_url" -o "$temporary_file"
  echo "$expected_sha  $temporary_file" | sha256sum -c -
  mv "$temporary_file" "$destination"
}

setup() {
  npm --prefix "$project_dir" ci
  bash "$project_dir/scripts/install-codex-tools.sh"
  "$project_dir/node_modules/.bin/playwright" install chromium
  uv_command="$(command -v uv || true)"
  [[ -n "$uv_command" ]] || { echo 'uv is required for the project-local Kokoro runtime.' >&2; return 1; }
  "$uv_command" venv "$runtime_dir/media-venv" --python 3.13 --clear
  "$uv_command" pip install --python "$runtime_dir/media-venv/bin/python" kokoro-onnx==0.4.7 soundfile==0.14.0
  download_checked https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx "$runtime_dir/media-assets/kokoro-v1.0.onnx" 7d5df8ecf7d4b1878015a32686053fd0eebe2bc377234608764cc0ef3636a6c5
  download_checked https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin "$runtime_dir/media-assets/voices-v1.0.bin" bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d
  download_checked https://stable-mirror.omarchy.org/extra/os/x86_64/espeak-ng-1.52.0-1-x86_64.pkg.tar.zst "$runtime_dir/espeak/packages/espeak-ng-1.52.0-1.pkg.tar.zst" baad119a494cacd1ba0f290f78a0159051ba1d17e09bc7d1b2df5fa7e7df78d9
  download_checked https://stable-mirror.omarchy.org/extra/os/x86_64/libsonic-0.2.0-2-x86_64.pkg.tar.zst "$runtime_dir/espeak/packages/libsonic-0.2.0-2.pkg.tar.zst" b2eaa5075d038d6839c7ddb1f742eaca9a31648f8e79ec45ac05f38992b56d42
  download_checked https://stable-mirror.omarchy.org/extra/os/x86_64/pcaudiolib-1.3-1-x86_64.pkg.tar.zst "$runtime_dir/espeak/packages/pcaudiolib-1.3-1.pkg.tar.zst" be519c77ee888b5abb265b993471e1ef42f8b5d0af00bf9d73ce7d4a1019e9b3
  rm -rf "$runtime_dir/espeak/root"
  mkdir -p "$runtime_dir/espeak/root"
  for package_file in "$runtime_dir"/espeak/packages/*.pkg.tar.zst; do bsdtar -xf "$package_file" -C "$runtime_dir/espeak/root"; done
  PATH="$runtime_dir/media-venv/bin:$project_dir/node_modules/.bin:$PATH" HYPERFRAMES_TELEMETRY_DISABLED=1 hyperframes browser ensure
  LD_LIBRARY_PATH="$runtime_dir/espeak/root/usr/lib" "$runtime_dir/media-venv/bin/python" "$project_dir/scripts/kokoro-synth.py" \
    "$runtime_dir/media-assets/kokoro-v1.0.onnx" "$runtime_dir/media-assets/voices-v1.0.bin" 'Local computer ready.' af_nova 1 \
    "$runtime_dir/media-ready.wav" "$runtime_dir/espeak/root/usr/lib/libespeak-ng.so" "$runtime_dir/espeak/root/usr/share/espeak-ng-data" en-us >/dev/null
  rm -f "$runtime_dir/media-ready.wav"
  chmod 700 "$runtime_dir"
}

status() {
  [[ -x "$project_dir/tools/codex/apply_patch" ]] && echo 'apply_patch: ready' || echo 'apply_patch: missing'
  [[ -x "$project_dir/node_modules/.bin/playwright-mcp" ]] && echo 'Playwright MCP: ready' || echo 'Playwright MCP: missing'
  [[ -x "$project_dir/node_modules/.bin/hyperframes" ]] && echo 'HyperFrames: ready' || echo 'HyperFrames: missing'
  [[ -x "$runtime_dir/media-venv/bin/python" ]] && echo 'Kokoro runtime: ready' || echo 'Kokoro runtime: missing'
  sudo -n "$root_helper" / true >/dev/null 2>&1 && echo 'unattended root: ready' || echo 'unattended root: not enabled'
  if [[ -f "$runtime_dir/tunnel.pid" ]]; then
    tunnel_pid="$(<"$runtime_dir/tunnel.pid")"
    kill -0 "$tunnel_pid" 2>/dev/null && echo "tunnel: running pid $tunnel_pid" || echo "tunnel: stale pid $tunnel_pid"
  else
    echo 'tunnel: not running'
  fi
  systemctl --user is-enabled "$service_name" 2>/dev/null | sed 's/^/service enabled: /' || true
  systemctl --user is-active "$service_name" 2>/dev/null | sed 's/^/service active: /' || true
}

own_tunnel_pids() {
  expected="$(readlink -f "$project_dir/tools/tunnel/tunnel-client")"
  while read -r tunnel_pid; do
    [[ -n "$tunnel_pid" && "$(readlink -f "/proc/$tunnel_pid/exe" 2>/dev/null || true)" == "$expected" ]] && echo "$tunnel_pid"
  done < <(pgrep -x tunnel-client || true)
}

stop_tunnels() {
  while read -r tunnel_pid; do [[ -n "$tunnel_pid" ]] && kill "$tunnel_pid" 2>/dev/null || true; done < <(own_tunnel_pids)
  for _ in {1..50}; do
    if [[ -z "$(own_tunnel_pids)" ]]; then return 0; fi
    sleep 0.1
  done
  echo 'Existing tunnel client did not stop promptly.' >&2
  return 1
}

stop() {
  if systemctl --user is-active --quiet "$service_name"; then
    systemctl --user stop "$service_name"
  elif systemctl --user is-active --quiet "$legacy_service"; then
    systemctl --user stop "$legacy_service"
  else
    stop_tunnels
  fi
  echo 'Stopped the tunnel and all host command, terminal, and browser child processes.'
}

tunnel_args() {
  env_file="$runtime_dir/tunnel.env"
  [[ -f "$env_file" ]] || { echo "Missing $env_file; copy config/tunnel.env.example and chmod 600." >&2; return 1; }
  # shellcheck disable=SC1090
  source "$env_file"
  [[ "$CONTROL_PLANE_TUNNEL_ID" =~ ^tunnel_[0-9a-f]{32}$ ]] || { echo 'Invalid CONTROL_PLANE_TUNNEL_ID.' >&2; return 1; }
  [[ -f "$CONTROL_PLANE_API_KEY_FILE" ]] || { echo 'CONTROL_PLANE_API_KEY_FILE does not exist.' >&2; return 1; }
  [[ "$(stat -c %a "$CONTROL_PLANE_API_KEY_FILE")" == 600 ]] || { echo 'Runtime key file must have mode 600.' >&2; return 1; }
  mcp_command="/usr/bin/bash scripts/run-server.sh"
  common_args=(
    --control-plane.tunnel-id "$CONTROL_PLANE_TUNNEL_ID"
    --control-plane.api-key "file:$CONTROL_PLANE_API_KEY_FILE"
    --mcp.command "channel=main,command=$mcp_command"
    --health.listen-addr 127.0.0.1:0
    --health.url-file "$runtime_dir/tunnel-health.url"
    --pid.file "$runtime_dir/tunnel.pid"
    --log.http-raw-unsafe=false
  )
}

tunnel_doctor() ( cd "$project_dir"; tunnel_args; "$project_dir/tools/tunnel/tunnel-client" doctor --json --explain "${common_args[@]}"; )
tunnel_run() {
  cd "$project_dir"
  exec 9>"$runtime_dir/tunnel.lock"
  flock -n 9 || { echo 'Another Local Computer tunnel is already running.' >&2; return 1; }
  tunnel_args
  exec "$project_dir/tools/tunnel/tunnel-client" run --log.file "$runtime_dir/tunnel.log" --log.format json "${common_args[@]}"
}

install_service() (
  unit_dir="$HOME/.config/systemd/user"
  mkdir -p "$unit_dir"
  service_tmp="$(mktemp "$unit_dir/.local-computer-mcp.XXXXXX")"
  trap 'rm -f "$service_tmp"' EXIT
  # Render successfully before stopping an existing installation.
  node "$project_dir/scripts/render-service.mjs" >"$service_tmp"
  chmod 600 "$service_tmp"
  systemctl --user disable --now "$legacy_service" 2>/dev/null || true
  systemctl --user stop "$service_name" 2>/dev/null || true
  stop_tunnels
  rm -f "$unit_dir/$legacy_service"
  install -m600 "$service_tmp" "$unit_dir/$service_name"
  systemctl --user daemon-reload
  systemctl --user enable --now "$service_name"
)

uninstall_service() {
  systemctl --user disable --now "$service_name" "$legacy_service" 2>/dev/null || true
  rm -f "$HOME/.config/systemd/user/$service_name" "$HOME/.config/systemd/user/$legacy_service"
  systemctl --user daemon-reload
}

logs() { journalctl --user -u "$service_name" -n "${2:-100}" --no-pager; }

enable_root_access() {
  local_login="$(id -un)"
  sudoers_file="$(mktemp)"
  trap 'rm -f "$sudoers_file"' RETURN
  printf '%s ALL=(root) NOPASSWD: %s *\n' "$local_login" "$root_helper" >"$sudoers_file"
  sudo /usr/bin/install -Dm755 "$project_dir/scripts/root-command.sh" "$root_helper"
  sudo /usr/bin/visudo -cf "$sudoers_file"
  sudo /usr/bin/install -Dm440 "$sudoers_file" "$root_rule"
  sudo -n "$root_helper" / true
  echo 'Unattended root commands are enabled for Local Computer MCP.'
}

disable_root_access() {
  if sudo -n "$root_helper" / "rm -f '$root_rule' '$root_helper'" 2>/dev/null; then
    echo 'Unattended root commands are disabled.'
  else
    echo 'Root helper is not enabled; no privileged files were changed.'
  fi
}

uninstall() {
  uninstall_service
  stop_tunnels
  disable_root_access
  rm -rf "$runtime_dir/media-venv" "$runtime_dir/media-assets" "$runtime_dir/espeak" "$project_dir/tools/codex"
  echo 'Removed the service and project-local generated runtimes. Source, workspaces, artifacts, and job logs remain.'
}

case "${1:-}" in
  setup) setup ;;
  install-service) install_service ;;
  uninstall-service) uninstall_service ;;
  start) systemctl --user start "$service_name" ;;
  status) status ;;
  logs) logs "$@" ;;
  stop) stop ;;
  tunnel-doctor) tunnel_doctor ;;
  tunnel-run) tunnel_run ;;
  enable-root-access) enable_root_access ;;
  disable-root-access) disable_root_access ;;
  uninstall) uninstall ;;
  *) echo "Usage: $0 {setup|install-service|start|status|logs [lines]|stop|tunnel-doctor|enable-root-access|disable-root-access|uninstall-service|uninstall}" >&2; exit 2 ;;
esac
