import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function absolutePath(value, label) {
  if (typeof value !== "string" || !path.posix.isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`${label} must be an absolute path without control characters`);
  }
  return value;
}

export function renderService(template, projectDirectory, nodeExecutable) {
  const values = {
    // WorkingDirectory takes a literal path, not a shell-quoted string.
    "@PROJECT_DIRECTORY@": absolutePath(projectDirectory, "Project directory").replaceAll("%", "%%"),
    "@NODE_EXECUTABLE@": absolutePath(nodeExecutable, "Node executable")
      .replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%"),
  };
  // Replace only original template tokens, never token-like text inside a path.
  for (const token of Object.keys(values)) {
    if (template.split(token).length !== 2) throw new Error(`Expected exactly one ${token} in the service template`);
  }
  return template.replace(/@PROJECT_DIRECTORY@|@NODE_EXECUTABLE@/g, (token) => values[token]);
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && fs.existsSync(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(scriptPath)) {
  try {
    const projectDirectory = path.resolve(path.dirname(scriptPath), "..");
    const template = fs.readFileSync(path.join(projectDirectory, "config/local-computer-mcp.service.example"), "utf8");
    process.stdout.write(renderService(template, projectDirectory, process.execPath));
  } catch (error) {
    console.error(`Cannot generate user service: ${error.message}`);
    process.exitCode = 1;
  }
}
