import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { GateError } from "@/lib/gateway/errors";
import { applyGuardrails } from "@/lib/gateway/gate";
import { defaultGuardrails } from "@/lib/gateway/guardrails";
import { defaultEntityIds } from "@/lib/gateway/pii";
import { piiOverride } from "@/lib/gateway/settings";
import type { Principal, VirtualKeyView } from "@/types/gateway";
import type { PiiPolicy } from "@/types/guardrails";

const root = fileURLToPath(new URL("..", import.meta.url));

function keyPrincipal(pii: PiiPolicy): Principal {
  const key: VirtualKeyView = {
    token_id: "key_1",
    key_name: "sk-hub-abcde",
    key_alias: "test",
    user_id: "",
    team_id: "",
    org_id: "org_1",
    project_id: "",
    member_id: "",
    models: [],
    templates: [],
    max_budget: 0,
    spend: 0,
    rpm_limit: 0,
    tpm_limit: 0,
    budget_duration: "",
    expires: "",
    allowed_ips: [],
    blocked: false,
    pii,
    log_content: true,
    created_at: "",
  };
  return {
    actor: key.key_name,
    key,
    teamId: "",
    orgId: "org_1",
    userId: "",
    memberId: "",
    models: [],
    routeLimits: {},
    guardrails: defaultGuardrails(),
  };
}

const sample = { model: "m", messages: [{ role: "user", content: "mail ada@acme.com from 8.8.8.8" }] };

test("piiOverride treats missing values as inherit and normalizes stored policies", () => {
  assert.equal(piiOverride(null), null);
  assert.equal(piiOverride(undefined), null);
  assert.equal(piiOverride([]), null);
  assert.deepEqual(piiOverride({ mode: "block", entities: ["EMAIL_ADDRESS"] }), {
    enabled: true,
    mode: "block",
    output: true,
    entities: ["EMAIL_ADDRESS"],
  });
  assert.equal(piiOverride({ mode: "drop" })?.mode, "mask");
});

test("a key override masks only its own entities and returns them for output redaction", async () => {
  const { body, output } = await applyGuardrails(
    structuredClone(sample),
    keyPrincipal({ enabled: true, mode: "mask", output: true, entities: ["IP_ADDRESS"] }),
  );
  assert.equal(JSON.stringify(body).includes("ada@acme.com"), true);
  assert.equal(JSON.stringify(body).includes("8.8.8.8"), false);
  assert.deepEqual(output?.pii, ["IP_ADDRESS"]);
});

test("a key override in block mode rejects matching prompts", async () => {
  await assert.rejects(
    applyGuardrails(
      structuredClone(sample),
      keyPrincipal({ enabled: true, mode: "block", output: true, entities: ["EMAIL_ADDRESS"] }),
    ),
    (err: unknown) => err instanceof GateError && err.status === 400 && err.code === "pii_blocked",
  );
  const clean = await applyGuardrails(
    { model: "m", messages: [{ role: "user", content: "hello" }] },
    keyPrincipal({ enabled: true, mode: "block", output: false, entities: ["EMAIL_ADDRESS"] }),
  );
  assert.equal(clean.output, null);
});

test("a disabled key override passes prompts through and skips output redaction", async () => {
  const { body, output } = await applyGuardrails(
    structuredClone(sample),
    keyPrincipal({ enabled: false, mode: "block", output: true, entities: [] }),
  );
  assert.deepEqual(body, sample);
  assert.equal(output, null);
});

test("an override without entities uses the default set", async () => {
  const { output } = await applyGuardrails(
    structuredClone(sample),
    keyPrincipal({ enabled: true, mode: "mask", output: true, entities: [] }),
  );
  assert.deepEqual(output?.pii, defaultEntityIds());
});

test("resolvePolicies prefers the key, then the project, then the organization, then the global policy", async () => {
  const settings = await readFile(path.join(root, "src/lib/gateway/settings.ts"), "utf8");
  const start = settings.indexOf("export async function resolvePolicies");
  const body = settings.slice(start, settings.indexOf("\n}\n", start));
  for (const [key, project, org, global] of [
    ["principal.key?.pii", "project?.piiPolicy", "org?.piiPolicy", "enterprise.pii"],
    ["principal.guardrails", "project?.guardrailPolicy", "org?.guardrailPolicy", "enterprise.guardrails"],
  ]) {
    const order = [key, project, org, global].map((needle) => body.indexOf(needle));
    assert.ok(order[0]! > 0 && order.every((at, i) => i === 0 || at > order[i - 1]!), order.join(","));
  }
});

test("every gateway route applies guardrails for the caller", async () => {
  const files: string[] = [];
  async function walk(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith(".ts")) files.push(full);
    }
  }
  await walk(path.join(root, "src/app"));
  await walk(path.join(root, "src/lib"));
  let calls = 0;
  for (const file of files) {
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(/(?<!function )applyGuardrails\(/g)) {
      const open = (match.index ?? 0) + match[0].length;
      let depth = 1;
      let end = open;
      while (depth > 0 && end < source.length) {
        const ch = source[end++];
        if (ch === "(") depth++;
        if (ch === ")") depth--;
      }
      const args = source.slice(open, end - 1).trim();
      assert.match(args, /,\s*principal$/, `${path.relative(root, file)}: applyGuardrails(${args})`);
      calls++;
    }
  }
  assert.ok(calls > 10);
});
