import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const piiPath = fileURLToPath(
  new URL("../src/lib/gateway/pii.ts", import.meta.url),
);

if (!existsSync(piiPath)) {
  test("pii redaction pending until src/lib/gateway/pii.ts exists", () => {
    assert.ok(true);
  });
} else {
  test("redacts emails and sk- keys", async () => {
    const pii = await import("@/lib/gateway/pii");
    const redact = (pii as { redactPii?: (value: string) => string }).redactPii;
    assert.equal(typeof redact, "function");
    const out = redact!(
      "Contact admin@example.com with sk-or-v1-secretkey",
    );
    assert.equal(out.includes("admin@example.com"), false);
    assert.equal(out.includes("sk-or-v1-secretkey"), false);
  });

  test("masks phone, IP, and Luhn credit cards", async () => {
    const { redactPii } = await import("@/lib/gateway/pii");
    const out = redactPii(
      "Call +14155552671 from 8.8.8.8 card 4111 1111 1111 1111",
      ["PHONE_NUMBER", "IP_ADDRESS", "CREDIT_CARD"],
    );
    assert.equal(out.includes("+14155552671"), false);
    assert.equal(out.includes("8.8.8.8"), false);
    assert.equal(out.includes("4111 1111 1111 1111"), false);
    assert.match(out, /PHONE_NUMBER/);
    assert.match(out, /IP_ADDRESS/);
    assert.match(out, /CREDIT_CARD/);
  });

  test("masks spaced, national, and international phone formats", async () => {
    const { redactPii } = await import("@/lib/gateway/pii");
    const samples = [
      "+49 170 1234567",
      "+49 170 123 45 67",
      "+49 (0) 170 1234567",
      "+49/170/1234567",
      "0049 170 1234567",
      "0170 1234567",
      "(0170) 1234567",
      "030 12345678",
      "+4 9 1 7 0 1 2 3 4 5 6 7",
      "+49\u200B1701234567",
      "+1 (415) 555-2671",
      "1-800-555-0199",
      "06 12 34 56 78",
    ];
    for (const sample of samples) {
      assert.equal(redactPii(`Ruf an: ${sample}, danke.`, ["PHONE_NUMBER"]), "Ruf an: [PHONE_NUMBER], danke.", sample);
    }
  });

  test("leaves dates, versions, and plain numbers alone", async () => {
    const { redactPii } = await import("@/lib/gateway/pii");
    const samples = [
      "2026-08-21",
      "01.02.2026",
      "01.02.2026-03.02.2026",
      "08.30-09.45",
      "Version 0.10.2",
      "Bestellung 4711",
      "Unix 1791278857",
      "1 2 3 4 5 6 7 8 9",
    ];
    for (const sample of samples) {
      assert.equal(redactPii(sample, ["PHONE_NUMBER"]), sample);
    }
  });

  test("masks full, compressed, zoned, and IPv4-mapped IPv6 addresses", async () => {
    const { redactPii } = await import("@/lib/gateway/pii");
    const samples = [
      "2001:0db8:85a3:0000:0000:8a2e:0370:7334",
      "2001:db8:85a3::8a2e:370:7334",
      "2001:db8::1",
      "fe80::1ff:fe23:4567:890a",
      "fe80::1%eth0",
      "::ffff:192.0.2.128",
      "::1",
    ];
    for (const sample of samples) {
      assert.equal(redactPii(`Host ${sample} antwortet.`, ["IP_ADDRESS"]), "Host [IP_ADDRESS] antwortet.", sample);
    }
    assert.equal(redactPii("[2001:db8::1]:8080", ["IP_ADDRESS"]), "[[IP_ADDRESS]]:8080");
  });

  test("leaves code scopes, times, and MAC addresses alone", async () => {
    const { redactPii } = await import("@/lib/gateway/pii");
    for (const sample of ["std::vector", "Cafe::Bean", "12:30:45", "00:1A:2B:3C:4D:5E", "Ratio 1:2:3"]) {
      assert.equal(redactPii(sample, ["IP_ADDRESS"]), sample);
    }
  });

  test("does not mask unselected entities", async () => {
    const { redactPii } = await import("@/lib/gateway/pii");
    const src = "ada@acme.com 8.8.8.8";
    const out = redactPii(src, ["EMAIL_ADDRESS"]);
    assert.equal(out.includes("ada@acme.com"), false);
    assert.equal(out.includes("8.8.8.8"), true);
  });
}

test("redactPii reports which entities it masked", async () => {
  const { redactPii } = await import("@/lib/gateway/pii");
  const found = new Set<string>();
  const out = redactPii("Mail ada@acme.com from 8.8.8.8", ["EMAIL_ADDRESS", "IP_ADDRESS", "PHONE_NUMBER"], found);
  assert.equal(out, "Mail [EMAIL_ADDRESS] from [IP_ADDRESS]");
  assert.deepEqual([...found].sort(), ["EMAIL_ADDRESS", "IP_ADDRESS"]);
});

test("redactJSON collects entities but skips structural keys", async () => {
  const { redactJSON } = await import("@/lib/gateway/pii");
  const found = new Set<string>();
  const out = redactJSON(
    { model: "ada@acme.com", messages: [{ role: "user", content: "call +14155552671" }] },
    ["EMAIL_ADDRESS", "PHONE_NUMBER"],
    "",
    found,
  ) as { model: string; messages: { content: string }[] };
  assert.equal(out.model, "ada@acme.com");
  assert.equal(out.messages[0]?.content, "call [PHONE_NUMBER]");
  assert.deepEqual([...found], ["PHONE_NUMBER"]);
});

test("splitPiiPlaceholders marks catalog placeholders only", async () => {
  const { splitPiiPlaceholders } = await import("@/lib/gateway/pii");
  assert.deepEqual(splitPiiPlaceholders("Hi [EMAIL_ADDRESS], see [NOTE] and [IBAN_CODE]"), [
    { text: "Hi ", entity: null },
    { text: "[EMAIL_ADDRESS]", entity: "EMAIL_ADDRESS" },
    { text: ", see [NOTE] and ", entity: null },
    { text: "[IBAN_CODE]", entity: "IBAN_CODE" },
  ]);
  assert.deepEqual(splitPiiPlaceholders(""), []);
});

test("long prose without punctuation is still scanned while base64 blobs are skipped", async () => {
  const { isOpaqueText, redactJSON } = await import("@/lib/gateway/pii");
  const prose = `${"please call me back ".repeat(40)}+14155552671`;
  const out = redactJSON({ content: prose }, ["PHONE_NUMBER"]) as { content: string };
  assert.equal(out.content.includes("+14155552671"), false);
  const blob = "QUJD".repeat(200);
  assert.equal(isOpaqueText(blob), true);
  assert.equal(isOpaqueText(`${blob.slice(0, 400)}\n${blob.slice(400)}`), true);
  assert.equal(isOpaqueText(prose), false);
});
