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
  primaryAgent: {
    model: "gpt-5.6-sol",
    reasoningEffort: "high"
  },
  provider: {
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-5.6-luna",
    apiKeyEnv: "OPENAI_API_KEY",
    reasoningEffort: "low"
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
    primaryAgent: { ...DEFAULT_CONFIG.primaryAgent, ...(fileConfig.primaryAgent ?? {}) },
    provider: {
      ...DEFAULT_CONFIG.provider,
      ...(fileConfig.provider?.model && fileConfig.provider.model !== DEFAULT_CONFIG.provider.model
        ? { reasoningEffort: null } : {}),
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
    if (config.provider.model !== process.env.PROMPT_SIFT_MODEL) config.provider.reasoningEffort = null;
    config.provider.model = process.env.PROMPT_SIFT_MODEL;
  }
  if (process.env.PROMPT_SIFT_TIMEOUT_MS) {
    config.requestTimeoutMs = positiveInteger(process.env.PROMPT_SIFT_TIMEOUT_MS, "PROMPT_SIFT_TIMEOUT_MS");
  }

  if (process.env.PROMPT_SIFT_REASONING_EFFORT) {
    config.provider.reasoningEffort = process.env.PROMPT_SIFT_REASONING_EFFORT;
  }
  if (config.provider.reasoningEffort != null &&
      !["none", "low", "medium", "high", "xhigh", "max"].includes(config.provider.reasoningEffort)) {
    throw new Error("Invalid provider.reasoningEffort");
  }

  config.configPath = configPath;
  config.cacheDir = path.resolve(cwd, config.cacheDir);
  config.metricsFile = path.resolve(cwd, config.metricsFile);
  return config;
}
