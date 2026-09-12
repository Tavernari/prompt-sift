import fs from "node:fs/promises";
import path from "node:path";

export const DEFAULT_CONFIG = Object.freeze({
  minLines: 350,
  maxBytes: 50_000,
  maxTargetedLines: 350,
  maxPayloadBytes: 400_000,
  requestTimeoutMs: 60_000,
  cache: true,
  cacheDir: ".prompt-sift/cache",
  metricsFile: ".prompt-sift/metrics.jsonl",
  provider: {
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "qwen2.5-coder:3b",
    apiKeyEnv: "PROMPT_SIFT_API_KEY",
    temperature: 0.2
  }
});

function positiveInteger(value, name) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function mergeConfig(fileConfig = {}) {
  return {
    ...DEFAULT_CONFIG,
    ...fileConfig,
    provider: {
      ...DEFAULT_CONFIG.provider,
      ...(fileConfig.provider ?? {})
    }
  };
}

export async function loadConfig(cwd = process.cwd(), explicitPath) {
  const configPath = explicitPath
    ? path.resolve(cwd, explicitPath)
    : path.join(cwd, ".prompt-sift.json");

  let fileConfig = {};
  try {
    const raw = await fs.readFile(configPath, "utf8");
    fileConfig = JSON.parse(raw);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw new Error(`Cannot read ${configPath}: ${error.message}`);
    }
  }

  const config = mergeConfig(fileConfig);

  if (process.env.PROMPT_SIFT_MIN_LINES) {
    config.minLines = positiveInteger(process.env.PROMPT_SIFT_MIN_LINES, "PROMPT_SIFT_MIN_LINES");
  }
  if (process.env.PROMPT_SIFT_MAX_BYTES) {
    config.maxBytes = positiveInteger(process.env.PROMPT_SIFT_MAX_BYTES, "PROMPT_SIFT_MAX_BYTES");
  }
  if (process.env.PROMPT_SIFT_MAX_TARGETED_LINES) {
    config.maxTargetedLines = positiveInteger(
      process.env.PROMPT_SIFT_MAX_TARGETED_LINES,
      "PROMPT_SIFT_MAX_TARGETED_LINES"
    );
  }
  if (process.env.PROMPT_SIFT_BASE_URL) {
    config.provider.baseUrl = process.env.PROMPT_SIFT_BASE_URL;
  }
  if (process.env.PROMPT_SIFT_MODEL) {
    config.provider.model = process.env.PROMPT_SIFT_MODEL;
  }
  if (process.env.PROMPT_SIFT_TIMEOUT_MS) {
    config.requestTimeoutMs = positiveInteger(process.env.PROMPT_SIFT_TIMEOUT_MS, "PROMPT_SIFT_TIMEOUT_MS");
  }

  config.configPath = configPath;
  config.cacheDir = path.resolve(cwd, config.cacheDir);
  config.metricsFile = path.resolve(cwd, config.metricsFile);
  return config;
}
