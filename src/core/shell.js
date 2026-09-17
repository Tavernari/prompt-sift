import path from "node:path";
import { inspectFile } from "./files.js";

const SEGMENT_OPERATORS = new Set(["&&", "||", ";"]);
const PIPE_OPERATORS = new Set(["|", "|&"]);
const REDIRECT_OPERATORS = new Set([">", ">>", "1>", "1>>", "2>", "2>>", "&>", "&>>"]);
const OUTPUT_REDIRECT_OPERATORS = new Set([">", ">>", "1>", "1>>", "&>", "&>>"]);
const READ_COMMANDS = new Set(["cat", "less", "more", "head", "tail"]);
const REDUCING_COMMANDS = new Set(["grep", "rg", "head", "tail", "wc"]);

export function tokenizeShell(command) {
  const tokens = [];
  let current = "";
  let quote = null;
  let escaped = false;

  const push = () => {
    if (current.length) tokens.push(current);
    current = "";
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    const next = command[index + 1] ?? "";

    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      push();
      continue;
    }

    if (/^[012]$/.test(char) && next === ">") {
      push();
      if (command[index + 2] === ">") {
        tokens.push(`${char}>>`);
        index += 2;
      } else {
        tokens.push(`${char}>`);
        index += 1;
      }
      continue;
    }

    const pair = `${char}${next}`;
    if (["&&", "||", ">>", "|&", "&>"].includes(pair)) {
      push();
      if ((pair === ">>" || pair === "&>") && command[index + 2] === ">") {
        tokens.push(`${pair}>`);
        index += 2;
      } else {
        tokens.push(pair);
        index += 1;
      }
      continue;
    }
    if ([";", "|", ">"].includes(char)) {
      push();
      tokens.push(char);
      continue;
    }
    current += char;
  }
  push();
  return tokens;
}

function splitSegments(tokens) {
  const segments = [];
  let current = [];
  for (const token of tokens) {
    if (SEGMENT_OPERATORS.has(token)) {
      if (current.length) segments.push(current);
      current = [];
    } else {
      current.push(token);
    }
  }
  if (current.length) segments.push(current);
  return segments;
}

function basename(command) {
  return path.basename(command).toLowerCase();
}

function commandParts(segment) {
  const parts = [];
  let current = [];
  for (const token of segment) {
    if (PIPE_OPERATORS.has(token)) {
      if (current.length) parts.push(current);
      current = [];
    } else {
      current.push(token);
    }
  }
  if (current.length) parts.push(current);
  return parts;
}

function parseAmount(value) {
  if (String(value).startsWith("+")) return Number.POSITIVE_INFINITY;
  const amount = Number.parseInt(value, 10);
  return Number.isFinite(amount) ? Math.abs(amount) : null;
}

function requestedHeadTailWindow(args) {
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    const compact = value.match(/^-(\d+)$/);
    if (compact) return { kind: "lines", amount: Number.parseInt(compact[1], 10) };
    if (value === "-n" || value === "--lines") {
      const amount = parseAmount(args[index + 1]);
      if (amount !== null) return { kind: "lines", amount };
    }
    const lineEquals = value.match(/^--lines=(.+)$/);
    if (lineEquals) return { kind: "lines", amount: parseAmount(lineEquals[1]) };
    if (value === "-c" || value === "--bytes") {
      const amount = parseAmount(args[index + 1]);
      if (amount !== null) return { kind: "bytes", amount };
    }
    const byteEquals = value.match(/^(?:-c|--bytes=)(.+)$/);
    if (byteEquals) return { kind: "bytes", amount: parseAmount(byteEquals[1]) };
  }
  return { kind: "lines", amount: 10 };
}

function candidatePaths(args) {
  const result = [];
  const optionsWithValues = new Set(["-n", "--lines", "-c", "--bytes"]);
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (REDIRECT_OPERATORS.has(token)) {
      index += 1;
      continue;
    }
    if (optionsWithValues.has(token)) {
      index += 1;
      continue;
    }
    if (token === "--") {
      result.push(...args.slice(index + 1).filter((item) => item !== "-"));
      break;
    }
    if (token === "-" || token.startsWith("-")) continue;
    result.push(token);
  }
  return result;
}

function hasOutputRedirection(tokens) {
  return tokens.some((token) => OUTPUT_REDIRECT_OPERATORS.has(token));
}

function pipelineReducesOutput(parts) {
  if (parts.length < 2) return false;
  return parts.slice(1).some((part) => REDUCING_COMMANDS.has(basename(part[0] ?? "")));
}

export async function evaluateShellCommand(command, config, cwd = process.cwd()) {
  const tokens = tokenizeShell(command);
  for (const segment of splitSegments(tokens)) {
    const parts = commandParts(segment);
    for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
      const part = parts[partIndex];
      const commandName = basename(part[0] ?? "");
      if (!READ_COMMANDS.has(commandName)) continue;
      if (hasOutputRedirection(part)) continue;
      if (partIndex === 0 && pipelineReducesOutput(parts)) continue;

      const args = part.slice(1);
      const targetedWindow = commandName === "head" || commandName === "tail"
        ? requestedHeadTailWindow(args)
        : null;
      if (
        targetedWindow?.kind === "lines" && targetedWindow.amount <= config.maxTargetedLines ||
        targetedWindow?.kind === "bytes" && targetedWindow.amount <= config.maxBytes
      ) continue;

      for (const candidate of candidatePaths(args)) {
        const file = await inspectFile(path.resolve(cwd, candidate), config);
        if (!file.readable || file.binary) continue;
        if (file.large) {
          return {
            allow: false,
            path: file.path,
            bytes: file.bytes,
            lines: file.lines,
            command: commandName
          };
        }
      }
    }
  }
  return { allow: true };
}
