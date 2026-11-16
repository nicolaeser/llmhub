import assert from "node:assert/strict";
import test from "node:test";
import { claudeTierModels, toolGuide } from "@/app/(app)/developer/_components/connect-guides";

test("the Claude Code guide pins each Claude tier to the newest matching hub model", () => {
  const models = [
    "claude-opus-4-8",
    "claude-opus-5-5",
    "claude-opus-5",
    "claude-sonnet-5-5",
    "claude-haiku-4-5-20251001",
    "claude-haiku-4-5",
    "api/claude-fable-5-2",
    "claude-opus-5-5-fast",
    "gpt-5.5",
  ];
  assert.deepEqual(claudeTierModels(models), [
    ["ANTHROPIC_DEFAULT_OPUS_MODEL", "claude-opus-5-5"],
    ["ANTHROPIC_DEFAULT_SONNET_MODEL", "claude-sonnet-5-5"],
    ["ANTHROPIC_DEFAULT_HAIKU_MODEL", "claude-haiku-4-5"],
  ]);
  assert.deepEqual(claudeTierModels(["gpt-5.5"]), []);

  const guide = toolGuide("claudeCode", {
    origin: "https://hub.example",
    route: "subscription",
    key: "sk-hub-…",
    model: "claude-opus-5-5",
    models,
    shell: "posix",
    sdk: "anthropic",
  });
  const settings = JSON.parse(guide.steps[0]!.code!.text) as { env: Record<string, string> };
  assert.deepEqual(Object.keys(settings.env), [
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_USE_GATEWAY",
    "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  ]);
  assert.equal(settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL, "claude-opus-5-5");
  assert.equal(settings.env.ANTHROPIC_DEFAULT_FABLE_MODEL, undefined);
  assert.match(guide.steps[0]!.alt!.code.text, /export ANTHROPIC_DEFAULT_SONNET_MODEL="claude-sonnet-5-5"/);
});
