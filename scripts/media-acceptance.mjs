import fs from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const project = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const workspace = "media-acceptance";
const transport = new StdioClientTransport({ command: "/usr/bin/bash", args: [path.join(project, "scripts/run-server.sh")], cwd: project, stderr: "inherit" });
const client = new Client({ name: "media-acceptance", version: "2.0.1" }, { capabilities: {} });
await client.connect(transport);

const call = async (name, args) => {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(`${name}: ${result.content?.[0]?.text}`);
  return result;
};
const wait = async (id, timeout = 300000) => {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const row = (await call("process", { action: "status", job_id: id })).structuredContent;
    if (["succeeded", "failed", "cancelled", "interrupted"].includes(row.status)) {
      const logs = (await call("process", { action: "logs", job_id: id, max_bytes: 262144 })).structuredContent.output;
      if (row.status !== "succeeded") throw new Error(`${row.kind} ${row.status}: ${row.error}\n${logs}`);
      return { row, logs };
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`job timed out: ${id}`);
};
const submitMedia = async (args, timeout) => wait((await call("media", { cwd: path.join(project, "workspaces", workspace), ...args })).structuredContent.id, timeout);

const design = `# Local Computer sample identity

## Style Prompt
A warm editorial systems card: tactile paper-colored canvas, ink typography, vermilion signal, restrained technical detail, and confident but calm motion.

## Colors
- Canvas: #F3E9D2
- Ink: #1F2A2A
- Muted ink: #58645E
- Signal: #D95735
- Paper highlight: #FFF8E8

## Typography
- Headlines: DejaVu Serif, bold
- Supporting copy: Liberation Sans, regular and bold

## Motion
Short offset entrances with distinct directions and eases; slow ambient drift in background geometry; clean final fade.

## What NOT to Do
- No gradients or neon.
- No generic card grid.
- No pure black or white.
- No unrelated decorative icons.
`;

const html = (revision = false) => `<!doctype html>
<html lang="en" data-resolution="portrait">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=1080, height=1920">
  <script src="assets/gsap.min.js"></script>
  <style>
    * { box-sizing: border-box; }
    html, body { margin: 0; width: 1080px; height: 1920px; overflow: hidden; background: #F3E9D2; }
    body { font-family: "Liberation Sans", sans-serif; color: #1F2A2A; }
    #root { position: relative; width: 100%; height: 100%; overflow: hidden; background: #F3E9D2; }
    .scene { width: 100%; height: 100%; padding: 136px 94px 120px; display: flex; flex-direction: column; justify-content: space-between; gap: 42px; position: relative; overflow: hidden; }
    .orb { position: absolute; width: 620px; height: 620px; border: 2px solid #D95735; border-radius: 50%; right: -250px; top: 180px; opacity: .22; }
    .rule { position: absolute; width: 2px; height: 760px; background: #D95735; left: 68px; top: 580px; opacity: .48; }
    .ghost { position: absolute; left: 72px; bottom: 280px; font: 700 220px/1 "DejaVu Serif", serif; color: #1F2A2A; opacity: .045; letter-spacing: -12px; }
    .top { display: flex; justify-content: space-between; align-items: center; z-index: 2; }
    .kicker { font: 700 25px/1 "Liberation Sans", sans-serif; letter-spacing: 5px; text-transform: uppercase; color: #58645E; }
    .badge { border: 2px solid #D95735; color: #1F2A2A; background: #FFF8E8; border-radius: 999px; padding: 18px 28px; font-size: 24px; font-weight: 700; letter-spacing: 2px; }
    .hero { z-index: 2; display: flex; flex-direction: column; gap: 36px; max-width: 860px; }
    h1 { margin: 0; font: 700 138px/.91 "DejaVu Serif", serif; letter-spacing: -7px; }
    .signal { color: #D95735; }
    .dek { margin: 0; max-width: 770px; font-size: 42px; line-height: 1.28; color: #58645E; }
    .bottom { z-index: 2; display: flex; justify-content: space-between; align-items: end; border-top: 2px solid #1F2A2A; padding-top: 28px; }
    .capabilities { font-size: 24px; line-height: 1.5; letter-spacing: 1px; text-transform: uppercase; }
    .mark { font: 700 52px/1 "DejaVu Serif", serif; color: #D95735; }
  </style>
</head>
<body>
  <div id="root" data-composition-id="main" data-start="0" data-duration="5" data-width="1080" data-height="1920" data-fps="30">
    <div id="scene" class="scene clip" data-start="0" data-duration="5" data-track-index="0">
      <div class="orb" data-layout-ignore></div><div class="rule" data-layout-ignore></div><div class="ghost" data-layout-ignore>LOCAL</div>
      <div class="top"><div class="kicker">Local Computer</div><div class="badge">${revision ? "REVISED" : "READY"}</div></div>
      <div class="hero"><h1>Build.<br>Browse.<br><span class="signal">Render.</span></h1><p class="dek">Direct host tools for coding, terminals, browsers, and local media.</p></div>
      <div class="bottom"><div class="capabilities">FILES · CODE · WEB<br>BROWSER · MEDIA</div><div class="mark">05s</div></div>
    </div>
    <audio id="narration" data-start="0.35" data-track-index="1" src="narration.wav" data-volume="1"></audio>
  </div>
  <script>
    window.__timelines = window.__timelines || {};
    const tl = gsap.timeline({ paused: true });
    tl.from(".orb", { scale: .72, opacity: 0, duration: .55, ease: "back.out(1.3)" }, .15)
      .from(".rule", { scaleY: 0, transformOrigin: "top", duration: .48, ease: "power2.out" }, .24)
      .from(".ghost", { x: -90, opacity: 0, duration: .62, ease: "expo.out" }, .18)
      .from(".kicker", { y: -32, opacity: 0, duration: .42, ease: "power3.out" }, .25)
      .from(".badge", { x: 52, opacity: 0, duration: .46, ease: "back.out(1.5)" }, .34)
      .from("h1", { y: 76, opacity: 0, duration: .58, ease: "expo.out" }, .48)
      .from(".dek", { x: -44, opacity: 0, duration: .5, ease: "power2.out" }, .72)
      .from(".bottom", { y: 46, opacity: 0, duration: .46, ease: "circ.out" }, .92)
      .to(".orb", { rotation: 14, scale: 1.035, duration: 3.7, ease: "sine.inOut" }, .75)
      .to(".ghost", { x: 24, duration: 3.6, ease: "sine.inOut" }, .82)
      .to(".scene", { opacity: 0, duration: .34, ease: "power2.in" }, 4.62);
    window.__timelines.main = tl;
  </script>
</body>
</html>`;

try {
  await call("workspace", { action: "create", name: workspace });
  const workspacePath = path.join(project, "workspaces", workspace);
  await call("write_file", { action: "write", path: path.join(workspacePath, "composition/DESIGN.md"), content: design, overwrite: true });
  await call("fetch_url", { url: "https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js", destination: path.join(workspacePath, "composition/assets/gsap.min.js"), overwrite: true });
  await submitMedia({ action: "narrate", text: "Build, browse, and render. Your local computer is ready for real work.", output: "composition/narration.wav", voice: "af_nova", idempotency_key: "v2-acceptance-narration-2" });
  await call("write_file", { action: "write", path: path.join(workspacePath, "composition/index.html"), content: html(false), overwrite: true });
  const check1 = await submitMedia({ action: "hyperframes_check", input: "composition", idempotency_key: "v2-acceptance-check-1b" });
  const render1 = await submitMedia({ action: "render", input: "composition", output: "composition/renders/local-computer-v1.mp4", idempotency_key: "v2-acceptance-render-1" }, 600000);
  const probe1 = await submitMedia({ action: "probe", input: "composition/renders/local-computer-v1.mp4" });
  await submitMedia({ action: "decode_check", input: "composition/renders/local-computer-v1.mp4" }, 180000);
  await submitMedia({ action: "frame", input: "composition/renders/local-computer-v1.mp4", output: "composition/renders/review-v1.png", at: 2.4 });
  await submitMedia({ action: "clip", input: "composition/renders/local-computer-v1.mp4", output: "composition/renders/clip-v1.mp4", at: 1.2, duration: 1.5 });
  await submitMedia({ action: "contact_sheet", input: "composition/renders/local-computer-v1.mp4", output: "composition/renders/contact-v1.png" });

  await call("write_file", { action: "patch", path: path.join(workspacePath, "composition/index.html"), old_text: '<div class="badge">READY</div>', new_text: '<div class="badge">REVISED</div>' });
  const check2 = await submitMedia({ action: "hyperframes_check", input: "composition", idempotency_key: "v2-acceptance-check-2" });
  const render2 = await submitMedia({ action: "render", input: "composition", output: "composition/renders/local-computer-v2.mp4", idempotency_key: "v2-acceptance-render-2" }, 600000);
  const probe2 = await submitMedia({ action: "probe", input: "composition/renders/local-computer-v2.mp4" });
  await submitMedia({ action: "decode_check", input: "composition/renders/local-computer-v2.mp4" }, 180000);
  await submitMedia({ action: "frame", input: "composition/renders/local-computer-v2.mp4", output: "composition/renders/review-v2.png", at: 2.4 });
  const image = await call("artifact", { path: path.join(workspacePath, "composition/renders/review-v2.png") });
  if (!image.content.some((item) => item.type === "image" && item.mimeType === "image/png")) throw new Error("review frame was not returned as MCP ImageContent");

  const outputs = path.resolve(project, "..", "outputs");
  await fs.mkdir(outputs, { recursive: true });
  const source = path.join(project, "workspaces", workspace, "composition", "renders");
  for (const name of ["local-computer-v1.mp4", "local-computer-v2.mp4", "review-v1.png", "review-v2.png", "contact-v1.png", "clip-v1.mp4"]) {
    await fs.copyFile(path.join(source, name), path.join(outputs, name));
  }
  console.log(JSON.stringify({ check1: check1.row, render1: render1.row, probe1: probe1.logs, check2: check2.row, render2: render2.row, probe2: probe2.logs, imageContent: true }, null, 2));
} finally {
  await transport.close();
}
