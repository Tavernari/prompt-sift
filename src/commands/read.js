import path from "node:path";
import { loadTextFiles } from "../core/files.js";
import { cacheKey, getCached, hash, setCached } from "../core/cache.js";
import { estimateTokens, recordMetric } from "../core/metrics.js";
import { buildReadPrompt, PROMPT_VERSION } from "../core/prompts.js";
import { chat } from "../providers/openai-compatible.js";

export async function readCommand(config, options) {
  if (!options.question) throw new Error("--question is required");
  const files = await loadTextFiles(options.paths, config, { allowSensitive: options.allowSensitive });
  const sourceBytes = files.reduce((sum, file) => sum + file.bytes, 0);
  const identity = {
    promptVersion: PROMPT_VERSION,
    model: config.provider.model,
    baseUrl: config.provider.baseUrl,
    question: options.question,
    files: files.map((file) => ({ path: path.normalize(file.path), hash: hash(file.text) }))
  };
  const key = cacheKey("read", identity);

  if (options.dryRun) {
    return {
      dryRun: true,
      sourceBytes,
      estimatedSourceTokens: estimateTokens(sourceBytes),
      files: files.map(({ path: filePath, bytes, lines }) => ({ path: filePath, bytes, lines }))
    };
  }

  const startedAt = Date.now();
  const cached = options.refresh ? null : await getCached(config, key);
  if (cached) {
    const returnedTokens = estimateTokens(cached.text);
    await recordMetric(config, {
      command: "read",
      cacheHit: true,
      sourceBytes,
      workerInputTokens: 0,
      workerOutputTokens: 0,
      returnedTokens,
      estimatedPrimaryTokensSaved: Math.max(0, estimateTokens(sourceBytes) - returnedTokens),
      latencyMs: Date.now() - startedAt,
      model: config.provider.model
    });
    return { ...cached, cacheHit: true };
  }

  const response = await chat(config, buildReadPrompt(files, options.question));
  const result = { text: response.text.trim(), cacheHit: false, usage: response.usage };
  await setCached(config, key, result);

  const returnedTokens = estimateTokens(result.text);
  await recordMetric(config, {
    command: "read",
    cacheHit: false,
    sourceBytes,
    workerInputTokens: response.usage.inputTokens,
    workerOutputTokens: response.usage.outputTokens,
    returnedTokens,
    estimatedPrimaryTokensSaved: Math.max(0, estimateTokens(sourceBytes) - returnedTokens),
    latencyMs: Date.now() - startedAt,
    model: config.provider.model
  });
  return result;
}
