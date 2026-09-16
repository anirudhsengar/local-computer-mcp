import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const project = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const fixture = path.resolve(project, "..", "work", "local-computer-v2-test");
const stateRoot = path.join(fixture, "state");
const workspace = "v2-integration";
const workspacePath = path.join(project, "workspaces", workspace);

async function connect() {
  const transport = new StdioClientTransport({ command: "/usr/bin/bash", args: [path.join(project, "scripts/run-server.sh")], cwd: project, env: { LOCAL_COMPUTER_MCP_STATE_ROOT: stateRoot }, stderr: "pipe", maxBufferSize: Infinity });
  transport.stderr?.pipe(process.stderr);
  const client = new Client({ name: "integration-test", version: "2.2.0" }, { capabilities: {} });
  await client.connect(transport);
  return { client, transport };
}

const call = (client, name, args = {}) => client.callTool({ name, arguments: args });

async function waitJob(client, id, wanted = ["succeeded", "failed", "cancelled", "interrupted"], timeout = 30000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const result = await call(client, "process", { action: "status", job_id: id });
    if (wanted.includes(result.structuredContent.status)) return result.structuredContent;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${id}`);
}

test("unrestricted Local Computer MCP end to end", { timeout: 180000 }, async () => {
  await fs.rm(fixture, { recursive: true, force: true });
  await fs.rm(workspacePath, { recursive: true, force: true });
  await fs.mkdir(fixture, { recursive: true });
  const localServer = http.createServer((request, response) => {
    response.setHeader("content-type", "text/plain");
    response.end(request.url === "/attachment" ? "attachment fixture" : "private-network-ok");
  });
  await new Promise((resolve) => localServer.listen(0, "127.0.0.1", resolve));
  const localUrl = `http://127.0.0.1:${localServer.address().port}`;
  let { client, transport } = await connect();
  try {
    const discovered = await client.listTools();
    assert.deepEqual(discovered.tools.map((item) => item.name), [
      "computer_status", "workspace", "read_file", "write_file", "import_file", "fetch_url", "exec_command",
      "write_stdin", "process", "repository", "apply_patch", "media", "browser", "artifact"
    ]);
    const importTool = discovered.tools.find((item) => item.name === "import_file");
    assert.deepEqual(importTool._meta["openai/fileParams"], ["file"]);
    assert.deepEqual(importTool.inputSchema.properties.file.required, ["download_url", "file_id"]);
    assert.equal(importTool.inputSchema.properties.file.additionalProperties, false);
    const serverCeilings = [];
    const findMaximums = (value, location = "") => {
      if (!value || typeof value !== "object") return;
      if (Object.hasOwn(value, "maximum") && value.maximum < Number.MAX_SAFE_INTEGER) serverCeilings.push(location);
      for (const [key, child] of Object.entries(value)) findMaximums(child, `${location}/${key}`);
    };
    for (const item of discovered.tools) findMaximums(item.inputSchema, item.name);
    assert.deepEqual(serverCeilings, []);

    const status = await call(client, "computer_status");
    assert.equal(status.structuredContent.ok, true);
    assert.equal(status.structuredContent.version, "2.2.0");
    assert.equal(status.structuredContent.access, "unrestricted-host-user");
    assert.equal(status.structuredContent.restrictions.filesystem, false);
    assert.equal(status.structuredContent.restrictions.request_size, false);
    assert.equal(status.structuredContent.restrictions.response_size, false);
    assert.equal(status.structuredContent.restrictions.file_size, false);
    assert.equal(status.structuredContent.restrictions.archive_size, false);
    assert.equal(typeof status.structuredContent.unattended_root, "boolean");

    await call(client, "workspace", { action: "create", name: workspace });
    const workspaceResult = await call(client, "workspace", { action: "path", name: workspace });
    assert.equal(workspaceResult.structuredContent.path, workspacePath);

    const source = path.join(fixture, "source.txt");
    const moved = path.join(fixture, "moved.txt");
    const copied = path.join(fixture, "copied.txt");
    await call(client, "write_file", { action: "write", path: source, content: "alpha beta" });
    await call(client, "write_file", { action: "patch", path: source, old_text: "beta", new_text: "gamma" });
    await call(client, "write_file", { action: "move", path: source, destination: moved });
    await call(client, "write_file", { action: "copy", path: moved, destination: copied });
    const read = await call(client, "read_file", { action: "read", path: copied, hash: true });
    assert.equal(read.structuredContent.content, "alpha gamma");
    assert.match(read.structuredContent.sha256, /^[0-9a-f]{64}$/);
    const formerlyOversizedImage = path.join(fixture, "over-eight-mib.png");
    await fs.writeFile(formerlyOversizedImage, Buffer.alloc(8 * 1024 * 1024 + 1));
    const unlimitedArtifact = await call(client, "artifact", { path: formerlyOversizedImage });
    assert.equal(unlimitedArtifact.content.some((item) => item.type === "image" && item.data.length > 8 * 1024 * 1024), true);
    assert.equal(unlimitedArtifact.content.some((item) => item.type === "resource_link"), true);
    const transferPath = path.join(fixture, "transfer sample.mp4");
    const transferBytes = Buffer.from(Array.from({ length: 256 }, (_, index) => index));
    await fs.writeFile(transferPath, transferBytes);
    const transfer = await call(client, "artifact", { path: transferPath });
    const transferLink = transfer.content.find((item) => item.type === "resource_link");
    assert.equal(transferLink.name, "transfer sample.mp4");
    assert.equal(transferLink.mimeType, "video/mp4");
    assert.equal(transferLink.size, transferBytes.length);
    assert.equal(transfer.structuredContent.delivery, "mcp-resource-link");
    assert.equal(transfer.structuredContent.resource_uri, transferLink.uri);
    const resource = await client.readResource({ uri: transferLink.uri });
    assert.equal(resource.contents[0].mimeType, "video/mp4");
    assert.deepEqual(Buffer.from(resource.contents[0].blob, "base64"), transferBytes);
    assert.equal((await client.listResourceTemplates()).resourceTemplates.some((item) => item.uriTemplate === "local-computer://file/{sha256}/{encodedPath}"), true);
    const stalePath = path.join(fixture, "stale.txt");
    await fs.writeFile(stalePath, "before");
    const staleLink = (await call(client, "artifact", { path: stalePath })).content.find((item) => item.type === "resource_link");
    await fs.writeFile(stalePath, "after");
    await assert.rejects(client.readResource({ uri: staleLink.uri }), /file changed/);
    const crossDevice = `/dev/shm/local-computer-mcp-${process.pid}.txt`;
    await call(client, "write_file", { action: "move", path: copied, destination: crossDevice });
    assert.equal((await call(client, "read_file", { action: "read", path: crossDevice })).structuredContent.content, "alpha gamma");
    await call(client, "write_file", { action: "move", path: crossDevice, destination: copied });
    const osRelease = await call(client, "read_file", { action: "read", path: "/etc/os-release" });
    assert.match(osRelease.structuredContent.content, /Omarchy|Arch Linux/);

    const outside = path.join(fixture, "outside-secret-fixture.txt");
    const link = path.join(workspacePath, "unrestricted-link");
    await fs.writeFile(outside, "fixture-readable");
    await fs.symlink(outside, link);
    const linked = await call(client, "read_file", { action: "read", path: link });
    assert.equal(linked.structuredContent.content, "fixture-readable");

    const fetched = await call(client, "fetch_url", { url: localUrl });
    assert.equal(fetched.structuredContent.content, "private-network-ok");
    const imported = await call(client, "import_file", { workspace, file: { download_url: `${localUrl}/attachment`, file_id: "fixture_file", file_name: "../../unsafe name.txt", mime_type: "text/plain" } });
    assert.equal(imported.structuredContent.path, path.join(workspacePath, "imports", "unsafe_name.txt"));
    assert.equal(await fs.readFile(imported.structuredContent.path, "utf8"), "attachment fixture");

    const command = await call(client, "exec_command", { command: "printf 'host-command:%s' \"$(id -u)\"", cwd: fixture, wait_ms: 5000, idempotency_key: "host-command" });
    assert.equal(command.structuredContent.status, "succeeded");
    assert.match(command.structuredContent.output, /host-command:1000/);
    const duplicate = await call(client, "exec_command", { command: "echo should-not-run", cwd: fixture, wait_ms: 5000, idempotency_key: "host-command" });
    assert.equal(duplicate.structuredContent.id, command.structuredContent.id);

    const terminal = await call(client, "exec_command", { command: "read value; printf 'terminal:%s\\n' \"$value\"", cwd: fixture, tty: true, wait_ms: 100 });
    assert.equal(terminal.structuredContent.running, true);
    const terminalResult = await call(client, "write_stdin", { session_id: terminal.structuredContent.id, chars: "hello\n", offset: terminal.structuredContent.next_offset, yield_time_ms: 5000 });
    assert.match(terminalResult.structuredContent.output, /terminal:hello/);
    assert.equal(terminalResult.structuredContent.exit_code, 0);

    const repo = path.join(fixture, "repo");
    await fs.mkdir(repo);
    const init = await call(client, "exec_command", { command: "git init -q && git config user.name fixture && git config user.email fixture@example.invalid && printf 'before\\n' > code.txt && git add code.txt && git commit -qm initial", cwd: repo, wait_ms: 5000 });
    assert.equal(init.structuredContent.status, "succeeded");
    await fs.writeFile(path.join(repo, "AGENTS.md"), "fixture instructions");
    const inspection = await call(client, "repository", { action: "inspect", cwd: repo });
    assert.equal(inspection.structuredContent.exit_code, 0);
    assert.match(inspection.structuredContent.stdout, /AGENTS\.md/);
    const patched = await call(client, "apply_patch", { cwd: repo, patch: "*** Begin Patch\n*** Update File: code.txt\n@@\n-before\n+after\n*** End Patch" });
    assert.equal(patched.structuredContent.exit_code, 0);
    const search = await call(client, "repository", { action: "search", cwd: repo, query: "after" });
    assert.match(search.structuredContent.stdout, /code\.txt:1:after/);
    const diff = await call(client, "repository", { action: "diff", cwd: repo });
    assert.match(diff.structuredContent.stdout, /\+after/);

    const failed = await call(client, "exec_command", { command: "exit 17", cwd: fixture, wait_ms: 5000 });
    assert.equal(failed.structuredContent.exit_code, 17);
    if (status.structuredContent.unattended_root) {
      const root = await call(client, "exec_command", { command: "id -u", cwd: "/root", root: true, wait_ms: 5000 });
      assert.equal(root.structuredContent.status, "succeeded");
      assert.equal(root.structuredContent.output.trim(), "0");
      const cachedSchemaRoot = await call(client, "exec_command", { command: "sudo -n id -u", cwd: fixture, wait_ms: 5000 });
      assert.equal(cachedSchemaRoot.structuredContent.status, "succeeded");
      assert.equal(cachedSchemaRoot.structuredContent.output.trim(), "0");
    } else {
      assert.match((await call(client, "exec_command", { command: "id -u", cwd: "/root", root: true })).content[0].text, /unattended root is not enabled/);
    }
    const timed = await call(client, "exec_command", { command: "sleep 10", cwd: fixture, timeout_seconds: 0.2, wait_ms: 5000 });
    assert.match(timed.structuredContent.error, /timeout/);
    const cancellable = await call(client, "exec_command", { command: "sleep 30", cwd: fixture, wait_ms: 0 });
    await waitJob(client, cancellable.structuredContent.id, ["running"]);
    const cancelled = await call(client, "process", { action: "cancel", job_id: cancellable.structuredContent.id });
    assert.equal(cancelled.structuredContent.status, "cancelled");

    const parallel = await Promise.all(Array.from({ length: 6 }, (_, index) => call(client, "exec_command", { command: `sleep 2; echo ${index}`, cwd: fixture, wait_ms: 0 })));
    await new Promise((resolve) => setTimeout(resolve, 300));
    const rows = await Promise.all(parallel.map((item) => call(client, "process", { action: "status", job_id: item.structuredContent.id })));
    assert.equal(rows.filter((row) => row.structuredContent.status === "running").length, 6);
    await Promise.all(parallel.map((item) => call(client, "process", { action: "cancel", job_id: item.structuredContent.id })));

    const shared = await call(client, "exec_command", { command: "sleep 30", cwd: fixture, wait_ms: 0 });
    await waitJob(client, shared.structuredContent.id, ["running"]);
    const second = await connect();
    try {
      assert.equal((await call(second.client, "process", { action: "status", job_id: shared.structuredContent.id })).structuredContent.status, "running");
      assert.equal((await call(second.client, "process", { action: "cancel", job_id: shared.structuredContent.id })).structuredContent.status, "cancelled");
    } finally {
      await second.transport.close();
    }

    const browserTools = await call(client, "browser", { action: "list_tools", session: "integration" });
    assert.equal(browserTools.structuredContent.tools.some((item) => item.name === "browser_navigate"), true);
    const navigation = await call(client, "browser", { action: "call", session: "integration", tool: "browser_navigate", arguments: { url: localUrl } });
    assert.notEqual(navigation.isError, true);
    const screenshot = await call(client, "browser", { action: "call", session: "integration", tool: "browser_take_screenshot", arguments: { type: "png", fullPage: false } });
    assert.equal(screenshot.content.some((item) => item.type === "image" && item.mimeType === "image/png"), true);
    const relativeScreenshot = `relative-${process.pid}.png`;
    const savedScreenshot = await call(client, "browser", { action: "call", session: "integration", tool: "browser_take_screenshot", arguments: { type: "png", filename: relativeScreenshot } });
    assert.notEqual(savedScreenshot.isError, true);
    assert.equal((await fs.stat(path.join(project, "workspaces", "browser-sessions", "integration", relativeScreenshot))).isFile(), true);

    const interrupted = await call(client, "exec_command", { command: "sleep 30", cwd: fixture, wait_ms: 0 });
    await waitJob(client, interrupted.structuredContent.id, ["running"]);
    await transport.close();
    await new Promise((resolve) => setTimeout(resolve, 500));
    ({ client, transport } = await connect());
    assert.equal((await call(client, "process", { action: "status", job_id: interrupted.structuredContent.id })).structuredContent.status, "interrupted");
    const recoveredResource = await client.readResource({ uri: transferLink.uri });
    assert.deepEqual(Buffer.from(recoveredResource.contents[0].blob, "base64"), transferBytes);

    await call(client, "write_file", { action: "delete", path: copied });
    await assert.rejects(fs.stat(copied), { code: "ENOENT" });
  } finally {
    await transport.close().catch(() => {});
    await new Promise((resolve) => localServer.close(resolve));
    await fs.rm(fixture, { recursive: true, force: true });
  }
});
