import assert from "node:assert/strict";
import test from "node:test";
import { normalizeEnterprise, normalizeOidc, normalizeS3 } from "@/lib/settings/enterprise";

test("normalizeOidc fills defaults and drops the retired redirect override", () => {
  assert.deepEqual(normalizeOidc({}), {
    enabled: false,
    provider: "generic",
    issuer: "",
    client_id: "",
    scopes: "openid email profile",
    groups_claim: "",
    role_mappings: [],
    default_role_id: "",
    default_org_id: "",
    allowed_domains: [],
    sso_only: false,
  });
  const legacy = normalizeOidc({ enabled: true, issuer: "https://idp", redirect_url: "https://hub/sso/callback" });
  assert.equal(legacy.enabled, true);
  assert.equal("redirect_url" in legacy, false);
  const mapped = normalizeOidc({
    provider: "nope",
    role_mappings: [{ group: " admins ", role_id: "r1" }, { group: "", role_id: "r2" }, "junk"],
    allowed_domains: ["Example.COM", ""],
  });
  assert.equal(mapped.provider, "generic");
  assert.deepEqual(mapped.role_mappings, [{ group: "admins", role_id: "r1" }]);
  assert.deepEqual(mapped.allowed_domains, ["example.com"]);
});

test("normalizeS3 reads legacy switches into the new shape", () => {
  assert.deepEqual(normalizeS3({}), {
    preset: "aws",
    bucket: "",
    region: "us-east-1",
    endpoint: "",
    prefix: "",
    addressing: "auto",
    public_base_url: "",
  });
  const disabled = normalizeS3({ enabled: false, bucket: "hub", endpoint: "https://minio:9000", forcePathStyle: true });
  assert.equal(disabled.bucket, "");
  assert.equal(disabled.preset, "custom");
  assert.equal("forcePathStyle" in disabled, false);
  assert.equal("enabled" in disabled, false);
  const domain = normalizeS3({ enabled: true, bucket: "files.example.com", domain_bucket: true, addressing: "path" });
  assert.equal(domain.bucket, "files.example.com");
  assert.equal(domain.addressing, "domain");
  assert.equal("domain_bucket" in domain, false);
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
