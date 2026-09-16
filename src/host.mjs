import os from "node:os";
import { spawnSync } from "node:child_process";

export function hostEnvironment(extra = {}) {
  const user = os.userInfo();
  const env = {
    ...process.env,
    HOME: user.homedir,
    USER: user.username,
    LOGNAME: user.username,
    SHELL: user.shell || "/usr/bin/bash"
  };
  const current = spawnSync("/usr/bin/systemctl", ["--user", "show-environment"], {
    encoding: "utf8",
    env
  });
  if (current.status === 0) {
    for (const line of current.stdout.split("\n")) {
      const split = line.indexOf("=");
      if (split > 0) env[line.slice(0, split)] = line.slice(split + 1);
    }
  }
  return { ...env, ...extra };
}

export function absolutePath(value, label = "path") {
  if (typeof value !== "string" || value.includes("\0") || !value.startsWith("/")) {
    throw new Error(`${label} must be an absolute path without NUL bytes`);
  }
  return value;
}
