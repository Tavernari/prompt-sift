import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.js";
import { evaluateHook } from "../src/core/hook.js";
import { evaluatePolicy } from "../src/core/policy.js";
import { evaluateShellCommand, tokenizeShell } from "../src/core/shell.js";

const config = { ...DEFAULT_CONFIG, provider: { ...DEFAULT_CONFIG.provider } };

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "prompt-sift-policy-"));
  const large = path.join(root, "big file.txt");
  const minified = path.join(root, "minified.js");
  await fs.writeFile(large, `${"line\n".repeat(500)}`);
  await fs.writeFile(minified, "x".repeat(config.maxBytes + 1));
  return { root, large, minified };
}

test("tokenizer keeps quoted paths and separates chained commands", () => {
  assert.deepEqual(tokenizeShell(`cd . && cat 'big file.txt'`), ["cd", ".", "&&", "cat", "big file.txt"]);
});

test("large direct reads are denied but targeted reads are allowed", async (t) => {
  const { root, large } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const denied = await evaluatePolicy({
    tool_name: "Read",
    tool_input: { file_path: large },
    cwd: root
  }, config);
  assert.equal(denied.allow, false);

  const allowed = await evaluatePolicy({
    tool_name: "Read",
    tool_input: { file_path: large, limit: 100 },
    cwd: root
  }, config);
  assert.equal(allowed.allow, true);
});

test("byte ceiling catches minified files", async (t) => {
  const { root, minified } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const result = await evaluatePolicy({ toolName: "view", toolArgs: { path: minified }, cwd: root }, config);
  assert.equal(result.allow, false);
  assert.equal(result.lines, 1);
});

test("missing files fail open so the host reports the real error", async () => {
  const result = await evaluatePolicy({
    toolName: "view",
    toolArgs: { path: "/does/not/exist" },
    cwd: "/"
  }, config);
  assert.equal(result.allow, true);
});

test("shell policy handles chaining, quotes, partial reads, pipes, and redirects", async (t) => {
  const { root } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  assert.equal((await evaluateShellCommand(`cd . && cat 'big file.txt'`, config, root)).allow, false);
  assert.equal((await evaluateShellCommand(`  cat 'big file.txt'`, config, root)).allow, false);
  assert.equal((await evaluateShellCommand(`head -100 'big file.txt'`, config, root)).allow, true);
  assert.equal((await evaluateShellCommand(`head -n 500 'big file.txt'`, config, root)).allow, false);
  assert.equal((await evaluateShellCommand(`head -c 100 'big file.txt'`, config, root)).allow, true);
  assert.equal((await evaluateShellCommand(`tail -n +1 'big file.txt'`, config, root)).allow, false);
  assert.equal((await evaluateShellCommand(`cat 'big file.txt' | grep needle`, config, root)).allow, true);
  assert.equal((await evaluateShellCommand(`cat 'big file.txt' > copy.txt`, config, root)).allow, true);
  assert.equal((await evaluateShellCommand(`cat 'big file.txt' 2> errors.txt`, config, root)).allow, false);
});

test("host adapters emit their native deny schemas", async (t) => {
  const { root, large } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const payload = { tool_name: "Read", tool_input: { file_path: large }, cwd: root };

  const cursor = await evaluateHook("cursor", payload, config);
  assert.equal(cursor.permission, "deny");
  assert.match(cursor.agent_message, /prompt-sift read/);

  const copilot = await evaluateHook("copilot", payload, config);
  assert.equal(copilot.permissionDecision, "deny");
  assert.match(copilot.permissionDecisionReason, /targeted read/);
});

test("binary files are never gated, however large they are", async (t) => {
  const { root } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const image = path.join(root, "screenshot.png");
  await fs.writeFile(image, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0x0d]), Buffer.alloc(config.maxBytes + 1, 0xab)]));
  const result = await evaluatePolicy({ tool_name: "Read", tool_input: { file_path: image }, cwd: root }, config);
  assert.equal(result.allow, true);
  const shell = await evaluatePolicy({ tool_name: "Bash", tool_input: { command: "cat screenshot.png" }, cwd: root }, config);
  assert.equal(shell.allow, true);
});
