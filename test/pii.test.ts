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

test("masks DACH identifiers that pass their check digits", async () => {
  const { redactPii } = await import("@/lib/gateway/pii");
  const samples: [string, string][] = [
    ["12 345 678 995", "DE_TAX_ID"],
    ["65929970489", "DE_TAX_ID"],
    ["12/345/67890", "DE_TAX_NUMBER"],
    ["123/4567/8901", "DE_TAX_NUMBER"],
    ["DE123456788", "DE_VAT_ID"],
    ["DE 136 695 976", "DE_VAT_ID"],
    ["15 070649 C 103", "DE_SOCIAL_SECURITY"],
    ["65170839J003", "DE_SOCIAL_SECURITY"],
    ["A123456780", "DE_HEALTH_INSURANCE"],
    ["X110411319", "DE_HEALTH_INSURANCE"],
    ["T220001293", "DE_ID_CARD"],
    ["T22000129", "DE_ID_CARD"],
    ["C01X00T478", "DE_PASSPORT"],
    ["1237 010180", "AT_SOCIAL_SECURITY"],
    ["ATU13585627", "AT_VAT_ID"],
    ["756.9217.0769.85", "CH_AHV"],
    ["7561234567897", "CH_AHV"],
    ["CHE-123.456.788", "CH_UID"],
  ];
  const ids = [...new Set(samples.map(([, id]) => id))];
  for (const [sample, id] of samples) {
    const found = new Set<string>();
    assert.equal(redactPii(`Nr. ${sample}, bitte.`, ids, found), `Nr. [${id}], bitte.`, sample);
    assert.deepEqual([...found], [id], sample);
  }
});

test("leaves DACH-shaped numbers with wrong check digits alone", async () => {
  const { redactPii } = await import("@/lib/gateway/pii");
  const ids = [
    "DE_TAX_ID",
    "DE_TAX_NUMBER",
    "DE_VAT_ID",
    "DE_SOCIAL_SECURITY",
    "DE_HEALTH_INSURANCE",
    "DE_ID_CARD",
    "DE_PASSPORT",
    "AT_SOCIAL_SECURITY",
    "AT_VAT_ID",
    "CH_AHV",
    "CH_UID",
  ];
  const samples = [
    "12 345 678 996",
    "11111111111",
    "+49 1234 5678901",
    "DE123456789",
    "15 070649 C 104",
    "A123456781",
    "T220001294",
    "1238 010180",
    "ATU12345676",
    "756.1234.5678.98",
    "CHE-123.456.789",
    "01/02/2026",
    "Unix 1791278857",
  ];
  for (const sample of samples) {
    assert.equal(redactPii(sample, ids), sample);
  }
});

test("a German phone number keeps its phone label when DACH entities are on", async () => {
  const { redactPii } = await import("@/lib/gateway/pii");
  assert.equal(
    redactPii("Ruf an: +49 89 123456789", ["DE_TAX_ID", "AT_SOCIAL_SECURITY", "PHONE_NUMBER"]),
    "Ruf an: [PHONE_NUMBER]",
  );
});

test("masks provider API keys, webhooks, and authorization headers", async () => {
  const { redactPii } = await import("@/lib/gateway/pii");
  const tokens = [
    `sk_${"live"}_${"a1B2c3D4".repeat(3)}`,
    `${"AKIA"}${"ABCDEFGH12345678"}`,
    `${"gh"}p_${"a1b2c3d4e5".repeat(4)}`,
    `${"github_pat"}_${"11ABCDEFG0"}_${"a1b2c3d4e5".repeat(3)}`,
    `${"glpat"}-${"a1b2c3d4e5".repeat(2)}`,
    `${"AIza"}${"Sy0123456789abcdefghijklmnopqrstuvw"}`,
    `${"hf"}_${"a1b2c3d4e5".repeat(3)}`,
    `${"npm"}_${"a1b2c3d4e5f6".repeat(3)}`,
    `${"gsk"}_${"a1b2c3d4e5".repeat(5)}`,
    `${"xai"}-${"a1b2c3d4e5".repeat(5)}`,
    `sk-hub-try.${"user1"}.1791278857.${"sigABC_123"}`,
    `https://hooks.slack.com/services/${"T000"}/${"B000"}/${"x1y2z3"}`,
  ];
  for (const token of tokens) {
    const found = new Set<string>();
    assert.equal(redactPii(`key ${token} here`, ["SECRET"], found), "key [SECRET] here", token);
    assert.deepEqual([...found], ["SECRET"], token);
  }
  assert.equal(
    redactPii(`Authorization: Bearer ${"abc123def456ghi789"}`, ["SECRET"]),
    "Authorization: Bearer [SECRET]",
  );
  assert.equal(
    redactPii(`Authorization: Basic ${"dXNlcjpwYXNzd29yZA=="}`, ["SECRET"]),
    "Authorization: Basic [SECRET]",
  );
});

test("leaves short sk- words, hyphenated words, and prose bearer mentions alone", async () => {
  const { redactPii } = await import("@/lib/gateway/pii");
  for (const sample of ["sk-learn", "risk-assessment-framework", "Bearer instruments", "Basic understanding"]) {
    assert.equal(redactPii(sample, ["SECRET"]), sample);
  }
});

test("masks private key blocks, raw and JSON-escaped", async () => {
  const { redactPii } = await import("@/lib/gateway/pii");
  const begin = ["-----BEGIN", "RSA PRIVATE KEY-----"].join(" ");
  const end = ["-----END", "RSA PRIVATE KEY-----"].join(" ");
  assert.equal(redactPii(`${begin}\nMIIEowIBAAKC\n${end}\nnext`, ["PRIVATE_KEY"]), "[PRIVATE_KEY]\nnext");
  const escaped = `{"private_key": "${begin.replace("RSA ", "")}\\nMIIE\\n${end.replace("RSA ", "")}\\n", "x": 1}`;
  assert.equal(redactPii(escaped, ["PRIVATE_KEY"]), '{"private_key": "[PRIVATE_KEY]\\n", "x": 1}');
  assert.equal(redactPii(`${begin}\nMIIEowIBAAKC`, ["PRIVATE_KEY"]), "[PRIVATE_KEY]");
});

test("masks connection strings that carry credentials", async () => {
  const { redactPii } = await import("@/lib/gateway/pii");
  const samples = [
    "postgres://admin:hunter2@db.internal:5432/prod",
    "redis://:s3cret@cache:6379",
    "mongodb+srv://app:pw@cluster0.example.net/db?retryWrites=true",
    "jdbc:postgresql://db:5432/app?user=app&password=geheim",
    "jdbc:oracle:thin:scott/tiger@db:1521:orcl",
    "Server=tcp:db.example.net,1433;Initial Catalog=app;User ID=u;Password=p4ss",
    "DefaultEndpointsProtocol=https;AccountName=acc;AccountKey=abc123+/def==;EndpointSuffix=core.windows.net",
  ];
  for (const sample of samples) {
    const found = new Set<string>();
    assert.equal(redactPii(`Use ${sample}.`, ["CONNECTION_STRING"], found), "Use [CONNECTION_STRING].", sample);
    assert.deepEqual([...found], ["CONNECTION_STRING"], sample);
  }
  assert.equal(
    redactPii("postgres://admin:hunter2@db:5432/prod", ["CONNECTION_STRING", "EMAIL_ADDRESS"]),
    "[CONNECTION_STRING]",
  );
});

test("leaves connection strings without credentials alone", async () => {
  const { redactPii } = await import("@/lib/gateway/pii");
  const samples = [
    "postgres://localhost:5432/app",
    "ssh://git@github.com/acme/repo",
    "https://registry.npmjs.org:443/@scope/pkg",
    "Server=db;Database=app;Trusted_Connection=True;",
    "https://example.com/search?q=token&page=2",
  ];
  for (const sample of samples) {
    assert.equal(redactPii(sample, ["CONNECTION_STRING"]), sample);
  }
});

test("masks secret values in env, JSON, YAML, and flag assignments", async () => {
  const { redactPii } = await import("@/lib/gateway/pii");
  const samples: [string, string][] = [
    ["DB_PASSWORD=supersecret", "DB_PASSWORD=[ENV_SECRET]"],
    ["export AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG", "export AWS_SECRET_ACCESS_KEY=[ENV_SECRET]"],
    ['API_KEY="abc"', 'API_KEY="[ENV_SECRET]"'],
    ["docker run -e POSTGRES_PASSWORD=pw123 postgres", "docker run -e POSTGRES_PASSWORD=[ENV_SECRET] postgres"],
    ['{"password": "hunter2", "user": "ada"}', '{"password": "[ENV_SECRET]", "user": "ada"}'],
    ['{"clientSecret":"abc"}', '{"clientSecret":"[ENV_SECRET]"}'],
    ["db:\n  password: supersecret\n  user: app", "db:\n  password: [ENV_SECRET]\n  user: app"],
    ["Password: hunter2.", "Password: [ENV_SECRET]."],
    ["./app --password=hunter2 --verbose", "./app --password=[ENV_SECRET] --verbose"],
    ['password := "hunter2"', 'password := "[ENV_SECRET]"'],
    ["MISTRAL_KEY=AbCdEfGh1234567890XyZ", "MISTRAL_KEY=[ENV_SECRET]"],
    ["X-API-Key: abc123def456", "X-API-Key: [ENV_SECRET]"],
  ];
  for (const [sample, expected] of samples) {
    assert.equal(redactPii(sample, ["ENV_SECRET"]), expected, sample);
  }
});

test("leaves code, type hints, references, and token counts alone", async () => {
  const { redactPii } = await import("@/lib/gateway/pii");
  const samples = [
    "max_tokens: 4096",
    "MAX_TOKENS=4096",
    "TOKEN_LIMIT=5",
    "const token = await getToken();",
    'password = request.form["password"]',
    'api_key = os.getenv("OPENAI_API_KEY")',
    "password=args.password",
    "interface User {\n  password: string;\n  token: string\n}",
    "password: z.string().min(8)",
    "API_KEY=${API_KEY}",
    "PASSWORD=<your-password>",
    "PWD=/home/user",
    "BYPASS=1",
    "The secret: sauce. Token: authentication",
    "SORT_KEY=name",
    'password = ""',
  ];
  for (const sample of samples) {
    assert.equal(redactPii(sample, ["ENV_SECRET"]), sample);
  }
  assert.equal(
    redactPii(`OPENAI_API_KEY=sk-proj-${"abc123def456"}`, ["SECRET", "ENV_SECRET"]),
    "OPENAI_API_KEY=[SECRET]",
  );
});

test("masks EVM, bech32, and base58 wallet addresses", async () => {
  const { redactPii } = await import("@/lib/gateway/pii");
  const samples = [
    "0x52908400098527886E0F7030069857D2E4169EE7",
    "ltc1qg82vl0d3ksvtt8hdla4xq9wqstvqt5u5en2zay",
    "bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a",
    "rN7n7otQDd6FczFgLdSqtcsAUxDkw6fzRH",
    "DH5yaieqoZN36fDVciNyRueRGvGLR3mr7L",
    "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
  ];
  for (const sample of samples) {
    assert.equal(redactPii(`Send to ${sample} now`, ["CRYPTO"]), "Send to [CRYPTO] now", sample);
  }
  for (const sample of [
    "MultiProviderConfigurationManagerFactory",
    "0x1234",
    `0x${"ab".repeat(32)}`,
    "TestCaseForUserAuthentication",
  ]) {
    assert.equal(redactPii(sample, ["CRYPTO"]), sample);
  }
});
