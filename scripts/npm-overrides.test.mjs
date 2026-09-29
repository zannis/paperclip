import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { assertOverridesMatchDirectPins, npmOverridesFrom } from "./npm-overrides.mjs";

test("nested pnpm overrides become npm overrides under their parent", () => {
  assert.deepEqual(
    npmOverridesFrom({
      "@agentclientprotocol/codex-acp@1.6.2>@openai/codex": "0.156.0",
      "@agentclientprotocol/claude-agent-acp@0.81.2>@anthropic-ai/claude-agent-sdk": "0.3.283",
      rollup: ">=4.59.0",
    }),
    {
      "@agentclientprotocol/codex-acp@1.6.2": { "@openai/codex": "0.156.0" },
      "@agentclientprotocol/claude-agent-acp@0.81.2": { "@anthropic-ai/claude-agent-sdk": "0.3.283" },
    },
  );
});

test("a deeper pnpm selector has no npm equivalent and is refused", () => {
  assert.throws(() => npmOverridesFrom({ "a>b>c": "1.0.0" }), /a>b>c has no npm equivalent/);
});

test("the workspace's provider runtime pins reach the published package", () => {
  const root = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const overrides = npmOverridesFrom(root.pnpm.overrides);
  assert.equal(
    overrides["@agentclientprotocol/claude-agent-acp@0.81.2"]?.["@anthropic-ai/claude-agent-sdk"],
    "0.3.283",
  );
  assert.equal(overrides["@agentclientprotocol/codex-acp@1.6.2"]?.["@openai/codex"], "0.156.0");
});

test("an override on a direct dependency needs that dependency pinned to its exact version", () => {
  const overrides = { "@agentclientprotocol/codex-acp@1.6.2": { "@openai/codex": "0.156.0" } };
  assert.doesNotThrow(() => assertOverridesMatchDirectPins(overrides, { "@agentclientprotocol/codex-acp": "1.6.2" }));
  assert.doesNotThrow(() => assertOverridesMatchDirectPins(overrides, {}));
  assert.throws(
    () => assertOverridesMatchDirectPins(overrides, { "@agentclientprotocol/codex-acp": "^1.6.2" }),
    /needs the direct dependency @agentclientprotocol\/codex-acp pinned to 1\.6\.2, not \^1\.6\.2/,
  );
});
