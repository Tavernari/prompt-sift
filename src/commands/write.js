import fs from "node:fs/promises";
import path from "node:path";
import { cacheKey, getCached, hash, setCached } from "../core/cache.js";
import { isSensitivePath, loadTextFiles } from "../core/files.js";
import { estimateTokens, recordMetric } from "../core/metrics.js";
import { buildWritePrompt, PROMPT_VERSION } from "../core/prompts.js";
import { chat } from "../providers/openai-compatible.js";

export function stripWrappingFence(value) {
  const trimmed = value.trim();
  const match = trimmed.match(/^```[^\n]*\n([\s\S]*)\n```$/);
  return match ? match[1] : value;
}

async function targetExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function writeTarget(target, content, force) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  if (!force) {
    await fs.writeFile(target, content, { encoding: "utf8", flag: "wx" });
    return;
  }
  const temporary = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temporary, content, "utf8");
  await fs.rename(temporary, target);
}

export async function writeCommand(config, options) {
  if (!options.spec) throw new Error("--spec is required");
  if (!options.reference) throw new Error("--reference is required");

  const target = options.target ? path.resolve(options.target) : null;
  if (target && isSensitivePath(target) && !options.allowSensitive) {
    throw new Error("Refusing to write a sensitive-looking target without --allow-sensitive");
  }
  if (target && !options.force && await targetExists(target)) {
    throw new Error(`${target} already exists; pass --force to replace it`);
  }

  const [reference] = await loadTextFiles([options.reference], config, {
    allowSensitive: options.allowSensitive
  });
  const identity = {
    promptVersion: PROMPT_VERSION,
    model: config.provider.model,
    baseUrl: config.provider.baseUrl,
    spec: options.spec,
    reference: { path: path.normalize(reference.path), hash: hash(reference.text) }
  };
  const key = cacheKey("write", identity);
  const startedAt = Date.now();
  const cached = options.refresh ? null : await getCached(config, key);
  const response = cached ?? await chat(config, buildWritePrompt(reference, options.spec));
  const content = stripWrappingFence(response.text);

  if (target) await writeTarget(target, content, options.force);
  if (!cached) await setCached(config, key, { text: response.text, usage: response.usage });

  const generatedTokens = response.usage?.outputTokens ?? estimateTokens(content);
  await recordMetric(config, {
    command: "write",
    cacheHit: Boolean(cached),
    sourceBytes: reference.bytes,
    workerInputTokens: cached ? 0 : response.usage?.inputTokens,
    workerOutputTokens: cached ? 0 : response.usage?.outputTokens,
    returnedTokens: target ? 0 : estimateTokens(content),
    estimatedPrimaryTokensSaved: target ? generatedTokens : 0,
    latencyMs: Date.now() - startedAt,
    model: config.provider.model
  });

  return { content, target, cacheHit: Boolean(cached), usage: response.usage };
}
