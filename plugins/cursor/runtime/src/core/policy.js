import path from "node:path";
import { inspectFile } from "./files.js";
import { evaluateShellCommand } from "./shell.js";

function firstDefined(object, keys) {
  for (const key of keys) {
    if (object && object[key] !== undefined) return object[key];
  }
  return undefined;
}

function normalizedTool(payload) {
  return String(payload.toolName ?? payload.tool_name ?? "").toLowerCase();
}

function normalizedArgs(payload) {
  const value = payload.toolArgs ?? payload.tool_input ?? {};
  if (typeof value !== "string") return value ?? {};
  try { return JSON.parse(value) ?? {}; } catch { return {}; }
}

function targetedLineCount(args) {
  if (args.view_range !== undefined) {
    const range = args.view_range;
    if (!Array.isArray(range) || range.length !== 2) return null;
    const [start, end] = range;
    return Number.isInteger(start) && Number.isInteger(end) && start >= 1 && end >= start
      ? end - start + 1 : null;
  }
  const limit = Number(firstDefined(args, ["limit", "line_limit", "lineLimit"]));
  return Number.isFinite(limit) && limit > 0 ? limit : null;
}

export async function evaluatePolicy(payload, config) {
  const tool = normalizedTool(payload);
  const args = normalizedArgs(payload);
  const cwd = payload.cwd ?? process.cwd();

  if (["read", "view"].includes(tool)) {
    const filePath = firstDefined(args, ["path", "file_path", "filePath"]);
    if (!filePath) return { allow: true };

    const limit = targetedLineCount(args);
    if (limit !== null && limit <= config.maxTargetedLines) return { allow: true };

    const file = await inspectFile(path.resolve(cwd, filePath), config);
    if (!file.readable || !file.large) return { allow: true };
    return {
      allow: false,
      path: file.path,
      bytes: file.bytes,
      lines: file.lines,
      command: tool
    };
  }

  if (["shell", "bash", "powershell"].includes(tool)) {
    const command = firstDefined(args, ["command", "cmd", "script"]);
    if (typeof command !== "string") return { allow: true };
    return evaluateShellCommand(command, config, cwd);
  }

  return { allow: true };
}

export function denialMessage(result, host) {
  const relative = path.relative(process.cwd(), result.path) || result.path;
  return [
    `PromptSift blocked a broad read of ${relative} (${result.lines} lines, ${result.bytes} bytes).`,
    `Delegate orientation to prompt-sift-${host}-worker; it must use bounded reads of at most the configured maxTargetedLines and return a concise summary. Use prompt-sift-${host}-primary for complex reasoning.`,
    `For an explicitly requested external API worker, run: prompt-sift read --question \"<specific question>\" --path ${JSON.stringify(relative)}`,
    "For debugging, security, concurrency, architecture, or edits, use search plus a targeted read instead."
  ].join(" ");
}
