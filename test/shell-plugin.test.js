import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const runner = path.resolve(import.meta.dirname, '../scripts/plugin/hook.sh');
test('POSIX hooks preserve file and shell policies without evaluating input', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sift shell '));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'big file.txt'), 'line\n'.repeat(500));
  await fs.writeFile(path.join(root, 'minified.js'), 'x'.repeat(50001));
  await fs.writeFile(path.join(root, 'café "quoted".txt'), 'line\n'.repeat(500));
  await fs.writeFile(path.join(root, '$(touch INJECTED).txt'), 'line\n'.repeat(500));
  const run = (args, tool = 'Read', env = {}) => {
    const result = spawnSync('/bin/sh', [runner, 'cursor'], {
      cwd: root, input: JSON.stringify({ cwd: root, tool_name: tool, tool_input: args }),
      encoding: 'utf8', env: { ...process.env, ...env }
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout).permission;
  };
  for (const file of ['big file.txt', 'minified.js', 'café "quoted".txt', '$(touch INJECTED).txt']) {
    assert.equal(run({ file_path: file }), 'deny', file);
  }
  assert.equal(run({ file_path: 'big file.txt', limit: 100 }), 'allow');
  assert.equal(run({ file_path: 'missing' }), 'allow');
  for (const command of [
    "cd . && cat 'big file.txt'", "  cat 'big file.txt'", "cat big\\ file.txt",
    "head -n 500 'big file.txt'", "tail -n +1 'big file.txt'", "head -n -100 'big file.txt'",
    "cat 'big file.txt' 2> errors.txt", "cat '$(touch INJECTED).txt'",
    "cat missing; cat 'big file.txt'", "cat missing\ncat 'big file.txt'", "head -c 50001 minified.js"
  ]) assert.equal(run({ command }, 'Shell'), 'deny', command);
  for (const command of [
    "head -100 'big file.txt'", "head -n100 'big file.txt'", "head -c 100 'big file.txt'",
    "cat 'big file.txt' | grep needle", "cat 'big file.txt' > copy.txt", "cat 'big file.txt' &> copy.txt",
    "cat missing", "echo 'cat big file.txt'", "cat 'unterminated"
  ]) assert.equal(run({ command }, 'Shell'), 'allow', command);
  assert.equal(await fs.access(path.join(root, 'INJECTED')).then(() => true, () => false), false);
  await fs.writeFile(path.join(root, '.prompt-sift.json'), JSON.stringify({ minLines: 600, maxBytes: 60000 }));
  assert.equal(run({ file_path: 'big file.txt' }), 'allow');
  assert.equal(run({ file_path: 'minified.js' }), 'allow');
  assert.equal(run({ file_path: 'big file.txt' }, 'Read', { PROMPT_SIFT_MIN_LINES: '400' }), 'deny');
  assert.equal(run({ file_path: 'minified.js' }, 'Read', { PROMPT_SIFT_MAX_BYTES: '100' }), 'deny');
  assert.equal(run({ file_path: 'big file.txt' }, 'Read', { PROMPT_SIFT_MIN_LINES: 'invalid' }), 'allow');
});

test('binary files are never gated: the worker cannot summarise an image and the host renders it itself', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sift binary '));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  // A PNG-shaped payload well above maxBytes: NUL bytes in the header, no newlines at all.
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]), Buffer.alloc(70000, 0xab)]);
  await fs.writeFile(path.join(root, 'screenshot.png'), png);
  await fs.writeFile(path.join(root, 'big.txt'), 'line\n'.repeat(500));
  const run = (tool, args) => {
    const result = spawnSync('/bin/sh', [runner, 'claude'], {
      cwd: root, input: JSON.stringify({ cwd: root, tool_name: tool, tool_input: args }), encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout).hookSpecificOutput?.permissionDecision ?? 'allow';
  };
  assert.equal(run('Read', { file_path: 'screenshot.png' }), 'allow');
  assert.equal(run('Bash', { command: 'cat screenshot.png' }), 'allow');
  // The text gate itself is untouched.
  assert.equal(run('Read', { file_path: 'big.txt' }), 'deny');
});

test('an unbounded content search of one large file is a read in disguise; searches the host caps pass', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sift grep '));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'Big.swift'), 'func a() {}\n'.repeat(500));
  await fs.writeFile(path.join(root, 'small.swift'), 'func a() {}\n'.repeat(20));
  await fs.mkdir(path.join(root, 'Sources'));
  const run = (host, tool, args) => {
    const result = spawnSync('/bin/sh', [runner, host], {
      cwd: root, input: JSON.stringify({ cwd: root, tool_name: tool, tool_input: args }), encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
    const out = JSON.parse(result.stdout);
    return out.permission ?? out.permissionDecision ?? out.hookSpecificOutput?.permissionDecision ?? 'allow';
  };
  for (const host of ['cursor', 'copilot', 'claude']) {
    const pattern = '@Suite|@Test|func |private';
    // Explicit content mode over one large file without a bound: denied everywhere, with the read message.
    assert.equal(run(host, 'Grep', { pattern, path: 'Big.swift', output_mode: 'content' }), 'deny', host);
    assert.equal(run(host, 'Grep', { pattern, path: 'Big.swift', output_mode: 'content', head_limit: 100 }), 'allow', host);
    assert.equal(run(host, 'Grep', { pattern, path: 'Big.swift', output_mode: 'content', head_limit: 400 }), 'deny', host);
    assert.equal(run(host, 'Grep', { pattern, path: 'Big.swift', output_mode: 'files_with_matches' }), 'allow', host);
    assert.equal(run(host, 'Grep', { pattern, path: 'Big.swift', output_mode: 'count' }), 'allow', host);
    assert.equal(run(host, 'Grep', { pattern, path: 'small.swift', output_mode: 'content' }), 'allow', host);
    // Directories and missing paths are the host's own cap to enforce; the hook cannot measure them.
    assert.equal(run(host, 'Grep', { pattern, path: 'Sources', output_mode: 'content' }), 'allow', host);
    assert.equal(run(host, 'Grep', { pattern, output_mode: 'content' }), 'allow', host);
    assert.equal(run(host, 'Grep', { pattern, path: 'missing.swift', output_mode: 'content' }), 'allow', host);
    // Unknown argument shapes fail open.
    assert.equal(run(host, 'Grep', { query: pattern, target: 'Big.swift' }), 'allow', host);
  }
  // Claude Code defaults output_mode to files_with_matches; Cursor and Copilot default to content.
  assert.equal(run('claude', 'Grep', { pattern: 'func', path: 'Big.swift' }), 'allow');
  assert.equal(run('cursor', 'Grep', { pattern: 'func', path: 'Big.swift' }), 'deny');
  assert.equal(run('copilot', 'grep', { pattern: 'func', path: 'Big.swift' }), 'deny');
  // head_limit 0 means unlimited on Claude Code, even over a directory.
  assert.equal(run('claude', 'Grep', { pattern: 'func', path: 'Sources', output_mode: 'content', head_limit: 0 }), 'deny');
  assert.equal(run('claude', 'Grep', { pattern: 'func', output_mode: 'content', head_limit: 0 }), 'deny');
  const denied = spawnSync('/bin/sh', [runner, 'claude'], {
    cwd: root, input: JSON.stringify({ cwd: root, tool_name: 'Grep', tool_input: { pattern: 'func', path: 'Big.swift', output_mode: 'content' } }), encoding: 'utf8'
  });
  assert.match(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecisionReason, /search of Big\.swift.*head_limit.*350/);
});
