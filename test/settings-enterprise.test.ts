import assert from "node:assert/strict";
import test from "node:test";
import { normalizeEnterprise, normalizeOidc } from "@/lib/gateway/settings";

test("normalizeOidc fills defaults", () => {
  assert.deepEqual(normalizeOidc({}), {
    enabled: false,
    issuer: "",
    client_id: "",
    redirect_url: "",
  });
  assert.equal(normalizeOidc({ enabled: true, issuer: "https://idp" }).enabled, true);
});

test("normalizeEnterprise keeps oidc and drops legacy api auth", () => {
  const ent = normalizeEnterprise({
    jwt: {
      enabled: true,
      issuer: "https://idp",
      jwks_url: "https://idp/jwks",
      audience: "hub",
    },
    custom_auth_url: "https://auth.example.com",
    oidc: {
      enabled: true,
      issuer: "https://idp/",
      client_id: "hub",
      redirect_url: "https://hub/sso/callback",
    },
  });
  assert.equal("jwt" in ent, false);
  assert.equal("custom_auth_url" in ent, false);
  assert.equal(ent.oidc?.enabled, true);
  assert.equal(ent.oidc?.client_id, "hub");
});

test("normalizeEnterprise keeps split retention and webhook secrets", () => {
  const ent = normalizeEnterprise({
    log_retention_days: 14,
    spend_retention_days: 365,
    audit_retention_days: 0,
    alert_webhooks: [{ id: "a", url: "https://a.test", secret: "whsec", events: ["budget_threshold"] }],
  });
  assert.equal(ent.log_retention_days, 14);
  assert.equal(ent.spend_retention_days, 365);
  assert.equal(ent.audit_retention_days, 0);
  assert.equal(ent.alert_webhooks?.[0]?.secret, "whsec");
});

test("normalizeEnterprise logs request content by default and keeps content retention", () => {
  const defaults = normalizeEnterprise({});
  assert.equal(defaults.log_content, true);
  assert.equal(defaults.content_retention_days, 0);
  const custom = normalizeEnterprise({ log_content: false, content_retention_days: 7 });
  assert.equal(custom.log_content, false);
  assert.equal(custom.content_retention_days, 7);
});
