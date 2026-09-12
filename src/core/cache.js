import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function cacheKey(namespace, value) {
  return `${namespace}-${hash(JSON.stringify(value))}`;
}

export async function getCached(config, key) {
  if (!config.cache) return null;
  try {
    const raw = await fs.readFile(path.join(config.cacheDir, `${key}.json`), "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    return null;
  }
}

export async function setCached(config, key, value) {
  if (!config.cache) return;
  await fs.mkdir(config.cacheDir, { recursive: true, mode: 0o700 });
  const target = path.join(config.cacheDir, `${key}.json`);
  const temporary = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporary, target);
}
