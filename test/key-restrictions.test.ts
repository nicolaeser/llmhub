import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { GateError } from "@/lib/gateway/errors";
import { allowAccessTime, allowEndpoint } from "@/lib/gateway/gate";
import {
  accessOpen,
  accessWindowsOf,
  allowedEndpointsOf,
  endpointAllowed,
  endpointOf,
} from "@/lib/gateway/key-restrictions";
import { sessionPrincipal } from "@/lib/gateway/principal";
import { apiKeyCreateSchema, apiKeyUpdateSchema } from "@/schemas/management";
import { createKeySchema } from "@/schemas/keys";
import type { Principal, VirtualKeyView } from "@/types/gateway";
import type { AccessWindow, KeyEndpoint } from "@/types/keys";

const root = fileURLToPath(new URL("..", import.meta.url));
const v1 = path.join(root, "src/app/v1");

function routePaths(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return routePaths(full);
    if (entry.name !== "route.ts") return [];
    const rel = path.relative(v1, path.dirname(full)).split(path.sep).join("/");
    return [`/v1/${rel.replace(/\[[^\]]+\]/g, "x")}`];
  });
}

function keyPrincipal(over: Partial<VirtualKeyView>): Principal {
  const key: VirtualKeyView = {
    token_id: "k1",
    key_name: "sk-hub-abcde",
    key_alias: "embed-only",
    user_id: "",
    team_id: "",
    org_id: "",
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
    allowed_endpoints: [],
    access_windows: [],
    access_time_zone: "UTC",
    blocked: false,
    pii: null,
    log_content: true,
    created_at: "",
    ...over,
  };
  return { actor: key.key_name, key, teamId: "", orgId: "", userId: "", memberId: "", models: [], routeLimits: {} };
}

const weekdays: AccessWindow = { days: ["mon", "tue", "wed", "thu", "fri"], start: "00:00", end: "00:00" };
const officeHours: AccessWindow = { days: ["mon", "tue", "wed", "thu", "fri"], start: "08:00", end: "17:00" };
const mondayNight: AccessWindow = { days: ["mon"], start: "22:00", end: "06:00" };

test("every /v1 route belongs to an endpoint group except the always-open model list", () => {
  const unmapped = routePaths(v1).filter((route) => endpointOf(route) === null);
  assert.deepEqual(unmapped.sort(), ["/v1/models", "/v1/models/x"]);
  assert.equal(endpointOf("/v1/messages/count_tokens"), "chat");
  assert.equal(endpointOf("/v1/responses/x/input_items"), "chat");
  assert.equal(endpointOf("/v1/images/edits"), "images");
  assert.equal(endpointOf("/v1/constructor"), null);
});

test("endpoint restrictions allow only the listed groups and fail closed on unknown paths", () => {
  const embeddings: KeyEndpoint[] = ["embeddings"];
  assert.equal(endpointAllowed([], "/v1/chat/completions"), true);
  assert.equal(endpointAllowed(embeddings, "/v1/embeddings"), true);
  assert.equal(endpointAllowed(embeddings, "/v1/models"), true);
  assert.equal(endpointAllowed(embeddings, "/v1/models/x"), true);
  assert.equal(endpointAllowed(embeddings, "/v1/chat/completions"), false);
  assert.equal(endpointAllowed(embeddings, "/v1/responses"), false);
  assert.equal(endpointAllowed(embeddings, "/v1/unknown"), false);
  assert.equal(endpointAllowed(embeddings, "/internal-api/playground/chat"), false);
  assert.equal(endpointAllowed(["chat", "files", "batches"], "/v1/files/x/content"), true);
});

test("an all-day weekday window follows the key's time zone", () => {
  const berlin = "Europe/Berlin";
  assert.equal(accessOpen([weekdays], berlin, new Date("2026-10-09T21:30:00Z")), true);
  assert.equal(accessOpen([weekdays], berlin, new Date("2026-10-09T22:30:00Z")), false);
  assert.equal(accessOpen([weekdays], "UTC", new Date("2026-10-09T22:30:00Z")), true);
  assert.equal(accessOpen([weekdays], berlin, new Date("2026-10-11T22:30:00Z")), true);
  assert.equal(accessOpen([], berlin, new Date("2026-10-10T12:00:00Z")), true);
});

test("windows end before their end time and overnight windows run into the next day", () => {
  assert.equal(accessOpen([officeHours], "UTC", new Date("2026-10-09T08:00:00Z")), true);
  assert.equal(accessOpen([officeHours], "UTC", new Date("2026-10-09T16:59:00Z")), true);
  assert.equal(accessOpen([officeHours], "UTC", new Date("2026-10-09T17:00:00Z")), false);
  assert.equal(accessOpen([officeHours], "UTC", new Date("2026-10-10T10:00:00Z")), false);
  assert.equal(accessOpen([mondayNight], "UTC", new Date("2026-10-05T23:00:00Z")), true);
  assert.equal(accessOpen([mondayNight], "UTC", new Date("2026-10-06T05:59:00Z")), true);
  assert.equal(accessOpen([mondayNight], "UTC", new Date("2026-10-06T06:00:00Z")), false);
  assert.equal(accessOpen([mondayNight], "UTC", new Date("2026-10-05T05:00:00Z")), false);
  assert.equal(accessOpen([mondayNight], "UTC", new Date("2026-10-06T23:00:00Z")), false);
  assert.equal(accessOpen([officeHours, mondayNight], "UTC", new Date("2026-10-05T23:00:00Z")), true);
});

test("equal start and end cover 24 hours from the start", () => {
  const fromEight: AccessWindow = { days: ["sat"], start: "08:00", end: "08:00" };
  assert.equal(accessOpen([fromEight], "UTC", new Date("2026-10-10T07:59:00Z")), false);
  assert.equal(accessOpen([fromEight], "UTC", new Date("2026-10-10T08:00:00Z")), true);
  assert.equal(accessOpen([fromEight], "UTC", new Date("2026-10-11T07:59:00Z")), true);
  assert.equal(accessOpen([fromEight], "UTC", new Date("2026-10-11T08:00:00Z")), false);
});

test("stored restrictions are normalized and invalid entries are dropped", () => {
  assert.deepEqual(allowedEndpointsOf(["files", "nope", "chat"]), ["chat", "files"]);
  assert.deepEqual(allowedEndpointsOf("chat"), []);
  assert.deepEqual(
    accessWindowsOf([
      { days: ["fri", "mon", "xyz"], start: "08:00", end: "17:00" },
      { days: [], start: "08:00", end: "17:00" },
      { days: ["mon"], start: "8:00", end: "17:00" },
      "mon",
    ]),
    [{ days: ["mon", "fri"], start: "08:00", end: "17:00" }],
  );
});

test("the gate rejects keys outside their endpoints or time windows", () => {
  const restricted = keyPrincipal({
    allowed_endpoints: ["embeddings"],
    access_windows: [officeHours],
    access_time_zone: "UTC",
  });
  assert.doesNotThrow(() => allowEndpoint(restricted, "/v1/embeddings"));
  assert.throws(
    () => allowEndpoint(restricted, "/v1/chat/completions"),
    (err: unknown) => err instanceof GateError && err.status === 403 && err.code === "endpoint_not_allowed",
  );
  assert.throws(
    () => allowEndpoint(restricted, "/v1/responses", "endpoint"),
    (err: unknown) => err instanceof GateError && err.param === "endpoint",
  );
  assert.doesNotThrow(() => allowAccessTime(restricted, new Date("2026-10-09T09:00:00Z")));
  assert.throws(
    () => allowAccessTime(restricted, new Date("2026-10-10T09:00:00Z")),
    (err: unknown) => err instanceof GateError && err.status === 403 && err.code === "outside_access_window",
  );
  const session = sessionPrincipal({ id: "u1", orgId: null });
  assert.doesNotThrow(() => allowEndpoint(session, "/v1/chat/completions"));
  assert.doesNotThrow(() => allowAccessTime(session, new Date("2026-10-10T09:00:00Z")));
});

test("key schemas validate endpoints, windows, and time zones", () => {
  const parsed = createKeySchema.parse({
    alias: "embed",
    allowedEndpoints: ["files", "embeddings", "files"],
    accessWindows: [{ days: ["fri", "mon"], start: "07:00", end: "19:00" }],
    accessTimeZone: "Europe/Berlin",
  });
  assert.deepEqual(parsed.allowedEndpoints, ["embeddings", "files"]);
  assert.deepEqual(parsed.accessWindows, [{ days: ["mon", "fri"], start: "07:00", end: "19:00" }]);
  assert.equal(createKeySchema.parse({ alias: "plain" }).accessTimeZone, "UTC");
  assert.equal(createKeySchema.safeParse({ alias: "x", allowedEndpoints: ["models"] }).success, false);
  assert.equal(createKeySchema.safeParse({ alias: "x", accessWindows: [{ days: [], start: "07:00", end: "19:00" }] }).success, false);
  assert.equal(createKeySchema.safeParse({ alias: "x", accessWindows: [{ days: ["mon"], start: "24:00", end: "19:00" }] }).success, false);
  assert.equal(createKeySchema.safeParse({ alias: "x", accessTimeZone: "Mars/Olympus" }).success, false);

  const api = apiKeyCreateSchema.parse({
    alias: "ci",
    allowed_endpoints: ["embeddings"],
    access_windows: [{ days: ["mon"], start: "08:00", end: "17:00" }],
  });
  assert.deepEqual(api.allowed_endpoints, ["embeddings"]);
  assert.equal(api.access_time_zone, "UTC");
  assert.equal(apiKeyUpdateSchema.safeParse({ access_windows: [{ days: ["mon"], start: "08:00" }] }).success, false);
  assert.equal(apiKeyUpdateSchema.safeParse({ access_windows: [{ days: ["mon"], start: "08:00", end: "17:00", tz: "UTC" }] }).success, false);
});
