import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  accessSummary,
  draftAccessValid,
  draftBasicsValid,
  draftNetworkValid,
  draftOfKey,
  invalidIps,
  keyFieldsOf,
  newKeyDraft,
} from "@/lib/keys/draft";
import type { VirtualKeyView } from "@/types/keys";
import { importedAs, readJsx, rendersComponent } from "./support/jsx-source";

const root = fileURLToPath(new URL("../..", import.meta.url));

const TEMPLATES = [
  { id: "t1", matches: ["gpt-a", "gpt-b"] },
  { id: "t2", matches: [] },
];

function view(over: Partial<VirtualKeyView> = {}): VirtualKeyView {
  return {
    token_id: "k1",
    key_name: "sk-hub-1234",
    key_alias: "prod",
    user_id: "u1",
    team_id: "",
    org_id: "o1",
    project_id: "p1",
    member_id: "",
    models: [],
    templates: [],
    max_budget: 0,
    spend: 0,
    rpm_limit: 0,
    tpm_limit: 0,
    max_request_cost: 0,
    budget_duration: "",
    expires: "",
    allowed_ips: [],
    allowed_endpoints: [],
    access_windows: [],
    access_time_zone: "UTC",
    blocked: false,
    paused: false,
    paused_until: "",
    log_content: true,
    created_at: "2026-10-30T00:00:00.000Z",
    ...over,
  };
}

test("a new draft needs a name and a bound owner before step 1 is valid", () => {
  const project = newKeyDraft("project", null);
  assert.equal(draftBasicsValid(project), false);
  assert.equal(draftBasicsValid({ ...project, alias: "app" }), false);
  assert.equal(draftBasicsValid({ ...project, alias: "app", projectId: "p1" }), true);
  assert.equal(draftBasicsValid({ ...newKeyDraft("internal", null), alias: " " }), false);
  assert.equal(draftBasicsValid({ ...newKeyDraft("internal", null), alias: "me" }), true);
  assert.deepEqual(newKeyDraft("member", { kind: "member", id: "m1" }).memberId, "m1");
});

test("restricted access needs at least one preset or model", () => {
  const draft = newKeyDraft("internal", null);
  assert.equal(draftAccessValid(draft), true);
  assert.equal(draftAccessValid({ ...draft, restricted: true }), false);
  assert.equal(draftAccessValid({ ...draft, restricted: true, templateIds: ["t2"] }), true);
});

test("the access summary resolves presets into the models a key can call", () => {
  assert.deepEqual(accessSummary({ models: [], templateIds: [] }, TEMPLATES), { state: "all", models: [] });
  assert.deepEqual(accessSummary({ restricted: false, models: ["x"], templateIds: [] }, TEMPLATES), {
    state: "all",
    models: [],
  });
  assert.deepEqual(accessSummary({ models: ["gpt-b", "z"], templateIds: ["t1"] }, TEMPLATES), {
    state: "some",
    models: ["gpt-a", "gpt-b", "z"],
  });
  assert.deepEqual(accessSummary({ models: [], templateIds: ["t2"] }, TEMPLATES), { state: "none", models: [] });
});

test("a draft round-trips a key and drops selections when access is open again", () => {
  const key = view({
    models: ["gpt-a"],
    templates: ["t1"],
    rpm_limit: 60,
    allowed_ips: ["203.0.113.10"],
    access_windows: [{ days: ["mon"], start: "08:00", end: "18:00" }],
  });
  const draft = draftOfKey(key);
  assert.equal(draft.restricted, true);
  assert.equal(draft.kind, "project");
  const fields = keyFieldsOf(draft);
  assert.deepEqual(fields.models, ["gpt-a"]);
  assert.deepEqual(fields.templateIds, ["t1"]);
  assert.equal(fields.rpm, 60);
  assert.deepEqual(fields.allowedIps, ["203.0.113.10"]);
  assert.deepEqual(fields.accessWindows, [{ days: ["mon"], start: "08:00", end: "18:00" }]);
  const open = keyFieldsOf({ ...draft, restricted: false, kind: "internal", rpm: Number.NaN, maxRequestCost: -1 });
  assert.deepEqual([open.models, open.templateIds, open.projectId, open.rpm, open.maxRequestCost], [[], [], "", 0, 0]);
});

test("IP allowlist entries are checked before saving", () => {
  assert.deepEqual(invalidIps("203.0.113.10\n2001:db8::1, 10.0.0.1"), []);
  assert.deepEqual(invalidIps("203.0.113.300 example.com"), ["203.0.113.300", "example.com"]);
  assert.equal(draftNetworkValid({ ...newKeyDraft("internal", null), ips: "localhost" }), false);
});

test("key creation runs through the shared StepDialog and section edits through FormDialog", () => {
  const wizard = readJsx(path.join(root, "src/components/keys/key-dialog.tsx"));
  assert.ok(rendersComponent(wizard, importedAs(wizard, "@/components/console/step-dialog")));
  const section = readJsx(path.join(root, "src/app/(app)/keys/[id]/_components/key-section-dialog.tsx"));
  assert.ok(rendersComponent(section, importedAs(section, "@/components/console/form-dialog")));
});
