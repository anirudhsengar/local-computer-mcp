import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import { Jobs } from "./jobs.mjs";
import { Terminals } from "./terminals.mjs";
import { absolutePath, hostEnvironment } from "./host.mjs";
import { atomicWrite, contentTypeExtension } from "./files.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = path.join(projectRoot, "workspaces");
const artifactRoot = path.join(projectRoot, "artifacts");
const runtimeRoot = path.join(projectRoot, "runtime");
const stateRoot = process.env.LOCAL_COMPUTER_MCP_STATE_ROOT ? absolutePath(process.env.LOCAL_COMPUTER_MCP_STATE_ROOT, "LOCAL_COMPUTER_MCP_STATE_ROOT") : runtimeRoot;
const patchBinary = path.join(projectRoot, "tools", "codex", "apply_patch");
const browserBinary = path.join(projectRoot, "node_modules", ".bin", "playwright-mcp");
const hyperframesBinary = path.join(projectRoot, "node_modules", ".bin", "hyperframes");
const mediaBin = path.join(runtimeRoot, "media-venv", "bin");
const mediaAssets = path.join(runtimeRoot, "media-assets");
const espeakRoot = path.join(runtimeRoot, "espeak", "root");
const rootHelper = "/usr/local/libexec/local-computer-mcp-root";
await Promise.all([workspaceRoot, artifactRoot, runtimeRoot, stateRoot].map((dir) => fsp.mkdir(dir, { recursive: true })));
const jobs = new Jobs({ runtimeRoot: stateRoot });
const terminals = new Terminals(stateRoot);

const server = new McpServer({ name: "local-computer", version: "2.2.0" }, {
  instructions: "This server runs directly on the user's laptop as their Unix account with unrestricted filesystem, process, network, desktop-session, and credential access. Use absolute paths. Use repository/read_file before edits, apply_patch for code changes, exec_command for commands, write_stdin for interactive terminals, and process for durable job status/logs/cancellation. Give concurrent chats different workspace and browser-session names. ChatGPT is the only reasoning agent; this server does not launch Codex or another model. Tool arguments and results pass through OpenAI."
});

const annotations = {
  read: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  write: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  external: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
};
const text = (value) => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }], structuredContent: value });
const fail = (error) => ({ isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] });
const tool = (name, config, handler) => server.registerTool(name, config, async (args, extra) => {
  try { return await handler(args, extra); } catch (error) { return fail(error); }
});

const workspaceSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
const absoluteSchema = z.string().refine((value) => value.startsWith("/") && !value.includes("\0"), "must be an absolute path without NUL bytes");
const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const cleanName = (value, label = "name") => {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value)) throw new Error(`${label} must contain only letters, numbers, dots, underscores, and hyphens, and start with a letter or number`);
  return value;
};

tool("computer_status", {
  title: "Inspect local computer", description: "Report the direct-host identity, operating system, tool readiness, active work, and unrestricted access mode.",
  inputSchema: {}, annotations: annotations.read
}, async () => {
  const browserSessions = [...browserClients.keys()];
  const rootCheck = await runHost("/usr/bin/sudo", ["-n", rootHelper, "/", "true"]);
  return text({
    ok: true,
    server: "local-computer",
    version: "2.2.0",
    access: "unrestricted-host-user",
    user: os.userInfo().username,
    uid: process.getuid?.(),
    home: os.homedir(),
    platform: os.platform(),
    release: os.release(),
    architecture: os.arch(),
    cpus: os.cpus().length,
    memory_bytes: { total: os.totalmem(), free: os.freemem() },
    roots: { workspaces: workspaceRoot, artifacts: artifactRoot, filesystem: "/" },
    restrictions: {
      filesystem: false, commands: false, network: false, private_addresses: false, concurrency: false, runtime: false,
      request_size: false, response_size: false, file_size: false, archive_size: false
    },
    unattended_root: rootCheck.code === 0,
    tools: {
      apply_patch: fs.existsSync(patchBinary),
      playwright: fs.existsSync(browserBinary),
      hyperframes: fs.existsSync(hyperframesBinary),
      kokoro: fs.existsSync(path.join(mediaBin, "python3")),
      ffmpeg: fs.existsSync("/usr/bin/ffmpeg"),
      git: fs.existsSync("/usr/bin/git")
    },
    active_jobs: jobs.list().filter((job) => ["queued", "running"].includes(job.status)).length,
    active_terminal_sessions: [...terminals.sessions.values()].filter((session) => session.state.running).length,
    browser_sessions: browserSessions
  });
});

tool("workspace", {
  title: "Manage workspaces", description: "List, create, locate, or archive named working directories. Workspaces are a convenience; other tools accept any absolute host path.",
  inputSchema: { action: z.enum(["list", "create", "path", "archive"]), name: workspaceSchema.optional() }, annotations: annotations.write
}, async ({ action, name }) => {
  if (action === "list") {
    const entries = await fsp.readdir(workspaceRoot, { withFileTypes: true });
    return text({ workspaces: entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")).map((entry) => ({ name: entry.name, path: path.join(workspaceRoot, entry.name) })).sort((a, b) => a.name.localeCompare(b.name)) });
  }
  cleanName(name, "workspace");
  const target = path.join(workspaceRoot, name);
  if (action === "create") await fsp.mkdir(target, { recursive: true });
  if (action === "archive") {
    await fsp.access(target);
    const output = path.join(artifactRoot, `${name}-${new Date().toISOString().replaceAll(":", "-")}.tar.gz`);
    const result = await runHost("/usr/bin/tar", ["-C", workspaceRoot, "-czf", output, "--", name]);
    if (result.code !== 0) throw new Error(result.stderr || "archive failed");
    return text({ name, path: target, archive: output, bytes: (await fsp.stat(output)).size });
  }
  return text({ name, path: target });
});

tool("read_file", {
  title: "Read files and directories", description: "Stat, list, or page through any absolute file path available to the host user. Binary data can be returned as base64.",
  inputSchema: {
    action: z.enum(["stat", "list", "read"]), path: absoluteSchema,
    cursor: z.number().int().min(0).default(0), limit: z.number().int().min(1).optional(),
    offset: z.number().int().min(0).default(0), max_bytes: z.number().int().min(1).optional(),
    encoding: z.enum(["utf8", "base64"]).default("utf8"), hash: z.boolean().default(false)
  }, annotations: annotations.read
}, async (args) => {
  const target = absolutePath(args.path);
  if (args.action === "stat") return text(await metadata(target, args.hash));
  if (args.action === "list") {
    const entries = (await fsp.readdir(target, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    const page = args.limit === undefined ? entries.slice(args.cursor) : entries.slice(args.cursor, args.cursor + args.limit);
    return text({ path: target, entries: await Promise.all(page.map((entry) => metadata(path.join(target, entry.name), false))), next_cursor: args.cursor + page.length < entries.length ? args.cursor + page.length : null, total: entries.length });
  }
  const stat = await fsp.stat(target);
  if (!stat.isFile()) throw new Error("path is not a regular file");
  const handle = await fsp.open(target, "r");
  const remaining = Math.max(0, stat.size - args.offset);
  const length = args.max_bytes === undefined ? remaining : Math.min(args.max_bytes, remaining);
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, args.offset);
  await handle.close();
  const data = buffer.subarray(0, bytesRead);
  return text({ path: target, offset: args.offset, bytes: bytesRead, next_offset: args.offset + bytesRead, truncated: args.offset + bytesRead < stat.size, encoding: args.encoding, content: data.toString(args.encoding), ...(args.hash ? { sha256: await sha256(target) } : {}) });
});

tool("write_file", {
  title: "Modify files and directories", description: "Write, patch, copy, move, create, extract, or permanently delete any absolute path available to the host user.",
  inputSchema: {
    action: z.enum(["write", "patch", "copy", "move", "mkdir", "extract", "delete"]), path: absoluteSchema,
    content: z.string().optional(), encoding: z.enum(["utf8", "base64"]).default("utf8"), old_text: z.string().optional(), new_text: z.string().optional(),
    destination: absoluteSchema.optional(), overwrite: z.boolean().default(false), recursive: z.boolean().default(false)
  }, annotations: annotations.write
}, async (args) => {
  const target = absolutePath(args.path);
  if (args.action === "write") {
    if (args.content === undefined) throw new Error("content is required");
    await atomicWrite(target, Buffer.from(args.content, args.encoding), args.overwrite);
  } else if (args.action === "patch") {
    if (args.old_text === undefined || args.new_text === undefined) throw new Error("old_text and new_text are required");
    const current = await fsp.readFile(target, "utf8");
    const first = current.indexOf(args.old_text);
    if (first < 0) throw new Error("old_text not found");
    if (current.indexOf(args.old_text, first + args.old_text.length) >= 0) throw new Error("old_text is not unique");
    await atomicWrite(target, current.slice(0, first) + args.new_text + current.slice(first + args.old_text.length), true);
  } else if (args.action === "mkdir") {
    await fsp.mkdir(target, { recursive: args.recursive });
  } else if (args.action === "delete") {
    await fsp.rm(target, { recursive: args.recursive, force: false });
    return text({ deleted: target });
  } else {
    if (!args.destination) throw new Error("destination is required");
    const destination = absolutePath(args.destination, "destination");
    if (args.action === "copy") await fsp.cp(target, destination, { recursive: args.recursive, force: args.overwrite, errorOnExist: !args.overwrite });
    if (args.action === "move") {
      if (!args.overwrite) await assertMissing(destination);
      await fsp.mkdir(path.dirname(destination), { recursive: true });
      try { await fsp.rename(target, destination); }
      catch (error) {
        if (error.code !== "EXDEV") throw error;
        await fsp.cp(target, destination, { recursive: true, force: args.overwrite, errorOnExist: !args.overwrite });
        await fsp.rm(target, { recursive: true });
      }
    }
    if (args.action === "extract") {
      const result = await runHost("/usr/bin/python3", [path.join(projectRoot, "src", "archive-helper.py"), target, destination]);
      if (result.code !== 0) throw new Error(result.stderr || "archive extraction failed");
    }
    return text({ action: args.action, path: target, destination });
  }
  return text(await metadata(target, true));
});

const openAIFile = z.strictObject({
  download_url: z.string(), file_id: z.string(), mime_type: z.string().optional(), file_name: z.string().optional()
});
tool("import_file", {
  title: "Import ChatGPT attachment", description: "Download a temporary ChatGPT file reference to an exact absolute path or a named workspace without logging the signed URL.",
  inputSchema: { file: openAIFile, destination: absoluteSchema.optional(), workspace: workspaceSchema.optional() }, annotations: annotations.external,
  _meta: { "openai/fileParams": ["file"] }
}, async ({ file, destination, workspace }) => {
  let target = destination;
  if (!target) {
    if (!workspace) throw new Error("destination or workspace is required");
    const fallback = safeFilename(file.file_name) || `${file.file_id}${contentTypeExtension(file.mime_type)}`;
    target = path.join(await workspacePath(workspace), "imports", fallback);
  }
  const result = await downloadToFile(file.download_url, target, false);
  return text({ file_id: file.file_id, path: target, ...result });
});

tool("fetch_url", {
  title: "Fetch any URL", description: "Fetch HTTP(S) through the laptop network, including localhost and private addresses. Downloads can stream to an absolute path; inline responses have no server-defined size ceiling.",
  inputSchema: {
    url: z.string().url(), destination: absoluteSchema.optional(), overwrite: z.boolean().default(false),
    timeout_seconds: z.number().positive().optional(), max_inline_bytes: z.number().int().min(1).optional()
  }, annotations: annotations.external
}, async ({ url, destination, overwrite, timeout_seconds, max_inline_bytes }) => {
  if (destination) return text({ url, path: destination, ...(await downloadToFile(url, destination, overwrite, timeout_seconds)) });
  const response = await fetchChecked(url, timeout_seconds);
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (max_inline_bytes !== undefined && bytes > max_inline_bytes) throw new Error(`inline response exceeds ${max_inline_bytes} bytes; provide destination to stream it to disk`);
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);
  const contentType = response.headers.get("content-type") || "application/octet-stream";
  const textual = /^(text\/|application\/(json|xml|javascript))/.test(contentType);
  return text({ url: response.url, status: response.status, content_type: contentType, bytes: body.length, encoding: textual ? "utf8" : "base64", content: body.toString(textual ? "utf8" : "base64") });
});

tool("exec_command", {
  title: "Execute a host command", description: "Run any command as the logged-in Unix user or, when enabled and root=true, through the root-owned helper. Set tty=true for an interactive PTY; otherwise a persistent job ID is returned.",
  inputSchema: {
    command: z.string().min(1), cwd: absoluteSchema.default(os.homedir()), root: z.boolean().default(false), tty: z.boolean().default(false),
    shell: absoluteSchema.optional(), cols: z.number().int().positive().default(120), rows: z.number().int().positive().default(30),
    timeout_seconds: z.number().positive().optional(), wait_ms: z.number().int().min(0).default(1000), idempotency_key: z.string().optional()
  }, annotations: annotations.external
}, async (args) => {
  const sudoCompatible = args.command.startsWith("sudo -n ");
  const root = args.root || sudoCompatible;
  const requestedCommand = sudoCompatible ? args.command.slice("sudo -n ".length) : args.command;
  if (root && !fs.existsSync(rootHelper)) throw new Error("unattended root is not enabled; run locally: bash scripts/ops.sh enable-root-access");
  const command = root ? `/usr/bin/sudo -n ${shellQuote(rootHelper)} ${shellQuote(args.cwd)} ${shellQuote(requestedCommand)}` : requestedCommand;
  const cwd = root ? projectRoot : args.cwd;
  if (args.tty) {
    const state = await terminals.start({ command, cwd, shell: args.shell, cols: args.cols, rows: args.rows });
    return text({ kind: "terminal", ...(await terminals.interact({ id: state.id, offset: 0, yieldTimeMs: args.wait_ms })) });
  }
  const job = await jobs.submit({ kind: root ? "root-command" : "command", command, cwd, timeoutSeconds: args.timeout_seconds, idempotencyKey: args.idempotency_key });
  if (args.wait_ms) await waitForJob(job.id, args.wait_ms);
  return text({ kind: "job", ...jobs.get(job.id), ...(await jobs.logs(job.id, 0)) });
});

tool("write_stdin", {
  title: "Interact with a terminal", description: "Write input, resize, poll output, or terminate a PTY returned by exec_command with tty=true.",
  inputSchema: {
    session_id: z.string(), chars: z.string().optional(), offset: z.number().int().min(0).optional(),
    yield_time_ms: z.number().int().min(0).default(250), max_bytes: z.number().int().min(1).optional(),
    cols: z.number().int().positive().optional(), rows: z.number().int().positive().optional(), terminate: z.boolean().default(false)
  }, annotations: annotations.external
}, async (args) => text(await terminals.interact({ id: args.session_id, chars: args.chars, offset: args.offset, yieldTimeMs: args.yield_time_ms, maxBytes: args.max_bytes, cols: args.cols, rows: args.rows, terminate: args.terminate })));

tool("process", {
  title: "Inspect or stop command jobs", description: "List jobs, get exact status and exit code, page complete logs, or cancel an unrestricted host command.",
  inputSchema: {
    action: z.enum(["list", "status", "logs", "cancel"]), job_id: z.string().optional(), limit: z.number().int().min(1).optional(),
    offset: z.number().int().min(0).default(0), max_bytes: z.number().int().min(1).optional()
  }, annotations: annotations.external
}, async ({ action, job_id, limit, offset, max_bytes }) => {
  if (action === "list") return text({ jobs: jobs.list(limit) });
  if (!job_id) throw new Error("job_id is required");
  if (action === "status") return text(jobs.get(job_id));
  if (action === "logs") return text(await jobs.logs(job_id, offset, max_bytes));
  return text(await jobs.cancel(job_id));
});

tool("repository", {
  title: "Inspect and search a repository", description: "Inspect Git state and AGENTS.md files, search with ripgrep, or read a Git diff from any absolute working directory.",
  inputSchema: {
    action: z.enum(["inspect", "search", "diff"]), cwd: absoluteSchema, query: z.string().optional(), staged: z.boolean().default(false), context: z.number().int().min(0).default(3)
  }, annotations: annotations.read
}, async ({ action, cwd, query, staged, context }) => {
  let command;
  if (action === "inspect") command = "git rev-parse --show-toplevel && git status --short --branch && git diff --check && find . -name AGENTS.md -not -path './.git/*' -not -path './node_modules/*' -print | sort";
  if (action === "search") {
    if (!query) throw new Error("query is required for search");
    command = `rg -n --hidden --glob '!.git' -- ${shellQuote(query)} .`;
  }
  if (action === "diff") command = `git diff --no-ext-diff --no-textconv --unified=${context}${staged ? " --cached" : ""} -- .`;
  const result = await runHost("/usr/bin/bash", ["-lc", command], { cwd });
  return text({ cwd, action, exit_code: result.code, stdout: result.stdout, stderr: result.stderr, truncated: result.truncated });
});

tool("apply_patch", {
  title: "Apply a Codex patch", description: "Apply a multi-file Codex-format patch directly within any absolute working directory using the pinned open-source Codex patch engine.",
  inputSchema: { cwd: absoluteSchema, patch: z.string().min(1) }, annotations: annotations.write
}, async ({ cwd, patch }) => {
  if (!fs.existsSync(patchBinary)) throw new Error("apply_patch is not installed; run: bash scripts/ops.sh setup");
  const result = await runHost(patchBinary, [], { cwd, input: patch });
  if (result.code !== 0) throw new Error(result.stderr || result.stdout || `apply_patch exited ${result.code}`);
  return text({ cwd, exit_code: result.code, output: result.stdout, stderr: result.stderr });
});

tool("media", {
  title: "Create and inspect media", description: "Run project-local HyperFrames, Kokoro, FFmpeg, and ffprobe directly on host paths. Operations return persistent job IDs.",
  inputSchema: {
    action: z.enum(["hyperframes_check", "narrate", "render", "probe", "frame", "clip", "contact_sheet", "decode_check"]), cwd: absoluteSchema,
    input: z.string().optional(), output: z.string().optional(), text: z.string().optional(), voice: z.string().default("af_nova"),
    at: z.number().min(0).optional(), duration: z.number().positive().optional(), idempotency_key: z.string().optional()
  }, annotations: annotations.external
}, async (args) => {
  const input = args.input || ".";
  const output = args.output;
  const env = `PATH=${shellQuote(`${mediaBin}:${path.dirname(hyperframesBinary)}`)}:$PATH HYPERFRAMES_TELEMETRY_DISABLED=1`;
  let command;
  let artifacts = [];
  if (args.action === "hyperframes_check") command = `${env} hyperframes check ${shellQuote(input)} --json --strict --at-transitions`;
  if (args.action === "narrate") {
    if (!args.text || !output) throw new Error("text and output are required");
    command = `LD_LIBRARY_PATH=${shellQuote(path.join(espeakRoot, "usr/lib"))} ${shellQuote(path.join(mediaBin, "python"))} ${shellQuote(path.join(projectRoot, "scripts/kokoro-synth.py"))} ${shellQuote(path.join(mediaAssets, "kokoro-v1.0.onnx"))} ${shellQuote(path.join(mediaAssets, "voices-v1.0.bin"))} ${shellQuote(args.text)} ${shellQuote(args.voice)} 1 ${shellQuote(output)} ${shellQuote(path.join(espeakRoot, "usr/lib/libespeak-ng.so"))} ${shellQuote(path.join(espeakRoot, "usr/share/espeak-ng-data"))} en-us`;
    artifacts = [path.resolve(args.cwd, output)];
  }
  if (args.action === "render") {
    if (!output) throw new Error("output is required");
    command = `${env} hyperframes render ${shellQuote(input)} --output ${shellQuote(output)} --fps 30 --strict`;
    artifacts = [path.resolve(args.cwd, output)];
  }
  if (args.action === "probe") command = `/usr/bin/ffprobe -v error -show_streams -show_format -of json ${shellQuote(input)}`;
  if (args.action === "frame") {
    if (!output) throw new Error("output is required");
    command = `/usr/bin/ffmpeg -v error -ss ${Number(args.at || 0)} -i ${shellQuote(input)} -frames:v 1 -y ${shellQuote(output)}`;
    artifacts = [path.resolve(args.cwd, output)];
  }
  if (args.action === "clip") {
    if (!output || !args.duration) throw new Error("output and duration are required");
    command = `/usr/bin/ffmpeg -v error -ss ${Number(args.at || 0)} -i ${shellQuote(input)} -t ${Number(args.duration)} -c:v libx264 -c:a aac -y ${shellQuote(output)}`;
    artifacts = [path.resolve(args.cwd, output)];
  }
  if (args.action === "contact_sheet") {
    if (!output) throw new Error("output is required");
    command = `/usr/bin/ffmpeg -v error -i ${shellQuote(input)} -vf "fps=1,scale=270:-1,tile=5x1" -frames:v 1 -y ${shellQuote(output)}`;
    artifacts = [path.resolve(args.cwd, output)];
  }
  if (args.action === "decode_check") command = `/usr/bin/ffmpeg -v error -i ${shellQuote(input)} -f null -`;
  return text(await jobs.submit({ kind: `media:${args.action}`, command, cwd: args.cwd, idempotencyKey: args.idempotency_key, artifacts }));
});

const browserClients = new Map();
const browserStarts = new Map();
const browserSerial = new Map();
async function getBrowser(session) {
  if (browserClients.has(session)) return browserClients.get(session);
  if (browserStarts.has(session)) return browserStarts.get(session);
  const starting = connectBrowser(session);
  browserStarts.set(session, starting);
  try { return await starting; } finally { browserStarts.delete(session); }
}
async function connectBrowser(session) {
  cleanName(session, "browser session");
  const profile = path.join(stateRoot, "browser-profiles", session);
  const output = path.join(workspaceRoot, "browser-sessions", session);
  await Promise.all([profile, output].map((directory) => fsp.mkdir(directory, { recursive: true, mode: 0o700 })));
  const transport = new StdioClientTransport({
    command: browserBinary,
    args: ["--headless", "--browser", "chromium", "--no-sandbox", "--allow-unrestricted-file-access", "--user-data-dir", profile, "--output-dir", output, "--image-responses", "allow", "--shared-browser-context"],
    cwd: output,
    env: hostEnvironment(),
    stderr: "pipe"
  });
  transport.stderr.pipe(fs.createWriteStream(path.join(output, "playwright-mcp.log"), { flags: "a", mode: 0o600 }));
  const client = new Client({ name: "local-computer-browser", version: "2.2.0" }, { capabilities: {} });
  await client.connect(transport);
  browserClients.set(session, client);
  return client;
}
tool("browser", {
  title: "Control a browser", description: "List or call maintained Playwright MCP browser tools in an unrestricted host browser. Use a distinct session name per concurrent chat.",
  inputSchema: { action: z.enum(["list_tools", "call"]), session: workspaceSchema.default("default"), tool: z.string().optional(), arguments: z.record(z.string(), z.json()).default({}) },
  annotations: annotations.external
}, async ({ action, session, tool: toolName, arguments: args }) => {
  const client = await getBrowser(session);
  if (action === "list_tools") return text(await client.listTools());
  if (!toolName?.startsWith("browser_")) throw new Error("tool must be a Playwright browser_* tool");
  const prior = browserSerial.get(session) || Promise.resolve();
  const result = prior.then(() => client.callTool({ name: toolName, arguments: args }));
  browserSerial.set(session, result.catch(() => {}));
  return await result;
});

tool("artifact", {
  title: "Transfer a laptop file", description: "Return any laptop file as a standard MCP file reference that ChatGPT can retrieve through this tunnel. Images are also returned as model-visible image content; requested text is also returned inline.",
  inputSchema: { path: absoluteSchema, max_bytes: z.number().int().min(1).optional() }, annotations: annotations.read
}, async ({ path: target, max_bytes }) => {
  target = absolutePath(target);
  const stat = await fsp.stat(target);
  if (!stat.isFile()) throw new Error("artifact is not a file");
  const mime = mimeFromPath(target);
  const digest = await sha256(target);
  const uri = fileResourceUri(target, digest);
  const meta = { path: target, bytes: stat.size, mime_type: mime, sha256: digest, resource_uri: uri, delivery: "mcp-resource-link" };
  const link = {
    type: "resource_link", uri, name: path.basename(target), title: path.basename(target), mimeType: mime, size: stat.size,
    description: `Exact laptop file ${target}`,
    annotations: { audience: ["user", "assistant"], priority: 1, lastModified: stat.mtime.toISOString() }
  };
  if (mime.startsWith("image/")) {
    return { content: [{ type: "image", data: (await fsp.readFile(target)).toString("base64"), mimeType: mime }, link, { type: "text", text: JSON.stringify(meta) }], structuredContent: meta };
  }
  if (mime.startsWith("text/") && (max_bytes === undefined || stat.size <= max_bytes)) {
    const inline = { ...meta, content: await fsp.readFile(target, "utf8") };
    return { content: [link, { type: "text", text: JSON.stringify(inline, null, 2) }], structuredContent: inline };
  }
  return { content: [link, { type: "text", text: JSON.stringify(meta, null, 2) }], structuredContent: meta };
});

server.registerResource("status", "local-computer://status", { title: "Local Computer MCP status", mimeType: "application/json" }, async (uri) => ({
  contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify({ version: "2.2.0", access: "unrestricted host user", tunnel: "official authenticated Secure MCP Tunnel", reasoningAgent: "ChatGPT only" }, null, 2) }]
}));

server.registerResource(
  "laptop-file",
  new ResourceTemplate("local-computer://file/{sha256}/{encodedPath}", { list: undefined }),
  { title: "Laptop file", description: "Exact file bytes referenced by the artifact tool." },
  async (uri, { sha256: expected, encodedPath }) => {
    if (!/^[0-9a-f]{64}$/.test(expected)) throw new Error("invalid file resource hash");
    const target = decodeFilePath(encodedPath);
    const stat = await fsp.stat(target);
    if (!stat.isFile()) throw new Error("file resource is not a regular file");
    const data = await fsp.readFile(target);
    if (crypto.createHash("sha256").update(data).digest("hex") !== expected) throw new Error("file changed after the resource link was created; call artifact again");
    return { contents: [{ uri: uri.href, mimeType: mimeFromPath(target), blob: data.toString("base64") }] };
  }
);

async function workspacePath(name) {
  cleanName(name, "workspace");
  const target = path.join(workspaceRoot, name);
  await fsp.access(target);
  return target;
}

async function metadata(target, hash) {
  const stat = await fsp.lstat(target);
  const result = { path: target, name: path.basename(target), type: stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other", bytes: stat.size, modified: stat.mtime.toISOString(), mode: (stat.mode & 0o7777).toString(8), uid: stat.uid, gid: stat.gid };
  if (hash && stat.isFile()) result.sha256 = await sha256(target);
  if (stat.isSymbolicLink()) result.target = await fsp.readlink(target);
  return result;
}

async function sha256(file) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function assertMissing(target) {
  try { await fsp.lstat(target); throw new Error("destination exists; set overwrite=true"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}

function safeFilename(value) {
  if (!value) return "";
  const name = path.basename(value.replaceAll("\\", "/")).replace(/[^a-zA-Z0-9._-]/g, "_");
  return name === "." || name === ".." ? "" : name;
}

const fileResourceUri = (target, digest) => `local-computer://file/${digest}/${Buffer.from(target, "utf8").toString("base64url")}`;

function decodeFilePath(encoded) {
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error("invalid file resource path");
  const target = Buffer.from(encoded, "base64url").toString("utf8");
  if (Buffer.from(target, "utf8").toString("base64url") !== encoded) throw new Error("invalid file resource encoding");
  return absolutePath(target);
}

function mimeFromPath(file) {
  const ext = path.extname(file).toLowerCase();
  return ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".mp4": "video/mp4", ".webm": "video/webm", ".wav": "audio/wav", ".mp3": "audio/mpeg", ".json": "application/json", ".txt": "text/plain", ".md": "text/markdown", ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript" })[ext] || "application/octet-stream";
}

async function fetchChecked(url, timeoutSeconds) {
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("only http/https URLs are supported");
  const response = await fetch(parsed, { redirect: "follow", signal: timeoutSeconds ? AbortSignal.timeout(timeoutSeconds * 1000) : undefined, headers: { "user-agent": "local-computer-mcp/2.2.0" } });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText} from ${response.url}`);
  return response;
}

async function downloadToFile(url, target, overwrite, timeoutSeconds) {
  absolutePath(target, "destination");
  if (!overwrite) await assertMissing(target);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  const response = await fetchChecked(url, timeoutSeconds);
  try {
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(temp, { flags: "wx", mode: 0o600 }));
    await fsp.rename(temp, target);
  } catch (error) {
    await fsp.rm(temp, { force: true });
    throw error;
  }
  const stat = await fsp.stat(target);
  return { final_url: response.url, status: response.status, content_type: response.headers.get("content-type") || "application/octet-stream", bytes: stat.size, sha256: await sha256(target) };
}

function runHost(command, args, { cwd = projectRoot, input, timeoutMs, maxBytes = Infinity } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env: hostEnvironment(), stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    const collect = (chunks, bytes, chunk) => {
      if (bytes >= maxBytes) { truncated = true; return bytes; }
      const kept = chunk.subarray(0, maxBytes - bytes);
      if (kept.length < chunk.length) truncated = true;
      chunks.push(kept);
      return bytes + kept.length;
    };
    child.stdout.on("data", (chunk) => { stdoutBytes = collect(stdout, stdoutBytes, chunk); });
    child.stderr.on("data", (chunk) => { stderrBytes = collect(stderr, stderrBytes, chunk); });
    if (input !== undefined) child.stdin.end(input);
    const timer = timeoutMs ? setTimeout(() => child.kill("SIGKILL"), timeoutMs) : null;
    let settled = false;
    const finish = (result) => { if (settled) return; settled = true; if (timer) clearTimeout(timer); resolve(result); };
    child.on("error", (error) => finish({ code: null, stdout: Buffer.concat(stdout).toString("utf8"), stderr: error.message, truncated }));
    child.on("close", (code) => finish({ code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), truncated }));
  });
}

async function waitForJob(id, waitMs) {
  const end = Date.now() + waitMs;
  while (Date.now() < end) {
    if (!["queued", "running"].includes(jobs.get(id).status)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

await server.connect(new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: Infinity }));
