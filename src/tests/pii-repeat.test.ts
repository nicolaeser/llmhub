import assert from "node:assert/strict";
import test from "node:test";
import { redactJSON, redactPii } from "@/lib/gateway/safety/pii";
import { PiiVault } from "@/lib/gateway/safety/pii-vault";

const PADDING = "The build log below belongs to the nightly pipeline and lists every step that ran. ";

function longText(core: string): string {
  return `${PADDING}${core} ${PADDING}`;
}

test("repeated texts redact the same way and report their entities every time", () => {
  const text = longText("Mail jane.roe@example.com or call +1 415 555 2671.");
  const runs = [0, 1, 2].map(() => {
    const found = new Set<string>();
    return { out: redactPii(text, undefined, found), found: [...found].sort() };
  });
  assert.match(runs[0]!.out, /\[EMAIL_ADDRESS\]/);
  assert.equal(runs[0]!.out.includes("jane.roe@example.com"), false);
  for (const run of runs) assert.deepEqual(run, runs[0]);
  assert.deepEqual(runs[0]!.found, ["EMAIL_ADDRESS", "PHONE_NUMBER"]);
});

test("a remembered text is scanned again for a different entity list", () => {
  const text = longText("Mail jane.roe@example.com or call +1 415 555 2671.");
  const emailOnly = redactPii(text, ["EMAIL_ADDRESS"]);
  const phoneOnly = redactPii(text, ["PHONE_NUMBER"]);
  assert.equal(emailOnly.includes("jane.roe@example.com"), false);
  assert.equal(emailOnly.includes("+1 415 555 2671"), true);
  assert.equal(phoneOnly.includes("jane.roe@example.com"), true);
  assert.equal(phoneOnly.includes("+1 415 555 2671"), false);
  assert.equal(redactPii(text, ["EMAIL_ADDRESS"]), emailOnly);
});

test("restore mode numbers placeholders per request even for remembered texts", () => {
  const text = longText("Mail jane.roe@example.com today.");
  assert.match(redactPii(text), /\[EMAIL_ADDRESS\]/);
  for (const vault of [new PiiVault(), new PiiVault()]) {
    const found = new Set<string>();
    const out = redactPii(text, undefined, found, vault);
    assert.match(out, /\[EMAIL_ADDRESS_1\]/);
    assert.deepEqual([...found], ["EMAIL_ADDRESS"]);
    assert.equal(vault.restore(out), text);
  }
  assert.match(redactPii(text), /\[EMAIL_ADDRESS\]/);
});

test("redacting the same conversation again gives an identical body", () => {
  const body = JSON.stringify({
    model: "claude-load",
    system: [{ type: "text", text: longText("Contact ops@example.com for access.") }],
    messages: [
      { role: "user", content: [{ type: "text", text: longText("My server is 10.20.30.40 and the key is sk-live-abcdefghijklmnop.") }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: longText("ops@example.com stays inside signed thinking."), signature: "c2lnbmF0dXJl" },
          { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: longText("curl https://user:hunter2@db.example.com/") } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: longText("Logged in as ops@example.com.") }] },
    ],
  });
  const first = new Set<string>();
  const second = new Set<string>();
  const once = redactJSON(JSON.parse(body), undefined, "", first);
  const twice = redactJSON(JSON.parse(body), undefined, "", second);
  assert.deepEqual(twice, once);
  assert.deepEqual([...second].sort(), [...first].sort());
  assert.equal(JSON.stringify(once).includes("ops@example.com stays inside signed thinking"), true);
  assert.equal(JSON.stringify(once).includes("Logged in as ops@example.com"), false);
});
