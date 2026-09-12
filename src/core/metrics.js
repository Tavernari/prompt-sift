import fs from "node:fs/promises";
import path from "node:path";

export function estimateTokens(value) {
  const bytes = typeof value === "number" ? value : Buffer.byteLength(value, "utf8");
  return Math.ceil(bytes / 4);
}

export async function recordMetric(config, metric) {
  await fs.mkdir(path.dirname(config.metricsFile), { recursive: true, mode: 0o700 });
  const event = { timestamp: new Date().toISOString(), ...metric };
  await fs.appendFile(config.metricsFile, `${JSON.stringify(event)}\n`, "utf8");
}

export async function readMetrics(config) {
  try {
    const raw = await fs.readFile(config.metricsFile, "utf8");
    return raw
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

export function summarizeMetrics(events) {
  const total = events.length;
  const cacheHits = events.filter((event) => event.cacheHit).length;
  const sum = (key) => events.reduce((value, event) => value + (Number(event[key]) || 0), 0);
  return {
    calls: total,
    readCalls: events.filter((event) => event.command === "read").length,
    writeCalls: events.filter((event) => event.command === "write").length,
    cacheHits,
    cacheHitRate: total ? cacheHits / total : 0,
    sourceBytes: sum("sourceBytes"),
    workerInputTokens: sum("workerInputTokens"),
    workerOutputTokens: sum("workerOutputTokens"),
    estimatedPrimaryTokensSaved: sum("estimatedPrimaryTokensSaved"),
    totalLatencyMs: sum("latencyMs")
  };
}
