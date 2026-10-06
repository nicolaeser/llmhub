import assert from "node:assert/strict";
import test from "node:test";
import { parseRequest } from "@/lib/gateway/responses";
import { systemOneRequestSchema } from "@/schemas/decisions";

test("systemone accepts noul, choice, and score questions with free-form state", () => {
  const parsed = parseRequest(systemOneRequestSchema, {
    model: "jev-latest",
    state: { subject: "Duplicate charge", message: "Please help." },
    questions: {
      billing: { type: "noul", instructions: "Is this message about billing?" },
      tone: { type: "choice", instructions: "What is the tone?", criteria: { calm: null, angry: "Upset or hostile" } },
      urgency: { type: "score", instructions: "How urgent?", criteria: ["Not urgent", "Somewhat", "Very urgent"] },
      spam: { type: "noul", criteria: { true: "Unsolicited ads", false: null } },
    },
    providerOptions: { gateway: { zeroDataRetention: true } },
  });
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.deepEqual(parsed.data.providerOptions, { gateway: { zeroDataRetention: true } });
  assert.equal(parseRequest(systemOneRequestSchema, { model: "jev", state: "text", questions: { a: { type: "noul" } } }).ok, true);
  assert.equal(parseRequest(systemOneRequestSchema, { model: "jev", state: ["a", "b"], questions: { a: { type: "noul" } } }).ok, true);
});

test("systemone rejects malformed decision requests with a field path", () => {
  const cases: [unknown, RegExp][] = [
    [{ model: "jev", state: "x", questions: {} }, /^questions: questions need at least one entry/],
    [{ model: "jev", questions: { a: { type: "noul" } } }, /^state/],
    [{ model: "jev", state: "x", questions: { a: { type: "boolean" } } }, /^questions\.a\.type: question type must be noul, choice, or score/],
    [{ model: "jev", state: "x", questions: { a: { type: "choice", criteria: {} } } }, /^questions\.a\.criteria: choice criteria need at least one option/],
    [{ model: "jev", state: "x", questions: { a: { type: "score", criteria: [] } } }, /^questions\.a\.criteria/],
    [{ state: "x", questions: { a: { type: "noul" } } }, /^model/],
  ];
  for (const [body, message] of cases) {
    const parsed = parseRequest(systemOneRequestSchema, body);
    assert.equal(parsed.ok, false, JSON.stringify(body));
    if (!parsed.ok) assert.match(parsed.message, message);
  }
});
