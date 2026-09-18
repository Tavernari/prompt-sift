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

// The recognizer knew cat/head/tail of one file. The context is lost elsewhere: several
// small files in one cat, a glob, git log -p, an unbounded git diff, find -exec cat.
test('shell dumpers: sums, globs, git history and diffs, find -exec cat', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sift dumpers '));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@a', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@a' } });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  await fs.mkdir(path.join(root, 'Sources'));
  await fs.mkdir(path.join(root, 'Generated'));
  for (const name of ['a', 'b', 'c']) await fs.writeFile(path.join(root, 'Sources', `${name}.swift`), 'let x = 1\n'.repeat(200));
  await fs.writeFile(path.join(root, 'small.swift'), 'let x = 1\n'.repeat(20));
  await fs.writeFile(path.join(root, 'Generated', 'big.swift'), 'let x = 1\n'.repeat(20));
  git('init', '-q'); git('add', '.'); git('commit', '-qm', 'base');
  await fs.writeFile(path.join(root, 'Generated', 'big.swift'), 'let x = 2\n'.repeat(500));
  git('commit', '-qam', 'big');
  await fs.writeFile(path.join(root, 'Generated', 'big.swift'), 'let x = 3\n'.repeat(600));
  await fs.writeFile(path.join(root, 'small.swift'), 'let x = 4\n'.repeat(20));
  const run = (command, host = 'cursor') => {
    const result = spawnSync('/bin/sh', [runner, host], {
      cwd: root, input: JSON.stringify({ cwd: root, tool_name: 'Shell', tool_input: { command } }), encoding: 'utf8', env: process.env
    });
    assert.equal(result.status, 0, result.stderr);
    const value = JSON.parse(result.stdout);
    return [value.permission, value.agent_message ?? ''];
  };
  const denied = {
    'cat Sources/a.swift Sources/b.swift Sources/c.swift': /Sources\/a\.swift.*together/,
    'cat Sources/*.swift': /Sources\/\*\.swift/,
    'git log -p': /git log -p/,
    'git log --patch --since=1.week': /git log/,
    'git log -p -- small.swift': /git log/,
    'git diff': /git diff.*1140 changed lines/,
    'git diff -- Generated/big.swift': /git diff.*Generated\/big\.swift.*1100 changed lines/,
    'git show HEAD': /git show.*520 changed lines/,
    'git show HEAD -- Generated/big.swift': /git show/,
    'git diff HEAD~1 HEAD': /git diff/,
    'find Sources -name "*.swift" -exec cat {} +': /find .* -exec cat/,
    "find . -name '*.swift' -exec cat {} \;": /find .* -exec cat/,
    'find Sources -type f | xargs cat': /xargs cat/,
    'ls Sources | xargs -I{} cat Sources/{}': /xargs/,
  };
  for (const [command, pattern] of Object.entries(denied)) {
    const [permission, message] = run(command);
    assert.equal(permission, 'deny', command);
    assert.match(message, pattern, command);
    assert.match(message, /worker/, command);
  }
  const allowed = [
    'cat Sources/a.swift Sources/b.swift Sources/c.swift | head -100', 'cat small.swift Sources/c.swift', 'cat "Sources/nothing*.swift"',
    'git log --oneline', 'git log -p -3', 'git log -p -n 2', 'git log --patch --max-count=1', 'git log -p | head -200', 'git log --stat',
    'git diff --stat', 'git diff --name-only', 'git diff -- small.swift', 'git diff -- Sources', 'git diff | head -100', 'git diff --numstat', 'git show --stat HEAD', 'git show HEAD -- small.swift',
    'git show HEAD:small.swift', 'git diff HEAD~1 HEAD --shortstat', 'git status',
    'find Sources -name "*.swift"', 'find Sources -name "*.swift" -exec grep -l x {} +', 'find Sources -name "*.swift" -exec cat {} + | head -50',
    'find Sources -type f | xargs grep -l x', 'find Sources -type f | xargs wc -l', 'echo Sources/*.swift'
  ];
  for (const command of allowed) assert.equal(run(command)[0], 'allow', command);
  // Outside a repository git cannot be measured, so it fails open; the history dump is unbounded regardless.
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'sift nogit '));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  const bare = command => JSON.parse(spawnSync('/bin/sh', [runner, 'cursor'], {
    cwd: outside, input: JSON.stringify({ cwd: outside, tool_name: 'Shell', tool_input: { command } }), encoding: 'utf8', env: process.env
  }).stdout).permission;
  assert.equal(bare('git diff'), 'allow');
  assert.equal(bare('git log -p'), 'deny');
  // The hook never runs the inspected command: measuring the diff must not touch the index.
  assert.equal(git('status', '--porcelain').includes('??'), false);
});

// macOS ships bash 3.2 as /bin/sh, and its parser rejects an unparenthesised `case` pattern
// inside `$( ... )` — a script that runs on every Linux shell can still fail to parse there.
// The runtime must parse under 3.2 itself; the check runs wherever Docker can supply that bash.
const bash32 = spawnSync('docker', ['image', 'inspect', 'bash:3.2'], { stdio: 'ignore' }).status === 0;
test('the plugin runtime parses under bash 3.2, the macOS /bin/sh', { skip: !bash32 && 'needs the bash:3.2 Docker image' }, () => {
  const dir = path.resolve(import.meta.dirname, '../scripts/plugin');
  const result = spawnSync('docker', ['run', '--rm', '-v', `${dir}:/p:ro`, 'bash:3.2', 'sh', '-c', 'for f in /p/*.sh; do bash -n "$f" || exit 1; done'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
