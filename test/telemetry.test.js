import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const runtime = path.resolve(import.meta.dirname, '../scripts/plugin');
const telemetry = path.join(runtime, 'telemetry.sh');
const stats = path.join(runtime, 'stats.sh');
const hook = path.join(runtime, 'hook.sh');

const run = (script, host, payload, env = {}, cwd = os.tmpdir()) => {
  const result = spawnSync('/bin/sh', [script, host], {
    cwd, input: typeof payload === 'string' ? payload : JSON.stringify(payload), encoding: 'utf8',
    env: { ...process.env, ...env }
  });
  assert.equal(result.status, 0, result.stderr);
  return result;
};
const rows = async file => (await fs.readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));

test('postToolUse telemetry records the bytes each host actually handed to the model', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sift telemetry '));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'metrics dir', 'metrics.jsonl');
  const env = { PROMPT_SIFT_METRICS_FILE: file };
  const big = 'x'.repeat(60000);
  // Cursor: tool_output is a JSON-stringified payload. Copilot: toolResult.textResultForLlm. Claude: tool_response object.
  const cursor = run(telemetry, 'cursor', { cwd: root, tool_name: 'Grep', tool_input: { pattern: 'x' }, tool_output: JSON.stringify({ matches: 'abc' }), duration: 12 }, env);
  assert.deepEqual(JSON.parse(cursor.stdout), {});
  const copilot = run(telemetry, 'copilot', { cwd: root, toolName: 'bash', toolArgs: { command: 'ls' }, toolResult: { resultType: 'success', textResultForLlm: 'héllo' } }, env);
  assert.deepEqual(JSON.parse(copilot.stdout), {});
  const claude = run(telemetry, 'claude', { cwd: root, tool_name: 'Read', tool_input: { file_path: '/p/big.txt' }, tool_response: { type: 'text', file: { content: big } }, duration_ms: 40 }, env);
  const mcp = run(telemetry, 'claude', { cwd: root, tool_name: 'mcp__atlassian__getJiraIssue', tool_input: { key: 'ATV-1' }, tool_response: [{ type: 'text', text: big }] }, env);
  // MCP results count too (a ticket, a page): the largest dumps in real sessions are often not file reads.
  assert.match(JSON.parse(mcp.stdout).hookSpecificOutput.additionalContext, /PromptSift: .*58\.6 KB/);
  const small = run(telemetry, 'claude', { cwd: root, tool_name: 'Edit', tool_input: {}, tool_response: { ok: true } }, env);
  assert.deepEqual(JSON.parse(small.stdout), {});

  const recorded = await rows(file);
  assert.equal(recorded.length, 5);
  assert.equal(recorded[0].host, 'cursor'); assert.equal(recorded[0].tool, 'grep'); assert.equal(recorded[0].bytes, JSON.stringify({ matches: 'abc' }).length);
  assert.equal(recorded[0].event, 'result'); assert.equal(recorded[0].cwd, root); assert.equal(recorded[0].ms, 12);
  assert.equal(recorded[1].tool, 'bash'); assert.equal(recorded[1].bytes, Buffer.byteLength('héllo'));
  assert.equal(recorded[2].tool, 'read'); assert.ok(recorded[2].bytes >= 60000); assert.equal(recorded[2].ms, 40);
  assert.equal(recorded[3].tool, 'mcp__atlassian__getjiraissue');
  for (const row of recorded) { assert.match(row.at, /^\d{4}-\d{2}-\d{2}T/); assert.equal(row.tokens, Math.ceil(row.bytes / 4)); }
  // Tool inputs and outputs are never copied into the metrics file: it is a ledger, not a transcript.
  assert.doesNotMatch(await fs.readFile(file, 'utf8'), /xxxxx|héllo|big\.txt/);

  // Over maxBytes the host gets one short nudge, in its own schema. Under it, nothing at all.
  const nudged = JSON.parse(claude.stdout);
  assert.match(nudged.hookSpecificOutput.additionalContext, /PromptSift: .*60000 bytes|PromptSift: .*58\.6 KB/);
  assert.equal(nudged.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.ok(nudged.hookSpecificOutput.additionalContext.length < 240);
  const cursorNudge = JSON.parse(run(telemetry, 'cursor', { cwd: root, tool_name: 'Shell', tool_input: {}, tool_output: big }, env).stdout);
  assert.match(cursorNudge.additional_context, /PromptSift/);
  const copilotNudge = JSON.parse(run(telemetry, 'copilot', { cwd: root, toolName: 'grep', toolArgs: {}, toolResult: { resultType: 'success', textResultForLlm: big } }, env).stdout);
  assert.match(copilotNudge.additionalContext, /PromptSift/);
  assert.deepEqual(JSON.parse(run(telemetry, 'cursor', { cwd: root, tool_name: 'Shell', tool_input: {}, tool_output: big }, { ...env, PROMPT_SIFT_NUDGE: '0' }).stdout), {});

  // Off switch, malformed payload and missing jq: still a neutral answer, never a crash.
  const before = (await rows(file)).length;
  run(telemetry, 'claude', { cwd: root, tool_name: 'Read', tool_response: 'x' }, { ...env, PROMPT_SIFT_TELEMETRY: '0' });
  assert.deepEqual(JSON.parse(run(telemetry, 'claude', 'not json', env).stdout), {});
  assert.deepEqual(JSON.parse(run(telemetry, 'cursor', { tool_name: 'Read' }, { ...env, PATH: '/nonexistent' }).stdout), {});
  assert.equal((await rows(file)).length, before);
});

test('preToolUse denials land in the same ledger so savings are measured, not assumed', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sift deny ledger '));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'big.txt'), 'line\n'.repeat(500));
  const file = path.join(root, 'metrics.jsonl');
  const env = { PROMPT_SIFT_METRICS_FILE: file };
  run(hook, 'claude', { cwd: root, tool_name: 'Read', tool_input: { file_path: 'big.txt' } }, env, root);
  run(hook, 'cursor', { cwd: root, tool_name: 'Shell', tool_input: { command: 'cat big.txt' } }, env, root);
  run(hook, 'cursor', { cwd: root, tool_name: 'Read', tool_input: { file_path: 'big.txt', limit: 10 } }, env, root);
  const recorded = await rows(file);
  assert.equal(recorded.length, 2, 'allowed calls are not recorded by the pre hook');
  assert.equal(recorded[0].event, 'deny'); assert.equal(recorded[0].tool, 'read'); assert.equal(recorded[0].bytes, 2500); assert.equal(recorded[0].host, 'claude');
  assert.equal(recorded[1].event, 'deny'); assert.equal(recorded[1].tool, 'shell');
  assert.doesNotMatch(await fs.readFile(file, 'utf8'), /big\.txt/);
  // A ledger that cannot be written never changes the decision.
  const readOnly = run(hook, 'claude', { cwd: root, tool_name: 'Read', tool_input: { file_path: 'big.txt' } }, { PROMPT_SIFT_METRICS_FILE: '/proc/nowhere/metrics.jsonl' }, root);
  assert.equal(JSON.parse(readOnly.stdout).hookSpecificOutput.permissionDecision, 'deny');
});

test('stats.sh summarises the ledger per tool without any Node dependency', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sift stats '));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'metrics.jsonl');
  const at = '2026-09-17T10:00:00Z';
  await fs.writeFile(file, [
    { at, host: 'claude', cwd: root, event: 'result', tool: 'read', bytes: 4000, tokens: 1000, ms: 5 },
    { at, host: 'claude', cwd: root, event: 'result', tool: 'read', bytes: 8000, tokens: 2000, ms: 5 },
    { at, host: 'claude', cwd: root, event: 'result', tool: 'grep', bytes: 400, tokens: 100, ms: 5 },
    { at, host: 'claude', cwd: root, event: 'deny', tool: 'read', bytes: 120000, tokens: 30000 },
    { at, host: 'cursor', cwd: '/elsewhere', event: 'result', tool: 'shell', bytes: 100000, tokens: 25000, ms: 5 }
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  const all = spawnSync('/bin/sh', [stats], { encoding: 'utf8', env: { ...process.env, PROMPT_SIFT_METRICS_FILE: file } });
  assert.equal(all.status, 0, all.stderr);
  assert.match(all.stdout, /read\s+2\s+12000\s+3000/);
  assert.match(all.stdout, /grep\s+1\s+400\s+100/);
  assert.match(all.stdout, /shell\s+1\s+100000\s+25000/);
  assert.match(all.stdout, /deferred.*1.*30000/i);
  const scoped = spawnSync('/bin/sh', [stats, '--cwd', root], { encoding: 'utf8', env: { ...process.env, PROMPT_SIFT_METRICS_FILE: file } });
  assert.doesNotMatch(scoped.stdout, /shell/);
  const empty = spawnSync('/bin/sh', [stats], { encoding: 'utf8', env: { ...process.env, PROMPT_SIFT_METRICS_FILE: path.join(root, 'none.jsonl') } });
  assert.equal(empty.status, 0);
  assert.match(empty.stdout, /no .*recorded/i);
});
