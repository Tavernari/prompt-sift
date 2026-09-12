// Bundled entry point: no npm install, network calls, or project writes.
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const host = process.argv[2];
const neutral = host === 'cursor' ? { permission: 'allow' }
  : host === 'copilot' ? { permissionDecision: 'allow' } : {};
let finished = false;
function finish(value) {
  if (finished) return;
  finished = true;
  process.stdout.write(JSON.stringify(value) + '\n', () => process.exit(0));
}
const timer = setTimeout(() => {
  process.stderr.write('PromptSift: hook timed out; native agents remain available.\n');
  finish(neutral);
}, 3000);
(async () => {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 1024 * 1024) throw new Error('oversized hook payload');
    chunks.push(chunk);
  }
  const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const cwd = payload.cwd ?? payload.workspace_roots?.[0] ?? process.cwd();
  process.chdir(cwd);
  const { loadConfig } = await import(pathToFileURL(path.join(__dirname, 'src/config.js')));
  const { evaluateHook } = await import(pathToFileURL(path.join(__dirname, 'src/core/hook.js')));
  const result = await evaluateHook(host, payload, await loadConfig(cwd));
  // Plugin agents are namespaced by the host. Never suggest an uninstalled CLI.
  function reason(text) {
    return text.replace(/For an explicitly requested external API worker, run: .*?(?=For debugging)/s, '')
      .replaceAll(`prompt-sift-${host}-worker`, `prompt-sift:prompt-sift-${host}-worker`)
      .replaceAll(`prompt-sift-${host}-primary`, `prompt-sift:prompt-sift-${host}-primary`);
  }
  for (const key of ['user_message', 'agent_message', 'permissionDecisionReason']) {
    if (typeof result[key] === 'string') result[key] = reason(result[key]);
  }
  if (result.hookSpecificOutput?.permissionDecisionReason) {
    result.hookSpecificOutput.permissionDecisionReason = reason(result.hookSpecificOutput.permissionDecisionReason);
  }
  clearTimeout(timer);
  finish(result);
})().catch(() => {
  clearTimeout(timer);
  // Avoid exposing source paths or input in diagnostics.
  process.stderr.write('PromptSift: hook unavailable; native agents remain available.\n');
  finish(neutral);
});
