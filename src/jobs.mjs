import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { absolutePath, hostEnvironment } from "./host.mjs";

export class Jobs {
  constructor({ runtimeRoot }) {
    this.runtimeRoot = runtimeRoot;
    this.running = new Map();
    fs.mkdirSync(path.join(runtimeRoot, "logs"), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(runtimeRoot, "jobs.sqlite"));
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, idempotency_key TEXT UNIQUE, kind TEXT NOT NULL, workspace TEXT NOT NULL DEFAULT 'host',
        scope TEXT NOT NULL DEFAULT 'host', command TEXT NOT NULL, cwd TEXT, pid INTEGER, owner_pid INTEGER, status TEXT NOT NULL,
        exit_code INTEGER, error TEXT, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
        artifacts TEXT NOT NULL DEFAULT '[]'
      );
    `);
    const columns = new Set(this.db.prepare("PRAGMA table_info(jobs)").all().map((column) => column.name));
    if (!columns.has("cwd")) this.db.exec("ALTER TABLE jobs ADD COLUMN cwd TEXT");
    if (!columns.has("pid")) this.db.exec("ALTER TABLE jobs ADD COLUMN pid INTEGER");
    if (!columns.has("owner_pid")) this.db.exec("ALTER TABLE jobs ADD COLUMN owner_pid INTEGER");
    this.cleanupInterrupted();
  }

  cleanupInterrupted() {
    for (const row of this.db.prepare("SELECT id,pid,owner_pid FROM jobs WHERE status IN ('queued','running')").all()) {
      if (row.owner_pid && this.serverAlive(row.owner_pid)) continue;
      if (row.pid && this.ownsProcess(row.pid, row.id)) {
        try { process.kill(-row.pid, "SIGKILL"); } catch {}
      }
      this.db.prepare("UPDATE jobs SET status='interrupted', error='owning server stopped while job was active', finished_at=? WHERE id=? AND status IN ('queued','running')")
        .run(new Date().toISOString(), row.id);
    }
  }

  serverAlive(pid) {
    try {
      const env = fs.readFileSync(`/proc/${pid}/environ`, "utf8");
      const command = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
      return env.split("\0").includes("LOCAL_COMPUTER_MCP_SERVER=1") && command.includes("/src/server.mjs");
    } catch { return false; }
  }

  ownsProcess(pid, id) {
    try {
      const env = fs.readFileSync(`/proc/${pid}/environ`, "utf8");
      return env.split("\0").includes(`LOCAL_COMPUTER_MCP_JOB_ID=${id}`);
    } catch { return false; }
  }

  get(id) {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id=?").get(id);
    if (!row) throw new Error(`unknown job: ${id}`);
    return { ...row, artifacts: JSON.parse(row.artifacts) };
  }

  findByIdempotency(key) {
    const row = this.db.prepare("SELECT id FROM jobs WHERE idempotency_key=?").get(key);
    return row ? this.get(row.id) : null;
  }

  list(limit) {
    const rows = limit === undefined
      ? this.db.prepare("SELECT * FROM jobs ORDER BY created_at DESC").all()
      : this.db.prepare("SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?").all(limit);
    return rows
      .map((row) => ({ ...row, artifacts: JSON.parse(row.artifacts) }));
  }

  async submit({ kind = "command", command, cwd, timeoutSeconds, idempotencyKey, artifacts = [] }) {
    absolutePath(cwd, "cwd");
    const stat = await fsp.stat(cwd);
    if (!stat.isDirectory()) throw new Error("cwd is not a directory");
    if (idempotencyKey) {
      const prior = this.findByIdempotency(idempotencyKey);
      if (prior) return prior;
    }
    const id = `job_${crypto.randomUUID().replaceAll("-", "")}`;
    try {
      this.db.prepare("INSERT INTO jobs (id,idempotency_key,kind,workspace,scope,command,cwd,owner_pid,status,created_at,artifacts) VALUES (?,?,?,'host','host',?,?,?,'queued',?,?)")
        .run(id, idempotencyKey || null, kind, command, cwd, process.pid, new Date().toISOString(), JSON.stringify(artifacts));
    } catch (error) {
      const prior = idempotencyKey && this.findByIdempotency(idempotencyKey);
      if (prior) return prior;
      throw error;
    }
    setImmediate(() => this.run(id, timeoutSeconds));
    return this.get(id);
  }

  run(id, timeoutSeconds) {
    const row = this.get(id);
    if (row.status !== "queued") return;
    const logPath = path.join(this.runtimeRoot, "logs", `${id}.log`);
    const log = fs.createWriteStream(logPath, { flags: "a", mode: 0o600 });
    const child = spawn("/usr/bin/bash", ["-lc", row.command], {
      cwd: row.cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: hostEnvironment({ LOCAL_COMPUTER_MCP_JOB_ID: id })
    });
    this.running.set(id, child);
    this.db.prepare("UPDATE jobs SET status='running',started_at=?,pid=? WHERE id=?")
      .run(new Date().toISOString(), child.pid ?? null, id);
    child.stdout.on("data", (chunk) => log.write(chunk));
    child.stderr.on("data", (chunk) => log.write(chunk));
    const timer = timeoutSeconds ? setTimeout(() => {
      this.db.prepare("UPDATE jobs SET error=? WHERE id=?").run(`timeout after ${timeoutSeconds}s`, id);
      if (child.pid) this.killGroup(child.pid, "SIGKILL");
    }, timeoutSeconds * 1000) : null;
    let finished = false;
    const finish = (...args) => {
      if (finished) return;
      finished = true;
      this.finish(...args);
    };
    child.on("error", (error) => finish(id, null, error.message, log, timer));
    child.on("close", (code, signal) => {
      const latest = this.get(id);
      const status = latest.status === "cancelled" ? "cancelled" : latest.error ? "failed" : code === 0 ? "succeeded" : "failed";
      finish(id, code, latest.error || (signal ? `terminated by ${signal}` : code === 0 ? null : `exit code ${code}`), log, timer, status);
    });
  }

  finish(id, code, error, log, timer, status = "failed") {
    if (timer) clearTimeout(timer);
    log.end();
    this.running.delete(id);
    this.db.prepare("UPDATE jobs SET status=?,exit_code=?,error=?,finished_at=? WHERE id=?")
      .run(status, code, error, new Date().toISOString(), id);
  }

  killGroup(pid, signal) {
    try { process.kill(-pid, signal); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
  }

  async cancel(id) {
    const row = this.get(id);
    if (!["queued", "running"].includes(row.status)) return row;
    this.db.prepare("UPDATE jobs SET status='cancelled',error='cancelled by request',finished_at=? WHERE id=?")
      .run(new Date().toISOString(), id);
    const pid = this.running.get(id)?.pid || row.pid;
    if (pid && this.ownsProcess(pid, id)) {
      this.killGroup(pid, "SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (this.ownsProcess(pid, id)) this.killGroup(pid, "SIGKILL");
    }
    return this.get(id);
  }

  async logs(id, offset = 0, limit) {
    this.get(id);
    const logPath = path.join(this.runtimeRoot, "logs", `${id}.log`);
    try {
      const handle = await fsp.open(logPath, "r");
      const size = (await handle.stat()).size;
      const start = Math.max(0, Math.min(offset, size));
      const remaining = Math.max(0, size - start);
      const length = limit === undefined ? remaining : Math.min(limit, remaining);
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, start);
      await handle.close();
      return { output: buffer.subarray(0, bytesRead).toString("utf8"), next_offset: start + bytesRead, truncated: start + bytesRead < size };
    } catch (error) {
      if (error.code === "ENOENT") return { output: "", next_offset: 0, truncated: false };
      throw error;
    }
  }
}
