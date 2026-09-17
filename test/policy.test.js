import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.js";
import { evaluateHook } from "../src/core/hook.js";
import { evaluatePolicy, denialMessage } from "../src/core/policy.js";
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

test("an unbounded content search of one large file is denied like a read; capped searches pass", async (t) => {
  const { root, large } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const grep = (tool_input, tool_name = "Grep") => evaluatePolicy({ tool_name, tool_input, cwd: root }, config);
  assert.equal((await grep({ pattern: "line", path: large, output_mode: "content" })).allow, false);
  assert.equal((await grep({ pattern: "line", path: large, output_mode: "content", head_limit: 100 })).allow, true);
  assert.equal((await grep({ pattern: "line", path: large, output_mode: "files_with_matches" })).allow, true);
  assert.equal((await grep({ pattern: "line", path: root, output_mode: "content" })).allow, true);
  assert.equal((await grep({ pattern: "line", output_mode: "content", head_limit: 0 })).allow, false);
  assert.equal((await grep({ pattern: "line", path: large }, "Grep")).allow, true, "Claude Code defaults to files_with_matches");
  const denied = await grep({ pattern: "line", path: large, output_mode: "content" });
  assert.equal(denied.command, "grep");
});

// Parity with hook.sh: the installed (non-marketplace) path runs this policy through run-hook.cjs.
test("shell dumpers: sums, globs, git history and diffs, find -exec cat", async (t) => {
  const { spawnSync } = await import("node:child_process");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sift-dumpers-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "a", GIT_AUTHOR_EMAIL: "a@a", GIT_COMMITTER_NAME: "a", GIT_COMMITTER_EMAIL: "a@a" } });
    assert.equal(result.status, 0, result.stderr);
  };
  await fs.mkdir(path.join(root, "Sources"));
  await fs.mkdir(path.join(root, "Generated"));
  for (const name of ["a", "b", "c"]) await fs.writeFile(path.join(root, "Sources", `${name}.swift`), "let x = 1\n".repeat(200));
  await fs.writeFile(path.join(root, "small.swift"), "let x = 1\n".repeat(20));
  await fs.writeFile(path.join(root, "Generated", "big.swift"), "let x = 1\n".repeat(20));
  git("init", "-q"); git("add", "."); git("commit", "-qm", "base");
  await fs.writeFile(path.join(root, "Generated", "big.swift"), "let x = 2\n".repeat(500));
  git("commit", "-qam", "big");
  await fs.writeFile(path.join(root, "Generated", "big.swift"), "let x = 3\n".repeat(600));
  const config = DEFAULT_CONFIG;
  const run = (command) => evaluateShellCommand(command, config, root);
  const denied = {
    "cat Sources/a.swift Sources/b.swift Sources/c.swift": /Sources\/a\.swift.*together/,
    "cat Sources/*.swift": /Sources\/\*\.swift/,
    "git log -p": /git log -p/,
    "git log --patch --since=1.week": /git log/,
    "git diff": /git diff.*1100 changed lines/,
    "git diff -- Generated/big.swift": /git diff.*Generated\/big\.swift.*1100 changed lines/,
    "git show HEAD": /git show.*520 changed lines/,
    "git diff HEAD~1 HEAD": /git diff/,
    'find Sources -name "*.swift" -exec cat {} +': /find .* -exec cat/,
    "find Sources -type f | xargs cat": /xargs cat/
  };
  for (const [command, pattern] of Object.entries(denied)) {
    const result = await run(command);
    assert.equal(result.allow, false, command);
    const message = denialMessage(result, "cursor");
    assert.match(message, pattern, command);
    assert.match(message, /worker/, command);
  }
  for (const command of [
    "cat Sources/a.swift Sources/b.swift Sources/c.swift | head -100", "cat small.swift Sources/c.swift", 'cat "Sources/nothing*.swift"',
    "git log --oneline", "git log -p -3", "git log -p -n 2", "git log --patch --max-count=1", "git log -p | head -200",
    "git diff --stat", "git diff -- small.swift", "git diff -- Sources", "git diff | head -100", "git show --stat HEAD", "git show HEAD:small.swift",
    'find Sources -name "*.swift"', 'find Sources -name "*.swift" -exec grep -l x {} +', 'find Sources -name "*.swift" -exec cat {} + | head -50',
    "find Sources -type f | xargs grep -l x", "echo Sources/*.swift"
  ]) assert.equal((await run(command)).allow, true, command);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "sift-nogit-"));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  assert.equal((await evaluateShellCommand("git diff", config, outside)).allow, true);
  assert.equal((await evaluateShellCommand("git log -p", config, outside)).allow, false);
});
