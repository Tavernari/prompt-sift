import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const source = path.resolve(import.meta.dirname, '../scripts/plugin/bootstrap-jq.sh');
const digests = {
  'Linux/x86_64': ['jq-linux-amd64', 'b1c22172dd303f3be49e935aa56aa48a8b7a46e0bc838b4997d3bb451495870f'],
  'Linux/aarch64': ['jq-linux-arm64', '8b85c817833814ddca00a144c33705546355afccf0cf39b188f3cdb48b852309'],
  'Darwin/x86_64': ['jq-macos-amd64', 'e94b266e3c26690550006abe63152b782280f4e14374accdf04cbde844f00bc0'],
  'Darwin/arm64': ['jq-macos-arm64', '2d75340ba57a4b4b4c8708a21c2dc8e958a48aaa8bba13b27f77f6e4c0eca07e']
};
async function toolsDirectory(root) {
  const bin = path.join(root, 'bin');
  await fs.mkdir(bin);
  for (const tool of ['uname', 'sha256sum', 'shasum', 'mkdir', 'mktemp', 'rm', 'chmod', 'mv', 'curl']) {
    const result = spawnSync('/bin/sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' });
    if (result.status === 0) await fs.symlink(result.stdout.trim(), path.join(bin, tool));
  }
  return bin;
}
for (const [platform, [asset, pinned]] of Object.entries(digests)) {
  test(`automatic jq bootstrap verifies before execution and reuses cache: ${platform}`, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sift bootstrap '));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const bin = await toolsDirectory(root);
    const fixture = '#!/bin/sh\nprintf invoked >> "$TEST_EXECUTIONS"\nprintf "jq-1.8.2\\n"\n';
    const fixtureFile = path.join(root, 'fixture');
    await fs.writeFile(fixtureFile, fixture);
    // Exercise the exact verifier with a local fixture; production digests have no runtime override.
    const original = await fs.readFile(source, 'utf8');
    assert.ok(original.includes(pinned));
    const fixtureHash = createHash('sha256').update(fixture).digest('hex');
    const bootstrap = path.join(root, 'bootstrap.sh');
    await fs.writeFile(bootstrap, original.replace(pinned, fixtureHash));
    await fs.unlink(path.join(bin, 'uname'));
    await fs.writeFile(path.join(bin, 'uname'), '#!/bin/sh\ncase "$1" in -s) printf "%s\\n" "$TEST_OS";; -m) printf "%s\\n" "$TEST_ARCH";; esac\n', { mode: 0o755 });
    await fs.unlink(path.join(bin, 'curl'));
    await fs.writeFile(path.join(bin, 'curl'), '#!/bin/sh\nprintf call >> "$TEST_DOWNLOADS"\n[ "$TEST_NETWORK" != fail ] || exit 22\nwhile [ "$#" -gt 0 ]; do if [ "$1" = --output ]; then shift; /bin/cp "$TEST_FIXTURE" "$1"; fi; shift; done\n', { mode: 0o755 });
    const env = { ...process.env, PATH: bin, XDG_CACHE_HOME: path.join(root, 'cache'),
      TEST_OS: platform.split('/')[0], TEST_ARCH: platform.split('/')[1], TEST_FIXTURE: fixtureFile,
      TEST_EXECUTIONS: path.join(root, 'executions'), TEST_DOWNLOADS: path.join(root, 'downloads'), TEST_NETWORK: 'ok' };
    const run = overrides => spawnSync('/bin/sh', [bootstrap], { env: { ...env, ...overrides }, encoding: 'utf8' });
    let result = run();
    assert.equal(result.status, 0, result.stderr);
    const installed = result.stdout.trim();
    assert.equal(installed, path.join(env.XDG_CACHE_HOME, 'prompt-sift/jq-1.8.2', asset, 'jq'));
    assert.equal(await fs.readFile(installed, 'utf8'), fixture);
    assert.equal((await fs.stat(installed)).mode & 0o777, 0o700);
    assert.equal(run({ TEST_NETWORK: 'fail' }).status, 0, 'verified cache must work offline');
    assert.equal(await fs.readFile(env.TEST_DOWNLOADS, 'utf8'), 'call');
    await fs.writeFile(installed, 'tampered');
    await fs.writeFile(fixtureFile, fixture + '# invalid digest\n');
    result = run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /checksum mismatch/);
    assert.equal(await fs.readFile(env.TEST_EXECUTIONS, 'utf8'), 'invoked', 'unverified binaries never execute');
    assert.deepEqual(await fs.readdir(path.dirname(installed)), ['jq'], 'failed downloads cleaned up');
    const downloads = await fs.readFile(env.TEST_DOWNLOADS, 'utf8');
    assert.notEqual(run({ PROMPT_SIFT_AUTO_INSTALL: '0' }).status, 0);
    assert.equal(await fs.readFile(env.TEST_DOWNLOADS, 'utf8'), downloads);
    assert.notEqual(run({ TEST_NETWORK: 'fail' }).status, 0);
  });
}

test('live official jq download validates the production digest', { skip: process.env.PROMPT_SIFT_LIVE_BOOTSTRAP !== '1' }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sift real bootstrap '));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bin = await toolsDirectory(root);
  const result = spawnSync('/bin/sh', [source], { env: { ...process.env, PATH: bin, XDG_CACHE_HOME: root }, encoding: 'utf8', timeout: 18000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(spawnSync(result.stdout.trim(), ['--version'], { encoding: 'utf8' }).stdout.trim(), 'jq-1.8.2');
});
