import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.js";
import { readCommand } from "../src/commands/read.js";
import { writeCommand } from "../src/commands/write.js";
import { readMetrics } from "../src/core/metrics.js";

async function worker() {
  let calls = 0;
  const server = http.createServer(async (request, response) => {
    if (request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [] }));
      return;
    }
    calls += 1;
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const isWriter = body.messages?.[0]?.content?.includes("generate one code file");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      choices: [{ message: { content: isWriter ? "```js\nexport const result = 1;\n```" : "- src/a.js: owns refresh" } }],
      usage: { prompt_tokens: 100, completion_tokens: 10 }
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    calls: () => calls,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

test("read caches identical work and records metrics", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "prompt-sift-read-"));
  const stub = await worker();
  t.after(async () => {
    await stub.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const source = path.join(root, "a.js");
  await fs.writeFile(source, "export function refresh() {}\n");
  const config = {
    ...DEFAULT_CONFIG,
    cacheDir: path.join(root, "cache"),
    metricsFile: path.join(root, "metrics.jsonl"),
    provider: { ...DEFAULT_CONFIG.provider, baseUrl: stub.baseUrl }
  };
  const options = { question: "Who owns refresh?", paths: [source], allowSensitive: false };

  const first = await readCommand(config, options);
  const second = await readCommand(config, options);

  assert.equal(first.cacheHit, false);
  assert.equal(second.cacheHit, true);
  assert.equal(stub.calls(), 1);
  assert.equal((await readMetrics(config)).length, 2);
  const changed = { ...config, provider: { ...config.provider, reasoningEffort: "high" } };
  assert.equal((await readCommand(changed, options)).cacheHit, false);
  assert.equal(stub.calls(), 2);
});

test("write waits for a complete response and protects existing targets", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "prompt-sift-write-"));
  const stub = await worker();
  t.after(async () => {
    await stub.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const reference = path.join(root, "reference.js");
  const target = path.join(root, "generated.js");
  await fs.writeFile(reference, "export const reference = true;\n");
  await fs.writeFile(target, "keep me\n");
  const config = {
    ...DEFAULT_CONFIG,
    cacheDir: path.join(root, "cache"),
    metricsFile: path.join(root, "metrics.jsonl"),
    provider: { ...DEFAULT_CONFIG.provider, baseUrl: stub.baseUrl }
  };

  await assert.rejects(
    writeCommand(config, { spec: "Generate result", reference, target, force: false, allowSensitive: false }),
    /already exists/
  );
  assert.equal(stub.calls(), 0);
  assert.equal(await fs.readFile(target, "utf8"), "keep me\n");

  await writeCommand(config, { spec: "Generate result", reference, target, force: true, allowSensitive: false });
  assert.equal(await fs.readFile(target, "utf8"), "export const result = 1;");
  assert.equal(stub.calls(), 1);
});
