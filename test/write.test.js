import assert from "node:assert/strict";
import test from "node:test";
import { stripWrappingFence } from "../src/commands/write.js";

test("strips only one wrapping markdown fence", () => {
  const input = "```js\nconst example = `\\n```json\\n{}\\n```\\n`;\n```";
  const output = stripWrappingFence(input);
  assert.equal(output, "const example = `\\n```json\\n{}\\n```\\n`;");
});

test("does not remove internal fences from an unfenced file", () => {
  const input = "const docs = `\\n```sh\\necho hi\\n```\\n`;";
  assert.equal(stripWrappingFence(input), input);
});
