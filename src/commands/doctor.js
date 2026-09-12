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
    { name: "Node.js >= 20", ok: nodeMajor >= 20, detail: process.versions.node },
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
  const provider = await probe(config);
  checks.push({
    name: "Worker endpoint",
    ok: provider.ok,
    detail: provider.ok ? `${config.provider.baseUrl} (${provider.status})` : provider.error ?? `HTTP ${provider.status}`
  });
  return checks;
}
