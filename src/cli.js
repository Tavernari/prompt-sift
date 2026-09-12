import path from "node:path";
import { loadConfig } from "./config.js";
import { doctorCommand } from "./commands/doctor.js";
import { installCommand } from "./commands/install.js";
import { readCommand } from "./commands/read.js";
import { writeCommand } from "./commands/write.js";
import { inspectFiles } from "./core/files.js";
import { evaluateHook } from "./core/hook.js";
import { readMetrics, summarizeMetrics } from "./core/metrics.js";

const HELP = `PromptSift — keep expensive agents focused on reasoning

Usage:
  prompt-sift install [--host cursor,copilot,claude] [--directory PATH]
  prompt-sift read --question TEXT --path FILE [--path FILE ...]
  prompt-sift write --spec TEXT --reference FILE [--target FILE] [--force]
  prompt-sift inspect --path FILE [--path FILE ...]
  prompt-sift hook --host cursor|copilot|claude
  prompt-sift doctor
  prompt-sift stats [--json]

Common options:
  --config FILE       Use a different configuration file
  --json              Emit machine-readable output
  --refresh           Ignore an exact cache hit
  --allow-sensitive   Allow secret-looking paths after explicit review
  --dry-run           Inspect a read without calling the worker
`;

function camelCase(value) {
  return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function parseOptions(argv) {
  const options = { paths: [], hosts: [] };
  const booleanKeys = new Set(["json", "force", "refresh", "allow-sensitive", "dry-run", "help"]);

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const [rawKey, inlineValue] = token.slice(2).split(/=(.*)/s, 2);
    const key = camelCase(rawKey);
    if (booleanKeys.has(rawKey)) {
      options[key] = inlineValue === undefined ? true : inlineValue !== "false";
      continue;
    }

    if (rawKey === "path" || rawKey === "paths") {
      if (inlineValue !== undefined) {
        options.paths.push(inlineValue);
        continue;
      }
      let consumed = 0;
      while (argv[index + 1] && !argv[index + 1].startsWith("--")) {
        options.paths.push(argv[index + 1]);
        index += 1;
        consumed += 1;
        if (rawKey === "path") break;
      }
      if (!consumed) throw new Error(`--${rawKey} requires a value`);
      continue;
    }

    const value = inlineValue ?? argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`--${rawKey} requires a value`);
    if (inlineValue === undefined) index += 1;
    if (rawKey === "host") {
      options.host = value;
      options.hosts.push(...value.split(",").map((item) => item.trim()).filter(Boolean));
      continue;
    }
    options[key] = value;
  }
  return options;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function output(value, asJson) {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  if (typeof value === "string") process.stdout.write(`${value}\n`);
  else process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export async function main(argv) {
  const command = argv[0];
  if (!command || ["help", "--help", "-h"].includes(command)) {
    process.stdout.write(HELP);
    return;
  }

  const options = parseOptions(argv.slice(1));
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }

  if (["install", "init"].includes(command)) {
    options.hosts = options.hosts.length ? options.hosts : ["cursor", "copilot"];
    output(await installCommand(options), options.json);
    return;
  }

  const cwd = path.resolve(options.directory ?? process.cwd());
  const config = await loadConfig(cwd, options.config);

  if (command === "hook") {
    const payload = JSON.parse(await readStdin());
    output(await evaluateHook(options.host, payload, config), true);
    return;
  }
  if (command === "read") {
    const result = await readCommand(config, options);
    output(options.json || options.dryRun ? result : result.text, options.json || options.dryRun);
    return;
  }
  if (command === "write") {
    const result = await writeCommand(config, options);
    output(options.json ? result : result.target ? `Wrote ${result.target}` : result.content, options.json);
    return;
  }
  if (command === "inspect") {
    const files = await inspectFiles(options.paths, config);
    const safe = files.map(({ contents: _, ...file }) => file);
    output(safe, true);
    return;
  }
  if (command === "doctor") {
    const checks = await doctorCommand(config, cwd);
    if (options.json) output(checks, true);
    else {
      for (const check of checks) {
        process.stdout.write(`${check.ok ? "PASS" : "FAIL"}  ${check.name} — ${check.detail}\n`);
      }
      if (checks.some((check) => !check.ok)) process.exitCode = 1;
    }
    return;
  }
  if (command === "stats") {
    const summary = summarizeMetrics(await readMetrics(config));
    if (options.json) output(summary, true);
    else {
      process.stdout.write(`Calls: ${summary.calls}\n`);
      process.stdout.write(`Cache hit rate: ${(summary.cacheHitRate * 100).toFixed(1)}%\n`);
      process.stdout.write(`Source bytes processed: ${summary.sourceBytes}\n`);
      process.stdout.write(`Estimated primary tokens saved: ${summary.estimatedPrimaryTokensSaved}\n`);
      process.stdout.write(`Worker tokens: ${summary.workerInputTokens} in / ${summary.workerOutputTokens} out\n`);
    }
    return;
  }

  throw new Error(`Unknown command: ${command}\n\n${HELP}`);
}
