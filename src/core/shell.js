import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
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

// A part is reduced when a later stage of its pipeline is a reducer (grep, head, wc ...).
function reducedAfter(parts, index) {
  return parts.slice(index + 1).some((part) => REDUCING_COMMANDS.has(basename(part[0] ?? "")));
}

const DIFF_SUMMARY_FLAGS = /^(--stat|--numstat|--shortstat|--name-only|--name-status|--dirstat|--summary|--no-patch|-s|--check|--raw|--quiet|--exit-code|--stat=.*|--dirstat=.*)$/;
const DIFF_NOISE_FLAGS = /^(-p|--patch|-u|--no-stat|--color|--no-color)$/;
const DUMP_COMMANDS = new Set(["cat", "less", "more"]);

// git diff/show sized with --numstat: read-only, no pager, no index lock, never the inspected command.
function gitChangedLines(subcommand, args, cwd) {
  try {
    const output = execFileSync("git", [
      "--no-pager", "-c", "core.pager=cat", subcommand, "--numstat", "--no-ext-diff", "--no-color",
      ...(subcommand === "show" ? ["--format="] : []), ...args
    ], { cwd, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
    return output.split("\n").reduce((total, line) => {
      const [added, deleted] = line.split("\t");
      return /^\d+$/.test(added ?? "") ? total + Number(added) + Number(deleted) : total;
    }, 0);
  } catch {
    return null;
  }
}

// Dumpers the policy cannot size by looking at a path: an unbounded history dump, a diff (sized
// with git itself), every file find or xargs hands to cat.
function dumper(part, config, cwd) {
  const command = basename(part[0] ?? "");
  if (command === "git") {
    let index = 1;
    while (index < part.length && part[index].startsWith("-")) index += part[index] === "-C" || part[index] === "-c" ? 2 : 1;
    const subcommand = part[index];
    const args = part.slice(index + 1);
    if (subcommand === "log") {
      const patch = args.some((arg) => /^(-p|--patch|-u)$/.test(arg));
      const bounded = args.some((arg) => /^(-n|--max-count)$/.test(arg) || /^-n\d+$/.test(arg) || /^--max-count=/.test(arg) || /^-\d+$/.test(arg));
      return patch && !bounded ? { kind: "unbounded", description: "git log -p (the whole history with every diff)" } : { kind: "none" };
    }
    if (subcommand === "diff" || subcommand === "show") {
      if (args.some((arg) => DIFF_SUMMARY_FLAGS.test(arg))) return { kind: "none" };
      if (subcommand === "show" && args.some((arg) => !arg.startsWith("-") && arg.includes(":"))) return { kind: "none" };
      const measured = args.filter((arg) => !DIFF_NOISE_FLAGS.test(arg));
      const changed = gitChangedLines(subcommand, measured, cwd);
      if (changed === null || changed <= config.minLines) return { kind: "none" };
      return { kind: "diff", description: `git ${[subcommand, ...measured].join(" ")}: ${changed} changed lines`, lines: changed };
    }
    return { kind: "none" };
  }
  if (command === "find") {
    const exec = part.findIndex((arg) => /^-(exec|execdir|ok|okdir)$/.test(arg));
    if (exec !== -1 && DUMP_COMMANDS.has(basename(part[exec + 1] ?? ""))) return { kind: "unbounded", description: "find ... -exec cat (every file it finds, in full)" };
    return { kind: "none" };
  }
  if (command === "xargs") {
    for (let index = 1; index < part.length; index += 1) {
      if (/^-(n|I|P|d|L|s|E)$/.test(part[index])) { index += 1; continue; }
      if (part[index].startsWith("-")) continue;
      return DUMP_COMMANDS.has(basename(part[index])) ? { kind: "unbounded", description: "xargs cat (every listed file, in full)" } : { kind: "none" };
    }
    return { kind: "none" };
  }
  return { kind: "handled" };
}

// Globs are expanded here, never by running the command: a pattern that matches nothing stays literal.
function expandGlob(candidate, cwd) {
  if (!/[*?[]/.test(candidate) || typeof fs.globSync !== "function") return [candidate];
  try {
    const matches = fs.globSync(candidate, { cwd });
    return matches.length ? matches : [];
  } catch {
    return [candidate];
  }
}

export async function evaluateShellCommand(command, config, cwd = process.cwd()) {
  const tokens = tokenizeShell(command);
  for (const segment of splitSegments(tokens)) {
    const parts = commandParts(segment);
    for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
      const part = parts[partIndex];
      const commandName = basename(part[0] ?? "");
      if (hasOutputRedirection(part)) continue;
      if (reducedAfter(parts, partIndex)) continue;
      const special = dumper(part, config, cwd);
      if (special.kind === "unbounded" || special.kind === "diff") {
        return { allow: false, path: path.resolve(cwd), bytes: 0, lines: special.lines ?? 0, command: commandName, kind: special.kind, description: special.description };
      }
      if (special.kind !== "handled") continue;
      if (!READ_COMMANDS.has(commandName)) continue;

      const args = part.slice(1);
      const targetedWindow = commandName === "head" || commandName === "tail"
        ? requestedHeadTailWindow(args)
        : null;
      if (
        targetedWindow?.kind === "lines" && targetedWindow.amount <= config.maxTargetedLines ||
        targetedWindow?.kind === "bytes" && targetedWindow.amount <= config.maxBytes
      ) continue;

      // Parts are summed: three 200-line files in one cat are a 600-line read, and so is a glob.
      let sumLines = 0;
      let sumBytes = 0;
      let count = 0;
      const names = [];
      let pattern = null;
      for (const candidate of candidatePaths(args)) {
        if (/[*?[]/.test(candidate)) pattern = candidate;
        else names.push(candidate);
        for (const match of expandGlob(candidate, cwd)) {
          const file = await inspectFile(path.resolve(cwd, match), config);
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
          sumLines += file.lines;
          sumBytes += file.bytes;
          count += 1;
        }
      }
      if (sumLines > config.minLines || sumBytes > config.maxBytes) {
        const description = pattern
          ? `${pattern} (${count} files, ${sumLines} lines together)`
          : `${names.join(", ")} together (${sumLines} lines)`;
        return { allow: false, path: path.resolve(cwd), bytes: sumBytes, lines: sumLines, command: commandName, kind: "sum", description };
      }
    }
  }
  return { allow: true };
}
