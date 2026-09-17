import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const json = value => JSON.stringify(value, null, 2) + '\n';
const hosts = ['cursor', 'copilot', 'claude'];
const runtimeFiles = ['hook.sh', 'shell-paths.awk', 'bootstrap-jq.sh', 'lib.sh', 'telemetry.sh', 'stats.sh'];

export async function pluginFiles(root = repo) {
  const files = new Map();
  const version = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
  const license = await fs.readFile(path.join(root, 'LICENSE'), 'utf8');

  for (const host of hosts) {
    const prefix = `plugins/${host}`;
    const put = (name, contents) => files.set(`${prefix}/${name}`, contents);
    const manifest = { name: 'prompt-sift', version,
      description: 'Save primary context with native model-pinned subagents and bounded-read hooks.',
      author: { name: 'Victor Carvalho Tavernari' }, license: 'MIT',
      repository: 'https://github.com/Tavernari/prompt-sift', agents: './agents/', skills: './skills/', hooks: './hooks/hooks.json' };
    // Claude auto-discovers these directories; explicitly listing the default hooks duplicates loading.
    if (host === 'claude') { delete manifest.agents; delete manifest.hooks; delete manifest.skills; }
    const manifestPath = host === 'cursor' ? '.cursor-plugin/plugin.json'
      : host === 'copilot' ? '.github/plugin/plugin.json' : '.claude-plugin/plugin.json';
    put(manifestPath, json(manifest));

    put('LICENSE', license);
    for (const name of runtimeFiles) put(`runtime/${name}`, await fs.readFile(path.join(root, 'scripts/plugin', name), 'utf8'));
    for (const role of ['primary', 'worker', 'writer']) {
      put(`agents/prompt-sift-${host}-${role}${host === 'copilot' ? '.agent' : ''}.md`,
        await fs.readFile(path.join(root, 'templates/agents', `${host}-${role}.md`), 'utf8'));
    }
    for (const skill of ['bulk-reader', 'code-writer', 'context-stats']) {
      put(`skills/${skill}/SKILL.md`, (await fs.readFile(path.join(root, 'templates/skills', skill, 'SKILL.md'), 'utf8')).replaceAll('{{HOST}}', host));
    }
    put('skills/code-writer/scripts/write-file.sh', await fs.readFile(path.join(root, 'templates/skills/code-writer/scripts/write-file.sh'), 'utf8'));
    const rootVariable = host === 'cursor' ? 'CURSOR_PLUGIN_ROOT' : host === 'copilot' ? 'PLUGIN_ROOT' : 'CLAUDE_PLUGIN_ROOT';
    const script = '${' + rootVariable + '}/runtime/hook.sh';
    const neutral = host === 'cursor' ? '{"permission":"allow"}'
      : host === 'copilot' ? '{"permissionDecision":"allow"}' : '{}';
    // printf is a shell builtin: even a missing script cannot turn an optional hook into a denial.
    const fallback = `printf '%s\\n' '${neutral}'`;
    const command = `/bin/sh "${script}" ${host} || ${fallback}`;
    // The ledger hook answers {} on every host; a failure of any kind must look like silence, never a decision.
    const ledger = `/bin/sh "\${${rootVariable}}/runtime/telemetry.sh" ${host} || printf '%s\\n' '{}'`;
    let hooks;
    if (host === 'claude') {
      hooks = { hooks: {
        PreToolUse: [{ matcher: 'Read|Bash|Grep', hooks: [{ type: 'command', command, timeout: 20 }] }],
        PostToolUse: [{ hooks: [{ type: 'command', command: ledger, timeout: 20 }] }]
      } };
    } else if (host === 'cursor') {
      hooks = { version: 1, hooks: {
        preToolUse: [{ command, matcher: 'Read|Shell|Grep', timeout: 20, failClosed: false }],
        postToolUse: [{ command: ledger, timeout: 20 }]
      } };
      put('rules/routing.mdc', '---\ndescription: Route context-heavy work to PromptSift native agents\nalwaysApply: true\n---\nUse the installed prompt-sift worker for bounded file orientation, returning a concise summary with source references. Use the code-writer skill and writer for predictable generation from an existing reference, and the primary specialist for complex reasoning and final diff review. Match the agent definitions by name in the host tool list; do not call an external CLI or API. Edits stay in the parent: never delegate an in-place change to the worker (read-only, must refuse) or the writer (whole files only); make surgical edits yourself with the edit tool after a targeted read. Respect hooks and never delegate recursively.\n');
    } else {
      hooks = { version: 1, hooks: {
        preToolUse: [{ type: 'command', bash: command, matcher: 'view|bash|grep', timeoutSec: 20 }],
        postToolUse: [{ type: 'command', bash: ledger, timeoutSec: 20 }]
      } };
    }
    put('hooks/hooks.json', json(hooks));
    put('README.md', `# PromptSift for ${host}\n\nInstall this bundle using your host's plugin manager. It includes model-pinned native agents and the hook runtime. No npm install, init command, extra API key, or project writes are needed.\n\nThe host discovers agents and the bulk-reader and code-writer skills automatically. Use the worker for file orientation the writer for reference-based generation, and the primary specialist for complex reasoning and final review. The host may prefix agent names with the plugin name; select the corresponding discovered agent.\n\nHooks target macOS and Linux, using /bin/sh, jq, awk and standard system utilities. Node.js is not used. If jq is missing, the hook automatically downloads jq 1.8.2 for macOS/Linux x64 or ARM64 to a user cache and verifies its pinned SHA-256 before execution. No sudo or package manager is used. A network or integrity failure leaves native agents active and reports that read enforcement is inactive. Set PROMPT_SIFT_AUTO_INSTALL=0 to disable downloads. Host permissions and model availability still apply.\n\nThis directory is self-contained and may be copied into a plugin cache without the rest of the repository.\n`);
    const marketplace = { name: 'prompt-sift', owner: { name: 'Victor Carvalho Tavernari' }, plugins: [
      { name: 'prompt-sift', source: `./plugins/${host}`, version, description: manifest.description }
    ] };
    const catalog = host === 'cursor' ? '.cursor-plugin/marketplace.json'
      : host === 'copilot' ? '.github/plugin/marketplace.json' : '.claude-plugin/marketplace.json';
    files.set(catalog, json(marketplace));
  }
  return files;
}

async function main() {
  const check = process.argv.includes('--check');
  const files = await pluginFiles();
  // Remove only files in the generated runtime directories that are no longer bundled.
  for (const host of hosts) {
    const dir = path.join(repo, 'plugins', host, 'runtime');
    for (const entry of await fs.readdir(dir).catch(() => [])) {
      if (runtimeFiles.includes(entry)) continue;
      if (check) throw new Error(`Obsolete plugin runtime: ${dir}/${entry}`);
      await fs.rm(path.join(dir, entry), { recursive: true, force: true });
    }
  }
  for (const [name, content] of files) {
    const target = path.join(repo, name);
    if (check) {
      const actual = await fs.readFile(target, 'utf8').catch(() => null);
      if (actual !== content) throw new Error(`${name} is stale; run npm run build:plugins`);
    } else {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content);
    }
  }
  console.log(`${check ? 'Verified' : 'Generated'} ${files.size} plugin files.`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
