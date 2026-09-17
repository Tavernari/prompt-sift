import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFile(path.join(root, relative), 'utf8');

// A live Cursor session (2026-09-17) dispatched an edit to the read-only worker. Cursor's
// readonly only blocked the edit tools, so the worker wrote "Applying edits via shell since
// file edit tools are blocked" and modified four files, project.pbxproj included. The worker's
// contract never said to refuse; the parent's routing guidance never said edits stay home.
for (const host of ['cursor', 'copilot', 'claude']) {
  test(`${host} worker refuses edits and never works around read-only through the shell`, async () => {
    const worker = await read(`templates/agents/${host}-worker.md`);
    assert.match(worker, /read-only/i, 'the worker must state it is read-only');
    assert.match(worker, /do not (attempt|apply|work around)/i, 'the worker must refuse, not attempt, delegated edits');
    assert.match(worker, /shell|redirection|heredoc|sed -i/i, 'the refusal must name the shell workaround explicitly');
    assert.match(worker, /return|report/i, 'the worker must hand the task back to the parent');
  });

  test(`${host} routing guidance keeps surgical edits in the parent agent`, async () => {
    const bulkReader = await read('templates/skills/bulk-reader/SKILL.md');
    const primary = await read(`templates/agents/${host}-primary.md`);
    for (const [name, text] of [['bulk-reader skill', bulkReader], ['primary agent', primary]]) {
      assert.match(text, /never delegate .*edit|edits? (stay|remain|belong)/i, `${name} must say edits are not delegation targets`);
    }
    if (host === 'cursor') {
      const build = await read('scripts/build-plugins.js');
      const rule = build.match(/rules\/routing\.mdc',\s*'([^']*)'/)?.[1] ?? '';
      assert.match(rule, /edit/i, 'the always-on Cursor routing rule must say edits stay in the parent');
    }
  });
}
