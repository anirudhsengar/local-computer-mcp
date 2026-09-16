# Local Computer MCP

An always-on, single-user MCP server for files, shell commands, interactive terminals, Git repositories, network access, a dedicated Playwright browser, and local media production. ChatGPT supplies the reasoning; this project supplies computer tools and persistence. It connects through OpenAI Secure MCP Tunnel over stdio without opening a public listening port.

> **Security: this is unrestricted remote computer access, not a sandbox.** Authenticated tools can access the Unix user's files, credentials, processes, browser data, and private network. Optional unattended root access grants full machine control. Do not use a shared account or expose this server through an unauthenticated endpoint. Untrusted pages, repositories, and tool output can contain prompt injection. Publishing the source does not make an installation safe to share.

Source: [anirudhsengar/local-computer-mcp](https://github.com/anirudhsengar/local-computer-mcp).

## Supported environment

The pinned installers target **Linux x86_64 with systemd user services**. The media setup downloads Arch Linux/Omarchy packages; it is not a distribution-independent installer. Windows, macOS, ARM, and other distributions have not been qualified by this setup.

Requirements include Node.js 22+, npm, Python 3, a C/C++ build toolchain for native Node dependencies, Bash, curl, unzip, uv, bsdtar, Git, ripgrep, FFmpeg/ffprobe, and the host libraries needed by Chromium. Setup installs pinned project-local Node dependencies, Chromium, the Codex `apply_patch` binary, and Kokoro/espeak assets. It does not install global packages.

Secure MCP Tunnel requires your own provisioned tunnel and runtime credentials. Follow the [official tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) for account setup and supported client connections. Each user must configure their own installation and credentials. Open-source distribution of this repository is separate from public plugin distribution; Secure MCP Tunnel is for private connections, not public plugin submission.

## Install

Clone the repository into the directory where you intend to keep it, then run these commands from its root:

```bash
bash scripts/install-tunnel-client.sh
bash scripts/ops.sh setup
umask 077
install -d -m700 runtime
if [ ! -e runtime/tunnel.env ]; then
  install -m600 config/tunnel.env.example runtime/tunnel.env
fi
```

Edit `runtime/tunnel.env` with your own tunnel ID and an absolute path to your runtime API key file. Save that key locally with mode `0600`; do not put it in source files, shell history, issues, screenshots, or chat messages. The example tunnel ID is a placeholder. Use a runtime credential with only Tunnels Read + Use; administrative tunnel credentials are not required for the running server.

Then validate and install the service:

```bash
npm test
bash scripts/ops.sh tunnel-doctor
bash scripts/ops.sh install-service
bash scripts/ops.sh status
```

`install-service` generates a private user unit using the actual installation directory and the Node executable running the generator. Do not copy the service template manually. Re-run installation after moving the checkout or removing/upgrading that Node installation. The service uses `Restart=always` and `KillMode=control-group`. Boot without login additionally requires user lingering; it is not enabled automatically. Administrators who intend this behavior can enable it with `sudo loginctl enable-linger "$USER"`.

## Operate

```bash
bash scripts/ops.sh start
bash scripts/ops.sh status
bash scripts/ops.sh logs 100
bash scripts/ops.sh stop
bash scripts/ops.sh uninstall-service
bash scripts/ops.sh uninstall
```

`stop` stops the service and its command, terminal, and browser process group. `uninstall` also disables the optional root helper and removes generated Codex/Kokoro/espeak runtimes. It preserves source, workspaces, artifacts, browser profiles, job records, and tunnel credentials. It is **not** a secure data-erasure or credential-revocation operation.

Root access is a separate, deliberate opt-in:

```bash
bash scripts/ops.sh enable-root-access
bash scripts/ops.sh disable-root-access
```

Enabling it requires local sudo authorization and installs a root-owned helper plus a sudoers rule. The helper intentionally runs arbitrary commands: its narrowly named sudoers entry is not a command sandbox. `exec_command root:true` then becomes unattended. The MCP never receives the sudo password. Leave this disabled unless the full trust implications are acceptable.

## Tools

- `computer_status`: host identity, resources, installed components, and active work.
- `workspace`: list, create, locate, or archive named working directories.
- `read_file`: stat/list/read absolute paths, optionally page results, return base64, and calculate SHA-256.
- `write_file`: atomic writes/patches, copy, cross-filesystem move, mkdir, safe archive extraction, and permanent deletion.
- `import_file`: import ChatGPT attachments using `openai/fileParams`.
- `fetch_url`: fetch HTTP(S), follow redirects, or stream downloads to absolute paths, including localhost/private addresses.
- `exec_command`: persistent shell jobs or interactive PTYs, with optional root execution.
- `write_stdin`: send input, resize, poll, or terminate an interactive terminal.
- `process`: list, inspect, read logs, or cancel durable command and media jobs.
- `repository`: Git state, `AGENTS.md` discovery, ripgrep search, and diffs.
- `apply_patch`: deterministic Codex-format multi-file patches without invoking another model.
- `media`: HyperFrames checks/renders, local Kokoro narration, ffprobe, frames, clips, contact sheets, and decode checks.
- `browser`: Playwright MCP tools in dedicated named profiles.
- `artifact`: regular files as MCP `resource_link` output; images and requested text can also be returned directly.

## Jobs and parallel chats

Job states are `queued`, `running`, `succeeded`, `failed`, `cancelled`, and `interrupted`. Non-PTY commands return job IDs, terminal exit codes, durable logs, and optional artifact paths. Idempotency keys prevent duplicate submission. Accepted jobs can continue after a chat disconnect, but ChatGPT does not automatically keep thinking or polling. Restart cleanup terminates abandoned process groups and records them as interrupted.

Use a different workspace/directory and `browser.session` name per chat. Connections and profiles are independent, but all chats share one Unix account, filesystem, hardware, and external accounts. Concurrent edits to the same checkout or path can conflict. Dedicated browser profiles do not prevent unrestricted shell/file tools from reaching other user-readable profiles or credentials.

## Data and trust boundaries

Tool arguments and results pass through OpenAI. Local execution does not mean requested content, command output, screenshots, or frames stay only on the computer. Authentication is provided by Secure MCP Tunnel; after authentication, computer access is governed by Unix/root permissions, not a project sandbox.

There is no server-defined path or command allowlist, private-network block, concurrency queue, rate limit, file/request/response/archive size ceiling, or default execution timeout. Explicit timeouts and paging remain available. Physical RAM/disk/CPU, OS representation limits, upstream services, and OpenAI transport/context behavior still impose limits. Large requests can exhaust the host or fail in transit.

`import_file` sanitizes attachment fallback filenames, refuses accidental overwrite, and returns byte counts and hashes. `artifact` references include size, MIME type, modification time, and SHA-256, with stale-byte rejection on retrieval. Resource bytes travel as base64 through `resources/read`; test actual materialization in the client rather than treating a path or metadata as proof of delivery.

Keep runtime state, browser profiles, workspaces, artifacts, logs, and credentials out of Git. `.gitignore` helps prevent accidental additions, but it does not remove tracked files or historical content. Before sharing a repository, scan all refs and history as well as the current tree. Never attach raw diagnostic output without reviewing it for secrets and personal details.

## Development and validation

`npm test` runs the repository's tests, including service-generation regressions. The integration suite uses separate state but exercises real host tools and network/browser behavior; run it only on a suitable development host. For service-only tests without downloading media assets, run `node --test test/service.test.mjs`.

See [VALIDATION.md](VALIDATION.md) for the validation procedure and [CHATGPT_HANDOFF.md](CHATGPT_HANDOFF.md) for reusable client checks. Neither file contains installation-specific credentials or private execution records.

The project reuses the Apache-2.0 standalone `apply_patch` component from Codex CLI. It does not invoke `codex exec`, a paid model API, another AI agent, or an orchestration framework. ChatGPT confirmations, tool selection, context limits, and lifecycle remain client-controlled. Keep third-party license and notice files when redistributing the project; the project itself is MIT-licensed.
