import assert from "node:assert/strict";
import test from "node:test";
import { redactJSON, redactPii } from "@/lib/gateway/safety/pii";
import { PiiVault, bindPiiVault, restoreJson, restoreSseResponse, vaultOf } from "@/lib/gateway/safety/pii-vault";
import { restoreClientJson } from "@/lib/gateway/safety/restore-client";

test("restore numbers personal data and leaves secrets masked", () => {
  const vault = new PiiVault();
  const masked = redactPii("Write ada@acme.com and again ada@acme.com", ["EMAIL_ADDRESS"], undefined, vault);
  assert.equal(masked, "Write [EMAIL_ADDRESS_1] and again [EMAIL_ADDRESS_1]");
  const secret = redactPii("token sk-live-secret-value", ["SECRET"], undefined, vault);
  assert.match(secret, /\[SECRET\]/);
  assert.equal(secret.includes("SECRET_"), false);
  assert.equal(vault.restore(secret), secret);
  assert.equal(vault.restore(masked), "Write ada@acme.com and again ada@acme.com");
  const logged = { content: masked };
  const restored = restoreJson(structuredClone(logged), vault) as { content: string };
  assert.equal(logged.content, masked);
  assert.equal(restored.content, "Write ada@acme.com and again ada@acme.com");
});

test("block mode stays a static placeholder", () => {
  const masked = redactPii("ada@acme.com", ["EMAIL_ADDRESS"]);
  assert.equal(masked, "[EMAIL_ADDRESS]");
  assert.equal(new PiiVault().restore(masked), masked);
});

test("client restore uses the request vault and leaves the stored object masked", () => {
  const trace = {
    endpoint: "chat",
    piiMode: "restore" as const,
    piiInput: new Set<string>(),
    piiOutput: new Set<string>(),
    guardInput: new Set<string>(),
    guardOutput: new Set<string>(),
    guardBlocked: false,
  };
  const vault = new PiiVault();
  bindPiiVault(trace, vault);
  const stored = redactJSON({ messages: [{ content: "ada@acme.com" }] }, ["EMAIL_ADDRESS"], "", undefined, vault) as {
    messages: { content: string }[];
  };
  assert.equal(stored.messages[0]?.content, "[EMAIL_ADDRESS_1]");
  const visible = restoreClientJson(trace, stored) as { messages: { content: string }[] };
  assert.equal(stored.messages[0]?.content, "[EMAIL_ADDRESS_1]");
  assert.equal(visible.messages[0]?.content, "ada@acme.com");
  assert.equal(vaultOf(trace), vault);
});

test("streaming restore holds a placeholder split across chunks", async () => {
  const vault = new PiiVault();
  assert.equal(vault.placeholder("EMAIL_ADDRESS", "ada@acme.com"), "[EMAIL_ADDRESS_1]");
  const token = "[EMAIL_ADDRESS_1]";
  const split = token.indexOf("DRESS");
  const encoder = new TextEncoder();
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`hello ${token.slice(0, split)}`));
      controller.enqueue(encoder.encode(`${token.slice(split)} end`));
      controller.close();
    },
  });
  const text = await restoreSseResponse(new Response(source), vault).text();
  assert.equal(text, "hello ada@acme.com end");
});
