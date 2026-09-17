import fs from "node:fs/promises";
import path from "node:path";
import { DEFAULT_CONFIG } from "../config.js";

const RUNNER = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const host = process.argv[2];
const input = fs.readFileSync(0);
const allow = host === "claude" ? {} : host === "cursor"
  ? { permission: "allow" }
  : { permissionDecision: "allow" };

const localBin = path.join(
  process.cwd(),
  "node_modules",
  ".bin",
  process.platform === "win32" ? "prompt-sift.cmd" : "prompt-sift"
);
const candidates = [
  process.env.PROMPT_SIFT_BIN,
  fs.existsSync(localBin) ? localBin : null,
  process.platform === "win32" ? "prompt-sift.cmd" : "prompt-sift"
].filter(Boolean);

for (const executable of candidates) {
  const result = spawnSync(executable, ["hook", "--host", host], {
    cwd: process.cwd(),
    input,
    encoding: "utf8",
    shell: process.platform === "win32" && executable.endsWith(".cmd"),
    timeout: 4_000,
    maxBuffer: 1024 * 1024
  });
  if (result.status === 0 && result.stdout.trim()) {
    process.stdout.write(result.stdout);
    process.exit(0);
  }
}

process.stderr.write("PromptSift is not available; allowing the tool call. Run npm install.\\n");
process.stdout.write(JSON.stringify(allow));
`;

const SKILL = `---
name: prompt-sift
description: Reduce primary-agent context usage by delegating broad file reading and predictable boilerplate generation to a configured small model.
---

# PromptSift

Use the installed native prompt-sift-<host>-worker subagent for file orientation and prompt-sift-<host>-primary for complex reasoning. Each definition pins its own model. Return concise summaries. Workers must use bounded reads to respect hooks; do not delegate recursively. The CLI examples below are an optional external API mode, used only when explicitly requested.

## Broad reading

Use it to orient yourself across large files when the question is specific:

\`prompt-sift read --question "What owns profile refresh?" --path src/profile.ts --path src/session.ts\`

Consume the concise result. If an edit or correctness judgment follows, search for the named symbol and directly read only the relevant range.

Do not delegate debugging, architecture, security review, concurrency analysis, safety-critical code, or final correctness decisions. For those, use search and targeted reads.

## Predictable generation

Use it for tests, fixtures, type stubs, and configuration that should closely match an existing file:

\`prompt-sift write --spec "Add tests for UserService" --reference test/order.test.js --target test/user.test.js\`

A reference is mandatory. Never add \`--force\` unless replacement is explicitly intended. After generation, inspect the diff and run the relevant formatter and tests.
`;

const COPILOT_INSTRUCTIONS = `---
applyTo: "**"
---

Delegate file orientation to prompt-sift-copilot-worker (Luna/low) and complex reasoning to prompt-sift-copilot-primary (Sol/high). Return concise summaries. Use the external PromptSift CLI only when explicitly requested. When a read is blocked, follow the hook message. Keep debugging, architecture, security, concurrency, edits, and correctness decisions in the primary agent with search plus targeted reads. Review every generated diff and run relevant tests.
`;

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw new Error(`Cannot parse ${filePath}: ${error.message}`);
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeIfMissing(filePath, content, force) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try {
    await fs.writeFile(filePath, content, { encoding: "utf8", flag: force ? "w" : "wx" });
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    throw error;
  }
}

function hasCommand(entries, fragment) {
  return entries.some((entry) => String(entry.command ?? entry.bash ?? "").includes(fragment));
}

async function installCursor(root) {
  const target = path.join(root, ".cursor", "hooks.json");
  const config = await readJson(target, { version: 1, hooks: {} });
  config.version ??= 1;
  config.hooks ??= {};
  config.hooks.preToolUse ??= [];
  if (!hasCommand(config.hooks.preToolUse, ".prompt-sift/run-hook.cjs cursor")) {
    config.hooks.preToolUse.push({
      command: "node .prompt-sift/run-hook.cjs cursor",
      matcher: "Read|Shell",
      timeout: 5,
      failClosed: false
    });
  }
  await writeJson(target, config);
  return path.relative(root, target);
}

async function installCopilot(root) {
  const target = path.join(root, ".github", "hooks", "prompt-sift.json");
  const config = await readJson(target, { version: 1, hooks: {} });
  config.version ??= 1;
  config.hooks ??= {};
  config.hooks.preToolUse ??= [];
  if (!hasCommand(config.hooks.preToolUse, ".prompt-sift/run-hook.cjs copilot")) {
    config.hooks.preToolUse.push({
      type: "command",
      command: "node .prompt-sift/run-hook.cjs copilot",
      matcher: "view|bash|powershell",
      timeoutSec: 5
    });
  }
  await writeJson(target, config);
  return path.relative(root, target);
}

async function updateGitignore(root) {
  const target = path.join(root, ".gitignore");
  let existing = "";
  try {
    existing = await fs.readFile(target, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const entries = [".prompt-sift/cache/", ".prompt-sift/metrics.jsonl"];
  const missing = entries.filter((entry) => !existing.split(/\r?\n/).includes(entry));
  if (!missing.length) return;
  const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
  await fs.appendFile(target, `${prefix}${missing.join("\n")}\n`, "utf8");
}

export async function installCommand(options) {
  const root = path.resolve(options.directory ?? process.cwd());
  const hosts = options.hosts.includes("all") ? ["cursor", "copilot", "claude"] : [...new Set(options.hosts)];
  for (const host of hosts) {
    if (!new Set(["cursor", "copilot", "claude"]).has(host)) {
      throw new Error(`Unknown host: ${host}`);
    }
  }

  const written = [];
  const runner = path.join(root, ".prompt-sift", "run-hook.cjs");
  await fs.mkdir(path.dirname(runner), { recursive: true });
  await fs.writeFile(runner, RUNNER, { encoding: "utf8", mode: 0o755 });
  written.push(path.relative(root, runner));

  const configPath = path.join(root, ".prompt-sift.json");
  if (await writeIfMissing(configPath, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, options.force)) {
    written.push(path.relative(root, configPath));
  }

  const skillPath = path.join(root, ".agents", "skills", "prompt-sift", "SKILL.md");
  if (await writeIfMissing(skillPath, SKILL, options.force)) written.push(path.relative(root, skillPath));

  if (hosts.includes("cursor")) written.push(await installCursor(root));
  if (hosts.includes("copilot")) {
    written.push(await installCopilot(root));
    const instructions = path.join(root, ".github", "instructions", "prompt-sift.instructions.md");
    if (await writeIfMissing(instructions, COPILOT_INSTRUCTIONS, options.force)) {
      written.push(path.relative(root, instructions));
    }
  }

  if (hosts.includes("claude")) {
    const target = path.join(root, ".claude", "settings.json");
    const settings = await readJson(target, {});
    settings.model ??= "opus";
    settings.effortLevel ??= "high";
    settings.hooks ??= {};
    settings.hooks.PreToolUse ??= [];
    if (!settings.hooks.PreToolUse.some(group => (group.hooks ?? []).some(hook =>
        hook.command === "node .prompt-sift/run-hook.cjs claude"))) {
      settings.hooks.PreToolUse.push({ matcher: "Read|Bash", hooks: [
        { type: "command", command: "node .prompt-sift/run-hook.cjs claude", timeout: 5 }
      ] });
    }
    await writeJson(target, settings);
    written.push(path.relative(root, target));
  }
  for (const host of hosts) {
    const skillRoot = host === "cursor" ? ".cursor/skills" : host === "copilot" ? ".github/skills" : ".claude/skills";
    for (const skill of ["bulk-reader", "code-writer"]) {
      const content = (await fs.readFile(new URL(`../../templates/skills/${skill}/SKILL.md`, import.meta.url), "utf8")).replaceAll("{{HOST}}", host);
      const target = path.join(root, skillRoot, skill, "SKILL.md");
      if (await writeIfMissing(target, content, options.force)) written.push(path.relative(root, target));
    }
    const helper = path.join(root, skillRoot, "code-writer/scripts/write-file.sh");
    if (await writeIfMissing(helper, await fs.readFile(new URL("../../templates/skills/code-writer/scripts/write-file.sh", import.meta.url), "utf8"), options.force)) written.push(path.relative(root, helper));
    const dir = host === "cursor" ? ".cursor/agents" : host === "copilot" ? ".github/agents" : ".claude/agents";
    for (const role of ["primary", "worker", "writer"]) {
      const content = await fs.readFile(new URL(`../../templates/agents/${host}-${role}.md`, import.meta.url), "utf8");
      const target = path.join(root, dir, `prompt-sift-${host}-${role}${host === "copilot" ? ".agent" : ""}.md`);
      if (await writeIfMissing(target, content, options.force)) written.push(path.relative(root, target));
    }
  }
  if (hosts.includes("cursor")) {
    const target = path.join(root, ".cursor/rules/prompt-sift.mdc");
    if (await writeIfMissing(target, `---
description: PromptSift native model routing
alwaysApply: true
---
Delegate file orientation to prompt-sift-cursor-worker (Luna/low). Use prompt-sift-cursor-primary (Sol/high) for complex reasoning and final review. Ask workers for concise summaries with source references. Workers must use bounded reads and must not recursively delegate or call the external API worker.
`, options.force)) written.push(path.relative(root, target));
  }
  await updateGitignore(root);
  return { root, hosts, written: [...new Set(written)] };
}
