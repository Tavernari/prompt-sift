#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { DEFAULT_CONFIG } from "../src/config.js";
import { evaluatePolicy } from "../src/core/policy.js";

const iterations = 100;
const root = await fs.mkdtemp(path.join(os.tmpdir(), "prompt-sift-benchmark-"));
const file = path.join(root, "large-source.js");
await fs.writeFile(file, "export const value = 1;\n".repeat(4_000));

try {
  const startedAt = performance.now();
  for (let index = 0; index < iterations; index += 1) {
    await evaluatePolicy({ toolName: "view", toolArgs: { path: file }, cwd: root }, DEFAULT_CONFIG);
  }
  const duration = performance.now() - startedAt;
  const bytes = (await fs.stat(file)).size;
  process.stdout.write(`${JSON.stringify({
    iterations,
    fileBytes: bytes,
    fileLines: 4_000,
    meanPolicyLatencyMs: duration / iterations,
    estimatedDirectContextTokens: Math.ceil(bytes / 4)
  }, null, 2)}\n`);
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
