import fs from "node:fs/promises";
import path from "node:path";
import { probe } from "../providers/openai-compatible.js";

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function doctorCommand(config, cwd = process.cwd()) {
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0], 10);
  const checks = [
    { name: "Node.js >= 22", ok: nodeMajor >= 22, detail: process.versions.node },
    { name: "Configuration", ok: await exists(config.configPath), detail: config.configPath },
    {
      name: "Cursor hook",
      ok: await exists(path.join(cwd, ".cursor", "hooks.json")),
      detail: ".cursor/hooks.json"
    },
    {
      name: "Copilot hook",
      ok: await exists(path.join(cwd, ".github", "hooks", "prompt-sift.json")),
      detail: ".github/hooks/prompt-sift.json"
    },
    {
      name: "Hook runner",
      ok: await exists(path.join(cwd, ".prompt-sift", "run-hook.cjs")),
      detail: ".prompt-sift/run-hook.cjs"
    }
  ];
  if (await exists(path.join(cwd, ".claude", "settings.json"))) {
    checks.push({ name: "Claude Code hook", ok: true, detail: ".claude/settings.json" });
  }
  for (const [host, dir, suffix] of [["cursor", ".cursor/agents", ".md"],
    ["copilot", ".github/agents", ".agent.md"], ["claude", ".claude/agents", ".md"]]) {
    if (!await exists(path.join(cwd, dir))) continue;
    for (const role of ["primary", "worker"]) {
      const file = path.join(dir, `prompt-sift-${host}-${role}${suffix}`);
      checks.push({ name: `${host} ${role} agent`, ok: await exists(path.join(cwd, file)), detail: file });
    }
  }
  if (config.provider.baseUrl === "https://api.openai.com/v1" && !process.env[config.provider.apiKeyEnv]) {
    checks.push({ name: "External API worker (optional)", ok: true,
      detail: "Not probed: no API key. Native subagents use host authentication; model access must be checked in the host." });
  } else {
    const provider = await probe(config);
    checks.push({
      name: "Worker endpoint",
      ok: provider.ok,
      detail: provider.ok ? `${config.provider.baseUrl} (${provider.status})` : provider.error ?? `HTTP ${provider.status}`
    });
  }
  return checks;
}
