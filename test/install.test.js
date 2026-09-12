import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { installCommand } from "../src/commands/install.js";

test("installer preserves existing hooks and is idempotent", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "prompt-sift-install-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, ".cursor"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".cursor", "hooks.json"),
    `${JSON.stringify({ version: 1, hooks: { preToolUse: [{ command: "existing-hook" }] } })}\n`
  );

  await installCommand({ directory: root, hosts: ["cursor", "copilot"], force: false });
  await installCommand({ directory: root, hosts: ["cursor", "copilot"], force: false });

  const cursor = JSON.parse(await fs.readFile(path.join(root, ".cursor", "hooks.json"), "utf8"));
  assert.equal(cursor.hooks.preToolUse.filter((hook) => hook.command === "existing-hook").length, 1);
  assert.equal(cursor.hooks.preToolUse.filter((hook) => hook.command.includes("prompt-sift")).length, 1);

  const copilot = JSON.parse(
    await fs.readFile(path.join(root, ".github", "hooks", "prompt-sift.json"), "utf8")
  );
  assert.equal(copilot.hooks.preToolUse.length, 1);
  assert.equal(await fs.readFile(path.join(root, ".prompt-sift", "run-hook.cjs"), "utf8").then(Boolean), true);
  assert.match(await fs.readFile(path.join(root, ".gitignore"), "utf8"), /metrics\.jsonl/);
});
