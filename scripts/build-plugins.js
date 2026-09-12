import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const json = value => JSON.stringify(value, null, 2) + '\n';
const hosts = ['cursor', 'copilot', 'claude'];
const runtimeFiles = ['config.js', 'core/hook.js', 'core/policy.js', 'core/shell.js', 'core/files.js'];

export async function pluginFiles(root = repo) {
  const files = new Map();
  const version = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
  const license = await fs.readFile(path.join(root, 'LICENSE'), 'utf8');
  const runner = await fs.readFile(path.join(root, 'scripts/plugin/hook.cjs'), 'utf8');
  for (const host of hosts) {
    const prefix = `plugins/${host}`;
    const put = (name, contents) => files.set(`${prefix}/${name}`, contents);
    const manifest = { name: 'prompt-sift', version,
      description: 'Save primary context with native model-pinned subagents and bounded-read hooks.',
      author: { name: 'Victor Carvalho Tavernari' }, license: 'MIT',
      repository: 'https://github.com/Tavernari/prompt-sift', agents: './agents/', hooks: './hooks/hooks.json' };
    // Claude auto-discovers these directories; explicitly listing the default hooks duplicates loading.
    if (host === 'claude') { delete manifest.agents; delete manifest.hooks; }
    const manifestPath = host === 'cursor' ? '.cursor-plugin/plugin.json'
      : host === 'copilot' ? '.github/plugin/plugin.json' : '.claude-plugin/plugin.json';
    put(manifestPath, json(manifest));
    put('runtime/package.json', json({ private: true, type: 'module' }));
    put('runtime/hook.cjs', runner);
    put('LICENSE', license);
    for (const name of runtimeFiles) put(`runtime/src/${name}`, await fs.readFile(path.join(root, 'src', name), 'utf8'));
    for (const role of ['primary', 'worker']) {
      put(`agents/prompt-sift-${host}-${role}${host === 'copilot' ? '.agent' : ''}.md`,
        await fs.readFile(path.join(root, 'templates/agents', `${host}-${role}.md`), 'utf8'));
    }
    const rootVariable = host === 'cursor' ? 'CURSOR_PLUGIN_ROOT' : host === 'copilot' ? 'PLUGIN_ROOT' : 'CLAUDE_PLUGIN_ROOT';
    const script = '${' + rootVariable + '}/runtime/hook.cjs';
    const neutral = host === 'cursor' ? '{"permission":"allow"}'
      : host === 'copilot' ? '{"permissionDecision":"allow"}' : '{}';
    // printf is a shell builtin: even missing Node cannot turn an optional hook into a denial.
    const fallback = `printf '%s\\n' '${neutral}'`;
    const command = `if command -v node >/dev/null 2>&1; then node "${script}" ${host} || ${fallback}; else printf '%s\\n' 'PromptSift: Node unavailable; native agents remain active, read enforcement is inactive.' >&2; ${fallback}; fi`;
    let hooks;
    if (host === 'claude') {
      hooks = { hooks: { PreToolUse: [{ matcher: 'Read|Bash', hooks: [{ type: 'command', command, timeout: 5 }] }] } };
    } else if (host === 'cursor') {
      hooks = { version: 1, hooks: { preToolUse: [{ command, matcher: 'Read|Shell', timeout: 5, failClosed: false }] } };
      put('rules/routing.mdc', '---\ndescription: Route context-heavy work to PromptSift native agents\nalwaysApply: true\n---\nUse the installed prompt-sift worker for bounded file orientation, returning a concise summary with source references. Use the primary specialist for complex reasoning. Match the agent definitions by name in the host tool list; do not call an external CLI or API. Respect hooks and never delegate recursively.\n');
    } else {
      const powershell = `try { if (Get-Command node -ErrorAction SilentlyContinue) { & node "${script}" ${host}; if ($LASTEXITCODE -ne 0) { Write-Output '${neutral}' } } else { [Console]::Error.WriteLine('PromptSift: Node unavailable; native agents remain active, read enforcement is inactive.'); Write-Output '${neutral}' } } catch { Write-Output '${neutral}' }; exit 0`;
      hooks = { version: 1, hooks: { preToolUse: [{ type: 'command', bash: command, powershell, matcher: 'view|bash|powershell', timeoutSec: 5 }] } };
    }
    put('hooks/hooks.json', json(hooks));
    put('README.md', `# PromptSift for ${host}\n\nInstall this bundle using your host's plugin manager. It includes model-pinned native agents and the hook runtime. No npm install, init command, extra API key, project writes, or dependency download is performed.\n\nThe host discovers agents automatically. Use the worker for file orientation and the primary specialist for complex reasoning. The host may prefix agent names with the plugin name; select the corresponding discovered agent.\n\nCommand hooks use an existing Node.js runtime. Without it, native agents still work and the hook reports that automatic read enforcement is inactive. Host permissions and model availability still apply.\n\nThis directory is self-contained and may be copied into a plugin cache without the rest of the repository.\n`);
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
