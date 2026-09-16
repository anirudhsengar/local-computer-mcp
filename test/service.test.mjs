import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { renderService } from "../scripts/render-service.mjs";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const template = await fs.readFile(path.join(project, "config/local-computer-mcp.service.example"), "utf8");
const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

async function fixture(t, suffix = "install with spaces %n") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "local-computer-service-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, suffix);
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  for (const subdir of ["scripts", "config", "runtime", "tools/tunnel", "src"]) {
    await fs.mkdir(path.join(directory, subdir), { recursive: true });
  }
  await fs.mkdir(home);
  await fs.mkdir(bin);
  for (const file of ["scripts/ops.sh", "scripts/run-server.sh", "scripts/render-service.mjs", "config/local-computer-mcp.service.example"]) {
    await fs.copyFile(path.join(project, file), path.join(directory, file));
  }
  const log = path.join(root, "systemctl.log");
  await fs.writeFile(path.join(bin, "systemctl"), '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$SERVICE_TEST_LOG"\n', { mode: 0o755 });
  await fs.writeFile(path.join(bin, "pgrep"), "#!/usr/bin/env bash\nexit 1\n", { mode: 0o755 });
  const env = { ...process.env, HOME: home, PATH: `${bin}:${path.dirname(process.execPath)}:${process.env.PATH}`, SERVICE_TEST_LOG: log };
  return { root, directory, home, bin, log, env };
}

function run(f, action) {
  return spawnSync("/usr/bin/bash", [path.join(f.directory, "scripts/ops.sh"), action], {
    cwd: f.root, env: f.env, encoding: "utf8", timeout: 10000,
  });
}

test("service rendering uses the installation directory and Node executable", () => {
  const unit = renderService(template, "/opt/local computer", "/opt/node/bin/node");
  assert.ok(unit.includes('WorkingDirectory=/opt/local computer/.'));
  assert.ok(unit.includes('Environment="LOCAL_COMPUTER_MCP_NODE=/opt/node/bin/node"'));
  assert.ok(unit.includes("KillMode=control-group\nUMask=0077"));
  assert.ok(!unit.includes("@PROJECT_DIRECTORY@"));
});

test("systemd specifiers, quotes, and backslashes stay literal", () => {
  const unit = renderService(template, '/opt/a %n "quote" \\ path', "/opt/node %h/bin/node");
  assert.ok(unit.includes('WorkingDirectory=/opt/a %%n "quote" \\ path/.'));
  assert.ok(unit.includes('Environment="LOCAL_COMPUTER_MCP_NODE=/opt/node %%h/bin/node"'));
});

test("token-like path components are not substituted twice", () => {
  const unit = renderService(template, "/opt/@NODE_EXECUTABLE@", "/usr/bin/node");
  assert.ok(unit.includes('WorkingDirectory=/opt/@NODE_EXECUTABLE@/.'));
});

test("invalid paths and malformed service templates fail closed", () => {
  for (const value of ["relative", "", "/opt/a\nExecStart=/bin/false", "/opt/a\r", "/opt/a\0", "/opt/a\t"]) {
    assert.throws(() => renderService(template, value, "/usr/bin/node"), /absolute path/);
    assert.throws(() => renderService(template, "/opt/project", value), /absolute path/);
  }
  assert.throws(() => renderService(template.replace("@NODE_EXECUTABLE@", ""), "/opt/project", "/usr/bin/node"), /exactly one/);
  assert.throws(() => renderService(`${template}\n@PROJECT_DIRECTORY@`, "/opt/project", "/usr/bin/node"), /exactly one/);
});

test("install-service renders a private unit without enabling root", async (t) => {
  const f = await fixture(t);
  const result = run(f, "install-service");
  assert.equal(result.status, 0, result.stderr);
  const unitDirectory = path.join(f.home, ".config/systemd/user");
  const unitPath = path.join(unitDirectory, "local-computer-mcp.service");
  assert.equal(await fs.readFile(unitPath, "utf8"), renderService(template, f.directory, process.execPath));
  assert.equal((await fs.stat(unitPath)).mode & 0o777, 0o600);
  assert.deepEqual(await fs.readdir(unitDirectory), ["local-computer-mcp.service"]);
  const calls = await fs.readFile(f.log, "utf8");
  assert.match(calls, /--user daemon-reload/);
  assert.match(calls, /--user enable --now local-computer-mcp\.service/);
  assert.doesNotMatch(calls, /sudo|root/);
});

test("failed rendering leaves the existing service untouched", async (t) => {
  const f = await fixture(t);
  const unitDirectory = path.join(f.home, ".config/systemd/user");
  await fs.mkdir(unitDirectory, { recursive: true });
  const unitPath = path.join(unitDirectory, "local-computer-mcp.service");
  await fs.writeFile(unitPath, "existing-unit\n");
  await fs.writeFile(path.join(f.directory, "config/local-computer-mcp.service.example"), "invalid template\n");
  const result = run(f, "install-service");
  assert.notEqual(result.status, 0);
  assert.equal(await fs.readFile(unitPath, "utf8"), "existing-unit\n");
  await assert.rejects(fs.access(f.log), { code: "ENOENT" });
  assert.deepEqual(await fs.readdir(unitDirectory), ["local-computer-mcp.service"]);
});

for (const action of ["tunnel-doctor", "tunnel-run"]) {
  test(`${action} uses the project cwd and a path-safe MCP command`, async (t) => {
    const f = await fixture(t);
    const key = path.join(f.directory, "runtime/test-key");
    await fs.writeFile(key, "non-secret-test-fixture", { mode: 0o600 });
    await fs.writeFile(path.join(f.directory, "runtime/tunnel.env"), `CONTROL_PLANE_TUNNEL_ID=tunnel_0123456789abcdef0123456789abcdef\nCONTROL_PLANE_API_KEY_FILE=${shellQuote(key)}\n`, { mode: 0o600 });
    await fs.writeFile(path.join(f.directory, "tools/tunnel/tunnel-client"), '#!/usr/bin/env bash\nprintf "%s\\n" "$PWD" "$@"\n', { mode: 0o755 });
    const result = run(f, action);
    assert.equal(result.status, 0, result.stderr);
    const lines = result.stdout.trimEnd().split("\n");
    assert.equal(lines[0], f.directory);
    assert.equal(lines[lines.indexOf("--mcp.command") + 1], "channel=main,command=/usr/bin/bash scripts/run-server.sh");
    assert.equal(lines[lines.indexOf("--control-plane.api-key") + 1], `file:${key}`);
  });
}

test("run-server uses the service-selected Node executable", async (t) => {
  const f = await fixture(t);
  const node = path.join(f.root, "selected node");
  await fs.writeFile(node, '#!/usr/bin/env bash\nprintf "%s\\n" "$1" "$LOCAL_COMPUTER_MCP_SERVER" "$PATH"\n', { mode: 0o755 });
  const result = spawnSync("/usr/bin/bash", [path.join(f.directory, "scripts/run-server.sh")], {
    env: { ...f.env, LOCAL_COMPUTER_MCP_NODE: node }, encoding: "utf8", timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trimEnd().split("\n");
  assert.equal(lines[0], path.join(f.directory, "src/server.mjs"));
  assert.equal(lines[1], "1");
  assert.ok(lines[2].startsWith(`${path.dirname(node)}:`));
});

test("run-server fails clearly when the pinned Node executable is gone", async (t) => {
  const f = await fixture(t);
  const result = spawnSync("/usr/bin/bash", [path.join(f.directory, "scripts/run-server.sh")], {
    env: { ...f.env, LOCAL_COMPUTER_MCP_NODE: path.join(f.root, "missing-node") }, encoding: "utf8", timeout: 10000,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /reinstall the service/);
});

test("systemd accepts generated units with literal special-character paths", async (t) => {
  const available = spawnSync("systemd-analyze", ["--version"], { encoding: "utf8" });
  if (available.error?.code === "ENOENT") return t.skip("systemd-analyze is not installed");
  assert.equal(available.status, 0, available.stderr);
  const f = await fixture(t);
  const runtime = path.join(f.root, "systemd-runtime");
  await fs.mkdir(runtime, { mode: 0o700 });
  const unitPath = path.join(f.root, "local-computer-mcp.service");
  for (const directory of [f.directory, '/opt/a %n "quote" \\ trailing ']) {
    await fs.writeFile(unitPath, renderService(template, directory, process.execPath));
    const result = spawnSync("systemd-analyze", ["--user", "verify", unitPath], {
      env: { ...f.env, XDG_RUNTIME_DIR: runtime }, encoding: "utf8", timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
  }
});

test("the service generator also runs through a symlinked checkout", async (t) => {
  const f = await fixture(t);
  const alias = path.join(f.root, "checkout-link");
  await fs.symlink(f.directory, alias, "dir");
  const result = spawnSync(process.execPath, [path.join(alias, "scripts/render-service.mjs")], {
    cwd: f.root, encoding: "utf8", timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, renderService(template, f.directory, process.execPath));
});
