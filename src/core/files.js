import fs from "node:fs/promises";
import path from "node:path";

const SENSITIVE_BASENAMES = new Set([
  ".env",
  ".npmrc",
  ".pypirc",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "credentials",
  "credentials.json",
  "secrets.json"
]);

const SENSITIVE_EXTENSIONS = new Set([".pem", ".key", ".p12", ".pfx", ".keystore", ".jks"]);

export function isSensitivePath(filePath) {
  const basename = path.basename(filePath).toLowerCase();
  const extension = path.extname(basename);
  if (SENSITIVE_BASENAMES.has(basename) || SENSITIVE_EXTENSIONS.has(extension)) return true;
  return /(^|[._-])(secret|token|credential|private[_-]?key)([._-]|$)/i.test(basename);
}

export function countLines(buffer) {
  if (buffer.length === 0) return 0;
  let lines = 0;
  for (const byte of buffer) {
    if (byte === 10) lines += 1;
  }
  return buffer[buffer.length - 1] === 10 ? lines : lines + 1;
}

export function looksBinary(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8_192));
  if (sample.includes(0)) return true;
  let suspicious = 0;
  for (const byte of sample) {
    if (byte < 7 || (byte > 13 && byte < 32)) suspicious += 1;
  }
  return sample.length > 0 && suspicious / sample.length > 0.1;
}

export async function inspectFile(filePath, config) {
  const resolved = path.resolve(filePath);
  try {
    const stat = await fs.stat(resolved);
    if (!stat.isFile()) {
      return { path: resolved, readable: false, reason: "not-a-file" };
    }

    const contents = await fs.readFile(resolved);
    const lines = countLines(contents);
    return {
      path: resolved,
      readable: true,
      sensitive: isSensitivePath(resolved),
      binary: looksBinary(contents),
      bytes: contents.length,
      lines,
      large: contents.length > config.maxBytes || lines > config.minLines,
      contents
    };
  } catch (error) {
    return {
      path: resolved,
      readable: false,
      reason: error?.code ?? "read-error"
    };
  }
}

export async function inspectFiles(paths, config) {
  return Promise.all(paths.map((filePath) => inspectFile(filePath, config)));
}

export async function loadTextFiles(paths, config, { allowSensitive = false } = {}) {
  if (!paths.length) throw new Error("At least one --path is required");

  const inspected = await inspectFiles(paths, config);
  const unreadable = inspected.filter((file) => !file.readable);
  if (unreadable.length) {
    throw new Error(`Cannot read: ${unreadable.map((file) => file.path).join(", ")}`);
  }

  const binary = inspected.filter((file) => file.binary);
  if (binary.length) {
    throw new Error(`Binary files are not supported: ${binary.map((file) => file.path).join(", ")}`);
  }

  const sensitive = inspected.filter((file) => file.sensitive);
  if (sensitive.length && !allowSensitive) {
    throw new Error(
      `Refusing sensitive-looking files: ${sensitive.map((file) => file.path).join(", ")}. ` +
      "Pass --allow-sensitive only after reviewing what will leave your machine."
    );
  }

  const payloadBytes = inspected.reduce((sum, file) => sum + file.bytes, 0);
  if (payloadBytes > config.maxPayloadBytes) {
    throw new Error(
      `Payload is ${payloadBytes} bytes; the configured maximum is ${config.maxPayloadBytes}. Split the request.`
    );
  }

  return inspected.map((file) => ({
    path: file.path,
    bytes: file.bytes,
    lines: file.lines,
    text: file.contents.toString("utf8")
  }));
}
