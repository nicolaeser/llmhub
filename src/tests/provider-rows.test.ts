import assert from "node:assert/strict";
import test from "node:test";
import { accountMatches, accountMenuActions, accountRow } from "@/app/(app)/providers/_components/account-rows";
import {
  byProviderOrder,
  credentialState,
  providerMatches,
  providerMenuActions,
  providerRow,
  providerStatus,
} from "@/app/(app)/providers/_components/provider-rows";
import type { LimitSnapshot, LimitWindow, ProviderView } from "@/types/providers";

const NOW = Date.parse("2026-10-22T12:00:00Z");
const HOUR = 3_600_000;
const iso = (hours: number) => new Date(NOW + hours * HOUR).toISOString();

function provider(overrides: Partial<ProviderView> = {}): ProviderView {
  return {
    id: "claude-1",
    name: "Claude",
    kind: "claude",
    baseUrl: "",
    hasApiKey: false,
    enabled: true,
    restricted: false,
    internal: false,
    newModels: "auto",
    assignments: [],
    signIn: { account: "user@example.test", plan: "max", status: "active" },
    sharedVia: null,
    manageActive: false,
    discovered: [],
    policy: { zdr: false, retentionDays: null, region: "", noTraining: false },
    vertex: null,
    ...overrides,
  };
}

function plan(usedPercent: number, windowSeconds: number, hours: number): LimitWindow {
  return { scope: "", usedPercent, windowSeconds, resetsAt: iso(hours), limitReached: usedPercent >= 100 };
}

function entry(windows: LimitWindow[], extra: Partial<LimitSnapshot> = {}): LimitSnapshot {
  return {
    id: "claude-1",
    error: "",
    limits: { plan: "max", windows, credits: null, resetCredits: null, extraUsage: null, fetchedAt: iso(0) },
    version: 1,
    checkedAt: iso(0),
    nextAt: null,
    retryAt: null,
    ...extra,
  };
}

test("api providers report their credential and model count", () => {
  assert.equal(credentialState({ hasApiKey: false, vertex: null }), "missing");
  assert.equal(credentialState({ hasApiKey: true, vertex: null }), "stored");
  assert.equal(
    credentialState({
      hasApiKey: true,
      vertex: { credential: "service_account", account: "", project: "", location: "" },
    }),
    "service_account",
  );
  const row = providerRow(provider({ kind: "openai", hasApiKey: true, internal: true, discovered: [{ id: "a", name: "A" }] }));
  assert.deepEqual(row, { credential: "stored", models: 1, active: true, internal: true });
});

test("api provider menus stay empty for viewers and switch between pause and resume", () => {
  assert.deepEqual(providerMenuActions(false, { enabled: true }), []);
  assert.deepEqual(providerMenuActions(true, { enabled: true }), ["edit", "import", "pause", "disconnect"]);
  assert.deepEqual(providerMenuActions(true, { enabled: false }), ["edit", "import", "resume", "disconnect"]);
});

test("api providers sort active ones first, then by name", () => {
  const rows = [
    provider({ id: "c", name: "zeta", enabled: true }),
    provider({ id: "b", name: "Alpha", enabled: false }),
    provider({ id: "a", name: "beta", enabled: true }),
  ];
  assert.deepEqual(
    rows.sort(byProviderOrder).map((row) => row.id),
    ["a", "c", "b"],
  );
});

test("viewers keep details and limit refresh, managers get every former card action", () => {
  const active = accountRow(provider(), entry([plan(20, 18_000, 3)]), true, NOW);
  assert.deepEqual(accountMenuActions(false, { enabled: true }, active), ["details", "refresh"]);
  assert.deepEqual(accountMenuActions(true, { enabled: true }, active), [
    "details",
    "refresh",
    "edit",
    "access",
    "pause",
    "import",
    "disconnect",
  ]);
  const paused = accountRow(provider({ enabled: false }), entry([plan(20, 18_000, 3)]), true, NOW);
  assert.ok(accountMenuActions(true, { enabled: false }, paused).includes("resume"));
});

test("an expired sign-in offers sign-in instead of edit and no refresh", () => {
  const expired = accountRow(provider(), entry([], { error: "SIGN_IN_EXPIRED", limits: null }), true, NOW);
  assert.equal(expired.state, "expired");
  assert.equal(expired.needsSignIn, true);
  assert.equal(expired.refreshable, false);
  assert.deepEqual(accountMenuActions(false, { enabled: true }, expired), ["details"]);
  const actions = accountMenuActions(true, { enabled: true }, expired);
  assert.ok(actions.includes("signIn"));
  assert.ok(!actions.includes("edit"));
  assert.ok(!actions.includes("refresh"));
});

test("account rows carry a recovery time only while the account is at a limit", () => {
  const open = accountRow(provider(), entry([plan(40, 18_000, 2), plan(10, 604_800, 30)]), true, NOW);
  assert.equal(open.state, "available");
  assert.equal(open.recovery, null);
  const limited = accountRow(provider(), entry([plan(100, 18_000, 4), plan(10, 604_800, 30)]), true, NOW);
  assert.equal(limited.state, "limited");
  assert.equal(limited.recovery, NOW + 4 * HOUR);
  const weekly = accountRow(provider(), entry([plan(20, 18_000, 3), plan(100, 604_800, 100)]), true, NOW);
  assert.equal(weekly.state, "limited");
  assert.equal(weekly.recovery, NOW + 100 * HOUR);
});

test("account rows flag held refreshes and providers without limit reports", () => {
  const held = accountRow(provider(), entry([plan(5, 18_000, 1)], { retryAt: iso(1) }), true, NOW);
  assert.equal(held.held, true);
  const silent = accountRow(provider({ kind: "devin" }), undefined, false, NOW);
  assert.equal(silent.state, "connected");
  assert.equal(silent.refreshable, false);
  assert.deepEqual(accountMenuActions(false, { enabled: true }, silent), ["details"]);
});

test("a shared account without a manage link is flagged", () => {
  const shared = (manageActive: boolean) =>
    accountRow(provider({ sharedVia: "Team", manageActive }), undefined, true, NOW).manageOff;
  assert.equal(shared(false), true);
  assert.equal(shared(true), false);
  assert.equal(accountRow(provider({ sharedVia: null }), undefined, true, NOW).manageOff, false);
});

test("account search matches account, name, plan, link label, and extra labels", () => {
  const row = provider({ name: "Claude Work", sharedVia: "Design team" });
  assert.equal(accountMatches(row, ""), true);
  assert.equal(accountMatches(row, "USER@"), true);
  assert.equal(accountMatches(row, "work"), true);
  assert.equal(accountMatches(row, "max"), true);
  assert.equal(accountMatches(row, "design"), true);
  assert.equal(accountMatches(row, "claude code", ["Claude Code"]), true);
  assert.equal(accountMatches(row, "gemini"), false);
});

test("provider status folds a missing credential into the status", () => {
  const api = provider({ kind: "openai", signIn: null, hasApiKey: true });
  assert.equal(providerStatus(api), "active");
  assert.equal(providerStatus({ ...api, hasApiKey: false }), "missing");
  assert.equal(providerStatus({ ...api, hasApiKey: false, enabled: false }), "paused");
});

test("provider search matches name, kind, and translated labels", () => {
  const api = provider({ name: "Team OpenAI", kind: "openai", signIn: null });
  assert.equal(providerMatches(api, ""), true);
  assert.equal(providerMatches(api, "team"), true);
  assert.equal(providerMatches(api, "OPENAI"), true);
  assert.equal(providerMatches(api, "azure"), false);
  assert.equal(providerMatches(api, "kompatibel", ["OpenAI-kompatibel"]), true);
});
