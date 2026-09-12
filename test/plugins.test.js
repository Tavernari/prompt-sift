import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { pluginFiles } from '../scripts/build-plugins.js';

const root = path.resolve(import.meta.dirname, '..');
const readJson = async name => JSON.parse(await fs.readFile(name, 'utf8'));

for (const host of ['cursor', 'copilot', 'claude']) {
  test(`${host} plugin works from an isolated cache without npm or project config`, async t => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'sift plugin '));
    t.after(() => fs.rm(temp, { recursive: true, force: true }));
    const cache = path.join(temp, 'plugin cache');
    const project = path.join(temp, 'consumer project');
    await fs.cp(path.join(root, 'plugins', host), cache, { recursive: true });
    await fs.mkdir(project);
    await fs.writeFile(path.join(project, 'large file.js'), 'const x = 1;\n'.repeat(500));
    const before = await fs.readdir(project);
    const hooks = await readJson(path.join(cache, 'hooks/hooks.json'));
    const hook = host === 'claude' ? hooks.hooks.PreToolUse[0].hooks[0] : hooks.hooks.preToolUse[0];
    const variable = host === 'cursor' ? 'CURSOR_PLUGIN_ROOT' : host === 'copilot' ? 'PLUGIN_ROOT' : 'CLAUDE_PLUGIN_ROOT';
    const payload = host === 'copilot'
      ? { cwd: project, toolName: 'view', toolArgs: { path: 'large file.js' } }
      : { cwd: project, tool_name: 'Read', tool_input: { file_path: 'large file.js' } };
    const resultOf = result => {
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout);
    };
    const decision = value => value.permission ?? value.permissionDecision ?? value.hookSpecificOutput?.permissionDecision;
    const run = (input, environment = {}, commandOverride) => {
      const env = { ...process.env, ...environment, [variable]: cache };
      delete env.OPENAI_API_KEY;
      delete env.PROMPT_SIFT_BIN;
      // Model plugin-root substitution is performed by the real host before spawning.
      const command = (commandOverride ?? hook.bash ?? hook.command).replaceAll('${' + variable + '}', cache);
      return spawnSync('/bin/sh', ['-c', command], { cwd: cache, input, encoding: 'utf8', env });
    };
    const denied = resultOf(run(JSON.stringify(payload)));
    assert.equal(decision(denied), 'deny');
    assert.match(JSON.stringify(denied), /prompt-sift.*worker/);
    assert.doesNotMatch(JSON.stringify(denied), /prompt-sift read/);
    const args = host === 'copilot' ? payload.toolArgs : payload.tool_input;
    if (host === 'copilot') {
      args.view_range = [1, 100];
      const serialized = { ...payload, toolArgs: JSON.stringify(args) };
      assert.equal(decision(resultOf(run(JSON.stringify(serialized)))), 'allow');
      for (const range of [[1, -1], [1, 500], [100, 1]]) {
        assert.equal(decision(resultOf(run(JSON.stringify({ ...payload, toolArgs: { ...args, view_range: range } })))), 'deny');
      }
    } else args.limit = 100;
    const allowed = resultOf(run(JSON.stringify(payload)));
    assert.equal(decision(allowed), host === 'claude' ? undefined : 'allow');
    const malformed = resultOf(run('invalid JSON'));
    assert.equal(decision(malformed), host === 'claude' ? undefined : 'allow');
    const noJq = run(JSON.stringify(payload), { PATH: '/nonexistent' });
    assert.equal(decision(resultOf(noJq)), host === 'claude' ? undefined : 'allow');
    assert.match(noJq.stderr, /unavailable/);
    const bin = path.join(temp, 'only shell utilities');
    await fs.mkdir(bin);
    for (const utility of ['jq', 'awk', 'wc', 'head', 'dirname']) {
      const executable = spawnSync('/bin/sh', ['-c', `command -v ${utility}`], { encoding: 'utf8' }).stdout.trim();
      await fs.symlink(executable, path.join(bin, utility));
    }
    assert.equal(decision(resultOf(run(JSON.stringify({ ...payload,
      ...(host === 'copilot' ? { toolArgs: { path: 'large file.js' } } : { tool_input: { file_path: 'large file.js' } })
    }), { PATH: bin }))), 'deny');
    await fs.writeFile(path.join(project, '.prompt-sift.json'), 'invalid');
    assert.equal(decision(resultOf(run(JSON.stringify(payload)))), host === 'claude' ? undefined : 'allow');
    await fs.unlink(path.join(project, '.prompt-sift.json'));
    // A missing packaged import must not turn a preToolUse hook into a deny.
    await fs.unlink(path.join(cache, 'runtime/hook.sh'));
    assert.equal(decision(resultOf(run(JSON.stringify(payload)))), host === 'claude' ? undefined : 'allow');
    assert.deepEqual(await fs.readdir(project), before);
    assert.equal(await fs.access(path.join(cache, 'node_modules')).then(() => true, () => false), false);
  });
}

test('marketplaces resolve self-contained bundles with native model contracts', async () => {
  for (const [host, catalog, manifest] of [
    ['cursor', '.cursor-plugin/marketplace.json', '.cursor-plugin/plugin.json'],
    ['copilot', '.github/plugin/marketplace.json', '.github/plugin/plugin.json'],
    ['claude', '.claude-plugin/marketplace.json', '.claude-plugin/plugin.json']
  ]) {
    const market = await readJson(path.join(root, catalog));
    const pluginRoot = path.resolve(root, market.plugins[0].source);
    const plugin = await readJson(path.join(pluginRoot, manifest));
    assert.equal(plugin.name, market.plugins[0].name);
    assert.equal(plugin.version, market.plugins[0].version);
    assert.equal(plugin.license, 'MIT');
    assert.ok((await fs.readdir(path.join(pluginRoot, 'agents'))).length === 3);
    await fs.access(path.join(pluginRoot, plugin.hooks ?? 'hooks/hooks.json'));
    const suffix = host === 'copilot' ? '.agent.md' : '.md';
    for (const role of ['primary', 'worker', 'writer']) {
      const agent = await fs.readFile(path.join(pluginRoot, `agents/prompt-sift-${host}-${role}${suffix}`), 'utf8');
      assert.equal(agent, await fs.readFile(path.join(root, `templates/agents/${host}-${role}.md`), 'utf8'));
    }
  }
});

test('committed plugin runtimes stay in sync with tested source', async () => {
  for (const [name, expected] of await pluginFiles(root)) {
    assert.equal(await fs.readFile(path.join(root, name), 'utf8'), expected, name);
  }
});
