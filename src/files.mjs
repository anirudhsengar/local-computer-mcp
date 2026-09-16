import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export async function atomicWrite(target, data, overwrite) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  try {
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink()) throw new Error("refusing to overwrite symlink; use exec_command if intentional");
    if (!overwrite) throw new Error("target exists; set overwrite=true");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  await fs.writeFile(temporary, data, { flag: "wx", mode: 0o600 });
  await fs.rename(temporary, target);
}

export function contentTypeExtension(contentType = "") {
  const base = contentType.split(";", 1)[0].toLowerCase();
  return ({ "image/png": ".png", "image/jpeg": ".jpg", "application/pdf": ".pdf", "video/mp4": ".mp4", "audio/wav": ".wav", "text/plain": ".txt" })[base] || "";
}
