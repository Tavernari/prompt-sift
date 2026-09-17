import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const runtime = path.resolve(import.meta.dirname, '../scripts/plugin');

// Cursor's readonly stops the edit tools, not the shell: a live worker wrote "Applying edits via
// shell since file edit tools are blocked". Where the host tells the hook who is calling — Cursor
// through subagentStart ids, Claude Code through agent_type — a worker's shell is read-only too.
test('a registered worker may search and read in the shell but never write, on Cursor and Claude Code', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sift worker '));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const ledger = path.join(root, 'cache', 'metrics.jsonl');
  const env = { ...process.env, XDG_CACHE_HOME: path.join(root, 'cache'), PROMPT_SIFT_METRICS_FILE: ledger };
  await fs.writeFile(path.join(root, 'small.swift'), 'let x = 1\n');
  const run = (script, host, payload) => {
    const result = spawnSync('/bin/sh', [path.join(runtime, script), host], {
      cwd: root, input: JSON.stringify({ cwd: root, ...payload }), encoding: 'utf8', env
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const decision = value => value.permission ?? value.hookSpecificOutput?.permissionDecision;
  const reason = value => value.agent_message ?? value.hookSpecificOutput?.permissionDecisionReason ?? '';

  // subagentStart registers only PromptSift workers; other subagents are not the hook's business.
  assert.deepEqual(run('subagent.sh', 'cursor', { subagent_id: 'sub-worker', subagent_type: 'prompt-sift-cursor-worker', parent_conversation_id: 'parent' }), {});
  assert.deepEqual(run('subagent.sh', 'cursor', { subagent_id: 'sub-worker-prefixed', subagent_type: 'prompt-sift:prompt-sift-cursor-worker', parent_conversation_id: 'parent' }), {});
  assert.deepEqual(run('subagent.sh', 'cursor', { subagent_id: 'sub-explore', subagent_type: 'explore', parent_conversation_id: 'parent' }), {});
  assert.deepEqual(run('subagent.sh', 'cursor', { subagent_id: 'sub-writer', subagent_type: 'prompt-sift-cursor-writer', parent_conversation_id: 'parent' }), {});

  const cursor = (conversation_id, command) => run('hook.sh', 'cursor', { conversation_id, tool_name: 'Shell', tool_input: { command } });
  const writes = [
    "cat > small.swift <<'EOF'\nlet x = 2\nEOF", 'cat small.swift > copy.swift', 'echo hi >> small.swift',
    'sed -i "s/1/2/" small.swift', "sed -i '' 's/1/2/' small.swift", 'tee small.swift < /dev/null',
    'patch -p1 < fix.diff', 'git apply fix.diff', 'git commit -am x', 'git checkout -- small.swift', 'git branch -D topic',
    'mv small.swift big.swift', 'rm small.swift', 'touch new.swift', 'mkdir Sources', 'swift test', 'npm install', 'python3 -c "open(\'x\',\'w\')"',
    'grep -rl TODO . | xargs sed -i "s/TODO/DONE/"', 'ls; rm -rf build'
  ];
  const reads = [
    'grep -n "func " small.swift', 'rg --files-with-matches TODO Sources', 'cat small.swift', 'head -n 50 small.swift | grep let',
    'git status', 'git log --oneline -5', 'git diff --stat', 'git show HEAD:small.swift | head -20', 'git branch --show-current', 'git blame small.swift',
    'find . -name "*.swift" | xargs grep -l Test', 'ls -la Sources', 'wc -l small.swift', 'cat small.swift 2>/dev/null', 'cat small.swift > /dev/null', 'sed -n 1,40p small.swift'
  ];
  for (const id of ['sub-worker', 'sub-worker-prefixed']) {
    for (const command of writes) {
      const verdict = cursor(id, command);
      assert.equal(decision(verdict), 'deny', `${id}: ${command}`);
      assert.match(reason(verdict), /read-only.*worker|worker.*read-only/i, command);
      assert.match(reason(verdict), /parent/, command);
    }
    for (const command of reads) assert.equal(decision(cursor(id, command)), 'allow', `${id}: ${command}`);
  }
  // Anything the tokenizer cannot parse fails open, like everywhere else in the hook.
  assert.equal(decision(cursor('sub-worker', "cat 'unterminated > small.swift")), 'allow');
  // Non-workers keep the ordinary policy: small files, writes included, are none of the hook's business.
  for (const id of ['parent', 'sub-explore', 'sub-writer', undefined]) {
    assert.equal(decision(cursor(id, 'cat small.swift > copy.swift')), 'allow', String(id));
  }

  const claude = (agent_type, command) => run('hook.sh', 'claude', { agent_type, tool_name: 'Bash', tool_input: { command } });
  for (const type of ['prompt-sift-claude-worker', 'prompt-sift:prompt-sift-claude-worker']) {
    assert.equal(decision(claude(type, 'sed -i "s/1/2/" small.swift')), 'deny', type);
    assert.equal(decision(claude(type, 'grep -n x small.swift')), undefined, type);
  }
  assert.equal(decision(claude('prompt-sift-claude-writer', 'sed -i "s/1/2/" small.swift')), undefined);
  assert.equal(decision(claude(undefined, 'sed -i "s/1/2/" small.swift')), undefined);

  // Copilot gives the hook no caller identity: a worker there is protected by its tools list only.
  const copilot = spawnSync('/bin/sh', [path.join(runtime, 'hook.sh'), 'copilot'], {
    cwd: root, input: JSON.stringify({ cwd: root, toolName: 'bash', toolArgs: { command: 'sed -i "s/1/2/" small.swift' } }), encoding: 'utf8', env
  });
  assert.equal(JSON.parse(copilot.stdout).permissionDecision, 'allow');

  // The ledger sees refusals as their own event, with the subagent registrations beside them.
  const rows = (await fs.readFile(ledger, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(rows.filter(row => row.event === 'subagent').length, 2, 'only worker registrations are recorded');
  assert.ok(rows.filter(row => row.event === 'refuse' && row.tool === 'shell').length >= writes.length);
  assert.ok(rows.every(row => !JSON.stringify(row).includes('small.swift')), 'no paths in the ledger');
});
