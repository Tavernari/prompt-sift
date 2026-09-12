import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(executable, args, { cwd, env = process.env, input = "" } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env, shell: false });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({
      code,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8")
    }));
    child.stdin.end(input);
  });
}

async function createWorker() {
  let chatCalls = 0;
  const server = http.createServer(async (request, response) => {
    if (request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "test-worker" }] }));
      return;
    }

    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const isWriter = body.messages?.[0]?.content?.includes("generate one code file");
    chatCalls += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      choices: [{
        message: {
          content: isWriter
            ? "```js\nexport const generated = true;\n```"
            : "- large.js: exports repeated values"
        }
      }],
      usage: { prompt_tokens: 120, completion_tokens: 12 }
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    chatCalls: () => chatCalls,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

test("installed CLI, Cursor hook, Copilot hook, cache, writer, doctor, and stats work end to end", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "prompt-sift-e2e-"));
  const worker = await createWorker();
  t.after(async () => {
    await worker.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  await fs.writeFile(path.join(root, "package.json"), "{\"private\":true}\n");
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const installed = await run(npm, [
    "install",
    packageRoot,
    "--ignore-scripts",
    "--no-audit",
    "--no-fund"
  ], { cwd: root });
  assert.equal(installed.code, 0, installed.stderr);

  const cli = path.join(root, "node_modules", "prompt-sift", "bin", "prompt-sift.js");
  const initialized = await run(process.execPath, [cli, "install", "--host", "cursor,copilot"], { cwd: root });
  assert.equal(initialized.code, 0, initialized.stderr);

  await fs.writeFile(path.join(root, "large.js"), "export const value = 1;\n".repeat(500));
  await fs.writeFile(path.join(root, "small.js"), "export const small = true;\n");
  const runner = path.join(root, ".prompt-sift", "run-hook.cjs");

  const cursorDenied = await run(process.execPath, [runner, "cursor"], {
    cwd: root,
    input: JSON.stringify({ tool_name: "Read", tool_input: { file_path: "large.js" }, cwd: root })
  });
  assert.equal(cursorDenied.code, 0, cursorDenied.stderr);
  assert.equal(JSON.parse(cursorDenied.stdout).permission, "deny");

  const cursorAllowed = await run(process.execPath, [runner, "cursor"], {
    cwd: root,
    input: JSON.stringify({
      tool_name: "Read",
      tool_input: { file_path: "large.js", limit: 100 },
      cwd: root
    })
  });
  assert.equal(JSON.parse(cursorAllowed.stdout).permission, "allow");

  const copilotDenied = await run(process.execPath, [runner, "copilot"], {
    cwd: root,
    input: JSON.stringify({ toolName: "view", toolArgs: { path: "large.js" }, cwd: root })
  });
  assert.equal(copilotDenied.code, 0, copilotDenied.stderr);
  assert.equal(JSON.parse(copilotDenied.stdout).permissionDecision, "deny");

  const env = {
    ...process.env,
    PROMPT_SIFT_BASE_URL: worker.baseUrl,
    PROMPT_SIFT_MODEL: "test-worker"
  };
  const readArgs = [cli, "read", "--question", "What is exported?", "--path", "large.js"];
  const firstRead = await run(process.execPath, readArgs, { cwd: root, env });
  const cachedRead = await run(process.execPath, readArgs, { cwd: root, env });
  assert.equal(firstRead.code, 0, firstRead.stderr);
  assert.match(firstRead.stdout, /exports repeated values/);
  assert.equal(cachedRead.code, 0, cachedRead.stderr);
  assert.equal(worker.chatCalls(), 1);

  const target = path.join(root, "generated.js");
  const writeArgs = [
    cli,
    "write",
    "--spec",
    "Generate a matching export",
    "--reference",
    "small.js",
    "--target",
    "generated.js"
  ];
  const write = await run(process.execPath, writeArgs, { cwd: root, env });
  assert.equal(write.code, 0, write.stderr);
  assert.equal(await fs.readFile(target, "utf8"), "export const generated = true;");

  const protectedWrite = await run(process.execPath, writeArgs, { cwd: root, env });
  assert.notEqual(protectedWrite.code, 0);
  assert.match(protectedWrite.stderr, /already exists/);
  assert.equal(await fs.readFile(target, "utf8"), "export const generated = true;");

  const doctor = await run(process.execPath, [cli, "doctor"], { cwd: root, env });
  assert.equal(doctor.code, 0, doctor.stdout + doctor.stderr);
  assert.match(doctor.stdout, /PASS  Cursor hook/);
  assert.match(doctor.stdout, /PASS  Copilot hook/);
  assert.match(doctor.stdout, /PASS  Worker endpoint/);

  const stats = await run(process.execPath, [cli, "stats", "--json"], { cwd: root, env });
  assert.equal(stats.code, 0, stats.stderr);
  const metrics = JSON.parse(stats.stdout);
  assert.equal(metrics.calls, 3);
  assert.equal(metrics.cacheHits, 1);
  assert.ok(metrics.estimatedPrimaryTokensSaved > 0);
});
