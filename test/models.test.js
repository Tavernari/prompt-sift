import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { loadConfig, DEFAULT_CONFIG } from '../src/config.js';
import { installCommand } from '../src/commands/install.js';
import { chat } from '../src/providers/openai-compatible.js';
import { evaluateHook } from '../src/core/hook.js';

test('installer creates native model contracts for all hosts and preserves custom agents', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sift-models-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await installCommand({ directory: root, hosts: ['all'] });
  const read = name => fs.readFile(path.join(root, name), 'utf8');
  assert.match(await read('.cursor/agents/prompt-sift-cursor-primary.md'), /gpt-5.6-sol\[effort=high\]/);
  assert.match(await read('.cursor/agents/prompt-sift-cursor-worker.md'), /gpt-5.6-luna\[effort=xhigh\]/);
  assert.match(await read('.github/agents/prompt-sift-copilot-primary.agent.md'), /model: gpt-5.6-sol\nreasoningEffort: high/);
  assert.match(await read('.github/agents/prompt-sift-copilot-worker.agent.md'), /model: gpt-5.6-luna\nreasoningEffort: xhigh\nmodelPolicy: required/);
  assert.match(await read('.claude/agents/prompt-sift-claude-primary.md'), /model: opus/);
  assert.match(await read('.claude/agents/prompt-sift-claude-worker.md'), /model: sonnet/);
  for (const [host, directory] of [['cursor', '.cursor'], ['copilot', '.github'], ['claude', '.claude']]) {
    const skill = await read(`${directory}/skills/code-writer/SKILL.md`);
    assert.ok(skill.includes(`prompt-sift-${host}-writer`));
    const helper = path.join(root, directory, 'skills/code-writer/scripts/write-file.sh');
    const reference = path.join(root, `${host}-reference.js`);
    await fs.writeFile(reference, 'reference');
    const generated = path.join(root, `${host}-generated.js`);
    const result = spawnSync('/bin/sh', [helper, '--reference', reference, '--target', generated], { input: 'generated', encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await fs.readFile(generated, 'utf8'), 'generated');
  }
  const settings = JSON.parse(await read('.claude/settings.json'));
  assert.equal(settings.model, 'opus');
  assert.equal(settings.hooks.PreToolUse[0].hooks[0].command, 'node .prompt-sift/run-hook.cjs claude');
  await fs.writeFile(path.join(root, '.claude/agents/prompt-sift-claude-worker.md'), 'custom');
  await installCommand({ directory: root, hosts: ['all'] });
  assert.equal(await read('.claude/agents/prompt-sift-claude-worker.md'), 'custom');
  assert.equal(JSON.parse(await read('.claude/settings.json')).hooks.PreToolUse.length, 1);

  const source = path.join(root, 'large.js');
  await fs.writeFile(source, 'code\n'.repeat(500));
  const config = await loadConfig(root);
  const payload = { cwd: root, tool_name: 'Read', tool_input: { file_path: source } };
  const denied = await evaluateHook('claude', payload, config);
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /prompt-sift-claude-worker/);
  assert.deepEqual(await evaluateHook('claude', { ...payload, tool_input: { file_path: source, limit: 100 } }, config), {});
  const run = spawnSync(process.execPath, [path.join(root, '.prompt-sift/run-hook.cjs'), 'claude'], {
    cwd: root, input: JSON.stringify(payload), encoding: 'utf8',
    env: { ...process.env, PROMPT_SIFT_BIN: path.resolve('bin/prompt-sift.js') }
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).hookSpecificOutput.permissionDecision, 'deny');
});

test('defaults select Luna xhigh while legacy provider settings retain temperature', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sift-config-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = await loadConfig(root);
  assert.equal(config.provider.model, 'gpt-5.6-luna');
  assert.equal(config.provider.reasoningEffort, 'xhigh');
  await fs.writeFile(path.join(root, '.prompt-sift.json'), JSON.stringify({ provider: {
    model: 'qwen2.5-coder:3b', baseUrl: 'http://localhost:11434/v1', temperature: 0.2, apiKeyEnv: 'PROMPT_SIFT_API_KEY'
  } }));
  const legacy = await loadConfig(root);
  assert.equal(legacy.provider.reasoningEffort, null);
  assert.equal(legacy.provider.temperature, 0.2);
  await fs.writeFile(path.join(root, '.prompt-sift.json'), JSON.stringify({ provider: { reasoningEffort: 'typo' } }));
  await assert.rejects(loadConfig(root), /Invalid provider.reasoningEffort/);
});

test('OpenAI request sends reasoning effort without incompatible temperature', async t => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: 'summary' } }] }));
  });
  await chat({ ...DEFAULT_CONFIG, provider: { ...DEFAULT_CONFIG.provider, temperature: 0.2 } }, { system: 'summarize', user: 'source' });
  assert.equal(requests[0].model, 'gpt-5.6-luna');
  assert.equal(requests[0].reasoning_effort, 'xhigh');
  assert.equal('temperature' in requests[0], false);
  await chat({ ...DEFAULT_CONFIG, provider: { model: 'local', baseUrl: 'http://localhost/v1', temperature: 0.2 } }, { system: 'summarize', user: 'source' });
  assert.equal('reasoning_effort' in requests[1], false);
  assert.equal(requests[1].temperature, 0.2);
});
