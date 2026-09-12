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
