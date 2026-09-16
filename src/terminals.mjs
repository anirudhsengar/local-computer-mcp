import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pty from "node-pty";
import { absolutePath, hostEnvironment } from "./host.mjs";

export class Terminals {
  constructor(runtimeRoot) {
    this.root = path.join(runtimeRoot, "terminals");
    this.sessions = new Map();
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    for (const name of fs.readdirSync(this.root).filter((item) => item.endsWith(".json"))) {
      const file = path.join(this.root, name);
      try {
        const state = JSON.parse(fs.readFileSync(file, "utf8"));
        if (state.running) {
          state.running = false;
          state.interrupted = true;
          state.finished_at = new Date().toISOString();
          fs.writeFileSync(file, JSON.stringify(state, null, 2), { mode: 0o600 });
        }
      } catch {}
    }
  }

  async start({ command, cwd = os.homedir(), shell, cols = 120, rows = 30 }) {
    absolutePath(cwd, "cwd");
    const stat = await fsp.stat(cwd);
    if (!stat.isDirectory()) throw new Error("cwd is not a directory");
    const id = `term_${crypto.randomUUID().replaceAll("-", "")}`;
    const executable = shell || os.userInfo().shell || "/usr/bin/bash";
    absolutePath(executable, "shell");
    const args = command ? ["-lc", command] : ["-l"];
    const logPath = path.join(this.root, `${id}.log`);
    await fsp.writeFile(logPath, "", { mode: 0o600 });
    const state = {
      id,
      command: command || null,
      cwd,
      shell: executable,
      pid: null,
      running: true,
      exit_code: null,
      signal: null,
      created_at: new Date().toISOString(),
      finished_at: null,
      log_path: logPath
    };
    const process = pty.spawn(executable, args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env: hostEnvironment({ TERM: "xterm-256color", LOCAL_COMPUTER_MCP_TERMINAL_ID: id })
    });
    state.pid = process.pid;
    await this.persist(state);
    const session = { process, state, waiters: new Set() };
    this.sessions.set(id, session);
    process.onData((data) => {
      fs.appendFileSync(logPath, data, { mode: 0o600 });
      for (const wake of session.waiters) wake();
      session.waiters.clear();
    });
    process.onExit(({ exitCode, signal }) => {
      state.running = false;
      state.exit_code = exitCode;
      state.signal = signal || null;
      state.finished_at = new Date().toISOString();
      this.persist(state).catch(() => {});
      for (const wake of session.waiters) wake();
      session.waiters.clear();
    });
    return state;
  }

  get(id) {
    const live = this.sessions.get(id);
    if (live) return live.state;
    const file = path.join(this.root, `${id}.json`);
    try { return JSON.parse(fs.readFileSync(file, "utf8")); }
    catch { throw new Error(`unknown terminal session: ${id}`); }
  }

  async interact({ id, chars, offset, yieldTimeMs = 250, maxBytes, cols, rows, terminate = false }) {
    const session = this.sessions.get(id);
    if (!session) return { ...(this.get(id)), ...(await this.read(id, offset, maxBytes)) };
    if (cols || rows) session.process.resize(cols || 120, rows || 30);
    if (chars !== undefined) session.process.write(chars);
    if (terminate && session.state.running) session.process.kill("SIGTERM");
    const before = await this.size(id);
    if (yieldTimeMs > 0 && session.state.running) await this.waitForQuiet(session, before, yieldTimeMs);
    const start = offset ?? (chars !== undefined ? before : 0);
    return { ...session.state, ...(await this.read(id, start, maxBytes)) };
  }

  async read(id, offset = 0, maxBytes) {
    const file = path.join(this.root, `${id}.log`);
    const data = await fsp.readFile(file);
    const start = Math.max(0, Math.min(offset, data.length));
    const end = maxBytes === undefined ? data.length : Math.min(data.length, start + maxBytes);
    return { output: data.subarray(start, end).toString("utf8"), next_offset: end, truncated: end < data.length };
  }

  async size(id) {
    try { return (await fsp.stat(path.join(this.root, `${id}.log`))).size; }
    catch { return 0; }
  }

  async waitForQuiet(session, initialSize, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let priorSize = initialSize;
    let lastChange = Date.now();
    while (session.state.running && Date.now() < deadline) {
      const remaining = deadline - Date.now();
      await new Promise((resolve) => {
        const wake = () => { clearTimeout(timer); session.waiters.delete(wake); resolve(); };
        const timer = setTimeout(wake, Math.min(50, remaining));
        session.waiters.add(wake);
      });
      const currentSize = await this.size(session.state.id);
      if (currentSize !== priorSize) lastChange = Date.now();
      if (currentSize > initialSize && Date.now() - lastChange >= 250) return;
      priorSize = currentSize;
    }
  }

  async persist(state) {
    await fsp.writeFile(path.join(this.root, `${state.id}.json`), JSON.stringify(state, null, 2), { mode: 0o600 });
  }
}
