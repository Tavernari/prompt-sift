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
    // The host renders images and PDFs itself; a worker cannot summarise them.
    if (!file.readable || file.binary || !file.large) return { allow: true };
    return {
      allow: false,
      path: file.path,
      bytes: file.bytes,
      lines: file.lines,
      command: tool
    };
  }

  if (["grep", "rg"].includes(tool) && args.pattern !== undefined) {
    // Only what can be measured is gated: a content-mode search of one large file with no bound
    // under maxTargetedLines is that file's read in disguise. Directory searches are the host's
    // own cap to enforce, except an explicit head_limit of 0, which Claude Code treats as unlimited.
    const host = payload.host ?? "claude";
    const mode = args.output_mode ?? (host === "claude" ? "files_with_matches" : "content");
    if (mode !== "content") return { allow: true };
    const head = args.head_limit;
    if (Number.isInteger(head) && head > 0 && head <= config.maxTargetedLines) return { allow: true };
    const filePath = firstDefined(args, ["path"]);
    if (head === 0 && host === "claude") {
      return { allow: false, path: filePath ? path.resolve(cwd, filePath) : cwd, bytes: 0, lines: 0, command: "grep" };
    }
    if (!filePath) return { allow: true };
    const file = await inspectFile(path.resolve(cwd, filePath), config);
    if (!file.readable || file.binary || !file.large) return { allow: true };
    return { allow: false, path: file.path, bytes: file.bytes, lines: file.lines, command: "grep" };
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
  if (result.command === "grep") {
    return `PromptSift blocked an unbounded content search of ${relative}. Use output_mode files_with_matches or count, a bounded head_limit, a narrower path, or delegate orientation to prompt-sift-${host}-worker.`;
  }
  return [
    `PromptSift blocked a broad read of ${relative} (${result.lines} lines, ${result.bytes} bytes).`,
    `Delegate orientation to prompt-sift-${host}-worker; it must use bounded reads of at most the configured maxTargetedLines and return a concise summary. Use prompt-sift-${host}-primary for complex reasoning.`,
    `For an explicitly requested external API worker, run: prompt-sift read --question \"<specific question>\" --path ${JSON.stringify(relative)}`,
    "For debugging, security, concurrency, architecture, or edits, use search plus a targeted read instead."
  ].join(" ");
}
