import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type AddressInfo } from "node:net";
import test, { after, before, beforeEach } from "node:test";
import { alertMail } from "@/lib/alerts/format";
import { alertEmailsSchema } from "@/schemas/settings";
import type { AuthenticatedSession, Permission } from "@/types/auth";

const db = {
  settings: new Map<string, string>(),
  audit: [] as { action: string; afterJson: string }[],
};

(globalThis as { prisma?: unknown }).prisma = {
  setting: {
    findUnique: async ({ where }: { where: { key: string } }) => {
      const value = db.settings.get(where.key);
      return value === undefined ? null : { key: where.key, value };
    },
    upsert: async ({ where, update }: { where: { key: string }; update: { value: string } }) => {
      db.settings.set(where.key, update.value);
    },
  },
  gatewayAuditLog: {
    create: async ({ data }: { data: (typeof db.audit)[number] }) => {
      db.audit.push(data);
      return data;
    },
  },
};
delete process.env.REDIS_URL;

const smtp = { recipients: [] as string[], messages: [] as string[], reject: "", waiters: [] as (() => void)[] };

const smtpServer = createServer((socket) => {
  socket.setEncoding("utf8");
  socket.on("error", () => undefined);
  if (smtp.reject) {
    socket.end(`${smtp.reject}\r\n`);
    socket.on("close", () => smtp.waiters.splice(0).forEach((wake) => wake()));
    return;
  }
  socket.write("220 fake.test ready\r\n");
  let buffer = "";
  let data: string[] | null = null;
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    for (let end = buffer.indexOf("\r\n"); end >= 0; end = buffer.indexOf("\r\n")) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      if (data) {
        if (line !== ".") {
          data.push(line);
          continue;
        }
        smtp.messages.push(data.join("\n"));
        data = null;
        socket.write("250 queued\r\n");
        continue;
      }
      const verb = line.split(" ")[0].toUpperCase();
      if (verb === "RCPT") smtp.recipients.push(line);
      if (verb === "DATA") data = [];
      socket.write(verb === "DATA" ? "354 go ahead\r\n" : verb === "QUIT" ? "221 bye\r\n" : "250 ok\r\n");
      if (verb === "QUIT") socket.end();
    }
  });
  socket.on("close", () => smtp.waiters.splice(0).forEach((wake) => wake()));
});

before(async () => {
  smtpServer.listen(0, "127.0.0.1");
  await once(smtpServer, "listening");
  process.env.SMTP_URL = `smtp://127.0.0.1:${(smtpServer.address() as AddressInfo).port}`;
  process.env.NEXT_PUBLIC_APP_URL = "https://hub.example.test";
});

after(() => {
  smtpServer.close();
});

beforeEach(() => {
  db.settings = new Map();
  db.audit = [];
  Object.assign(smtp, { recipients: [], messages: [], reject: "" });
});

function enterprise(value: Record<string, unknown>) {
  db.settings.set("enterprise", JSON.stringify(value));
}

async function audited(action: string) {
  for (let i = 0; i < 100 && !db.audit.some((row) => row.action === action); i += 1) {
    await new Promise<void>((resolve) => {
      smtp.waiters.push(resolve);
      setTimeout(resolve, 20);
    });
  }
  return db.audit.filter((row) => row.action === action).map((row) => JSON.parse(row.afterJson));
}

function caller(permissions: Permission[]): AuthenticatedSession {
  return {
    error: false,
    sessionId: "",
    user: { id: "u1", username: "operator", orgId: null } as AuthenticatedSession["user"],
    isOwner: false,
    role: null,
    permissions,
    secondFactor: "TOTP",
    ipAddress: null,
    userAgent: null,
  };
}

test("alertMail builds the subject and a plain text body with a console link", () => {
  const mail = alertMail(
    { id: "a1", event: "error_rate_spike", message: "all models: error rate 23.4%", ts: "2026-11-03T10:00:00.000Z" },
    "https://hub.example.test/",
  );
  assert.equal(mail.subject, "LLM Hub: Error rate spike");
  assert.equal(
    mail.text,
    [
      "all models: error rate 23.4%",
      "",
      "--",
      "Event: error_rate_spike",
      "Time: 2026-11-03T10:00:00.000Z",
      "Alert ID: a1",
      "Open LLM Hub: https://hub.example.test/logs",
      "Change alert emails: https://hub.example.test/settings?tab=logging",
    ].join("\n"),
  );
  assert.match(alertMail({ id: "a2", event: "key_expiring", message: "x", ts: "t" }, "https://hub.example.test").text, /Open LLM Hub: https:\/\/hub\.example\.test\/keys/);
});

test("alertMail renders an escaped HTML alternative with the console link", () => {
  const { html } = alertMail(
    { id: "a3", event: "pii_blocked", message: 'key <script>alert("x")</script> & co', ts: "2026-11-03T10:00:00.000Z" },
    "https://hub.example.test/",
  );
  assert.match(html, /^<!DOCTYPE html>/i);
  assert.doesNotMatch(html, /<script/i);
  assert.match(html, /key &lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt; &amp; co/);
  assert.match(html, /href="https:\/\/hub\.example\.test\/logs"/);
  assert.match(html, /Request blocked by PII policy/);
});

test("alertEmailsSchema bounds recipients, rejects line breaks, and needs an event", () => {
  const ok = alertEmailsSchema.safeParse({ recipients: [" Ops@Example.com ", "ops@example.com"], events: ["latency_spike"] });
  assert.equal(ok.success, true);
  assert.deepEqual(ok.data?.recipients, ["ops@example.com"]);
  assert.equal(alertEmailsSchema.safeParse({ recipients: [], events: [] }).success, true);
  assert.equal(alertEmailsSchema.safeParse({ recipients: ["ops@example.com"], events: [] }).success, false);
  assert.equal(alertEmailsSchema.safeParse({ recipients: ["ops@example.com\r\nBcc: x@y"], events: ["latency_spike"] }).success, false);
  assert.equal(alertEmailsSchema.safeParse({ recipients: ["no-at-sign"], events: ["latency_spike"] }).success, false);
  const eleven = Array.from({ length: 11 }, (_, i) => `ops${i}@example.com`);
  assert.equal(alertEmailsSchema.safeParse({ recipients: eleven, events: ["latency_spike"] }).success, false);
});

test("fireAlert mails subscribed events once per event per throttle window", async () => {
  const { fireAlert } = await import("@/lib/alerts/notify");
  enterprise({ alert_emails: { recipients: ["ops@example.com", "sre@example.com"], events: ["latency_spike", "key_blocked"] } });

  await fireAlert("budget_threshold", "team crossed 80%");
  await fireAlert("latency_spike", "model gpt-5: p95 latency 45.2 s");
  await fireAlert("latency_spike", "model claude: p95 latency 50.0 s");
  const delivered = await audited("alert_delivered");

  assert.deepEqual(delivered, [{ channel: "email", event: "latency_spike", recipients: 2 }]);
  assert.deepEqual(smtp.recipients, ["RCPT TO:<ops@example.com>", "RCPT TO:<sre@example.com>"]);
  assert.equal(smtp.messages.length, 1);
  assert.match(smtp.messages[0], /Subject: LLM Hub: Latency spike/);
  assert.match(smtp.messages[0], /model gpt-5: p95 latency 45\.2 s/);
  assert.match(smtp.messages[0], /Open LLM Hub: https:\/\/hub\.example\.test\/logs/);

  db.audit = [];
  await fireAlert("key_blocked", "key ci was blocked by ops");
  assert.deepEqual(await audited("alert_delivered"), [{ channel: "email", event: "key_blocked", recipients: 2 }]);
});

test("fireAlert records a failed alert e-mail without recipient addresses", async () => {
  const { fireAlert } = await import("@/lib/alerts/notify");
  smtp.reject = "554 no service for ops@example.com";
  enterprise({ alert_emails: { recipients: ["ops@example.com"], events: ["error_rate_spike"] } });

  await fireAlert("error_rate_spike", "all models: error rate 23.4%");
  const failed = await audited("alert_failed");

  assert.deepEqual(failed, [{ channel: "email", event: "error_rate_spike", recipients: 1, error: "SMTP_554" }]);
  assert.doesNotMatch(JSON.stringify(failed), /ops@example\.com/);
});

test("saveLogging validates and stores alert e-mails and clamps the traffic rules", async () => {
  const { runAsPrincipal } = await import("@/lib/auth/delegation");
  const { loadLogging, saveLogging } = await import("@/lib/settings/logging-alerts");
  const admin = caller(["settings:read", "settings:manage"]);
  const fresh = await runAsPrincipal(admin, () => loadLogging());
  assert.equal(fresh.mailEnabled, true);
  assert.deepEqual(fresh.alertEmails, { recipients: [], events: [] });
  assert.deepEqual(
    {
      errorRatePercent: fresh.alertRules.errorRatePercent,
      trafficWindowMinutes: fresh.alertRules.trafficWindowMinutes,
      trafficMinRequests: fresh.alertRules.trafficMinRequests,
      latencyP95Ms: fresh.alertRules.latencyP95Ms,
      latencyFactor: fresh.alertRules.latencyFactor,
    },
    { errorRatePercent: 10, trafficWindowMinutes: 15, trafficMinRequests: 50, latencyP95Ms: 30_000, latencyFactor: 3 },
  );
  const base = {
    alertWebhooks: [],
    alertRules: fresh.alertRules,
    alertEmails: fresh.alertEmails,
    logRetentionDays: fresh.logRetentionDays,
    spendRetentionDays: fresh.spendRetentionDays,
    usageRetentionDays: fresh.usageRetentionDays,
    auditRetentionDays: fresh.auditRetentionDays,
    securityRetentionDays: fresh.securityRetentionDays,
    objectRetentionDays: fresh.objectRetentionDays,
    fileRetentionDays: fresh.fileRetentionDays,
    contentRetentionDays: fresh.contentRetentionDays,
    logArchive: false,
    logContent: true,
  };

  await assert.rejects(
    runAsPrincipal(admin, () =>
      saveLogging({ ...base, alertEmails: { recipients: ["not-an-address"], events: ["latency_spike"] } }),
    ),
    /ALERT_RECIPIENTS_INVALID/,
  );
  await assert.rejects(
    runAsPrincipal(admin, () => saveLogging({ ...base, alertEmails: { recipients: ["ops@example.com"], events: [] } })),
    /VALIDATION/,
  );

  const saved = await runAsPrincipal(admin, () =>
    saveLogging({
      ...base,
      alertRules: {
        ...fresh.alertRules,
        errorRatePercent: 250,
        trafficWindowMinutes: 1,
        trafficMinRequests: 0,
        latencyP95Ms: 12_000.6,
        latencyFactor: 0.5,
      },
      alertEmails: { recipients: ["Ops@Example.com", "ops@example.com"], events: ["latency_spike", "error_rate_spike"] },
    }),
  );
  assert.deepEqual(saved.alertEmails, { recipients: ["ops@example.com"], events: ["error_rate_spike", "latency_spike"] });
  assert.equal(saved.alertRules.errorRatePercent, 100);
  assert.equal(saved.alertRules.trafficWindowMinutes, 5);
  assert.equal(saved.alertRules.trafficMinRequests, 1);
  assert.equal(saved.alertRules.latencyP95Ms, 12_000);
  assert.equal(saved.alertRules.latencyFactor, 1);
});
