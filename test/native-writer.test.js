import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
for (const host of ['cursor', 'copilot', 'claude']) {
  test(`${host} native writer works from an isolated plugin with guarded output`, async t => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'sift writer '));
    t.after(() => fs.rm(temp, { recursive: true, force: true }));
    const cache = path.join(temp, 'plugin cache');
    const project = path.join(temp, 'project');
    await fs.cp(path.join(root, 'plugins', host), cache, { recursive: true });
    await fs.mkdir(project);
    await fs.writeFile(path.join(project, 'reference.js'), 'export const answer = 1;\n');
    const helper = path.join(cache, 'skills/code-writer/scripts/write-file.sh');
    // Only OS utilities are available: no Node, jq, network or API credentials.
    const bin = path.join(temp, 'bin');
    await fs.mkdir(bin);
    for (const utility of ['dirname', 'mktemp', 'cat', 'ln', 'mv', 'rm']) {
      const executable = spawnSync('/bin/sh', ['-c', `command -v ${utility}`], { encoding: 'utf8' }).stdout.trim();
      await fs.symlink(executable, path.join(bin, utility));
    }
    const code = 'export const text = "$(touch should-not-exist) `false`";\n';
    const run = (args, input = code) => spawnSync('/bin/sh', [helper, ...args], {
      cwd: project, input, encoding: 'utf8', env: { PATH: bin }
    });
    const args = ['--reference', 'reference.js', '--target', '-generated file.js'];
    assert.notEqual(run(['--target', 'missing.js']).status, 0);
    assert.notEqual(run(['--reference', 'absent', '--target', 'missing.js']).status, 0);
    assert.notEqual(run([...args, '--unknown']).status, 0);
    assert.notEqual(run(['--reference']).status, 0);
    assert.notEqual(run(args, '').status, 0);
    assert.deepEqual(await fs.readdir(project), ['reference.js']);
    const result = run(args);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await fs.readFile(path.join(project, '-generated file.js'), 'utf8'), code);
    assert.ok(result.stdout.length < 200);
    assert.notEqual(run(args, 'replacement').status, 0);
    assert.equal(await fs.readFile(path.join(project, '-generated file.js'), 'utf8'), code);
    assert.equal(run([...args, '--force'], 'replacement').status, 0);
    assert.equal(await fs.readFile(path.join(project, '-generated file.js'), 'utf8'), 'replacement');
    await fs.symlink('reference.js', path.join(project, 'link.js'));
    assert.notEqual(run(['--reference', 'reference.js', '--target', 'link.js', '--force']).status, 0);
    await fs.mkdir(path.join(project, 'directory'));
    assert.notEqual(run(['--reference', 'reference.js', '--target', 'directory', '--force']).status, 0);
    assert.notEqual(run(['--reference', 'reference.js', '--target', 'absent/out.js']).status, 0);
    assert.equal(await fs.readFile(path.join(project, 'reference.js'), 'utf8'), 'export const answer = 1;\n');
    assert.equal((await fs.readdir(project)).some(name => name.startsWith('.prompt-sift-write.')), false);
    assert.equal(await fs.access(path.join(project, 'should-not-exist')).then(() => true, () => false), false);
    for (const skill of ['bulk-reader', 'code-writer']) {
      const content = await fs.readFile(path.join(cache, 'skills', skill, 'SKILL.md'), 'utf8');
      assert.ok(content.includes(`prompt-sift-${host}-${skill === 'bulk-reader' ? 'worker' : 'writer'}`));
      assert.ok(!content.includes('{{HOST}}'));
    }
    const suffix = host === 'copilot' ? '.agent.md' : '.md';
    const agent = await fs.readFile(path.join(cache, `agents/prompt-sift-${host}-writer${suffix}`), 'utf8');
    if (host === 'cursor') {
      assert.match(agent, /model: "gpt-5.6-luna\[effort=xhigh\]"/);
      assert.match(agent, /readonly: false/);
    } else if (host === 'copilot') {
      assert.match(agent, /model: gpt-5.6-luna/);
      assert.match(agent, /reasoningEffort: xhigh/);
      assert.match(agent, /"execute"/);
    } else {
      assert.match(agent, /model: sonnet/);
      assert.match(agent, /effort: high/);
      assert.match(agent, /tools: .*Bash/);
    }
  });
}
