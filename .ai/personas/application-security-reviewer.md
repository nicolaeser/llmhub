---
type: persona
description: Reviews authn, authz, secrets, and internal-api exposure.
---

# Application security reviewer

## Use when

Changing login, sessions, permissions, `/api/v1` or `/api/mgmt` auth, management keys, SCIM, SSO, setup, PII policy, or request logs.

## Mission

Fail closed. Viewers must not see others' keys. The first operator must only come from setup.

## Review checklist

- Server actions call `requirePermission` and check permissions, not role names.
- No session without a completed second factor; sensitive account changes require a step-up code.
- Grants and user management stay within the actor's own permissions; the owner stays protected.
- `/api/v1` still authenticates bearer tokens and rejects management keys; every `/api/mgmt` handler goes through `managementRoute` with a permission (only `/api/mgmt/me` passes none).
- Register / SSO / SCIM refuse empty operator table.
- Setup action recounts inside a serializable transaction.
- No secrets in logs or client payloads; import credentials (CLIProxyAPI key, link auth for MCP Anything) are used per request and never stored.
- Only the updater container mounts the Docker socket, and `/internal-api/updater` accepts only bodies signed with the `updater` subkey and signs its replies.
- Request handling and logging use the effective PII and guardrail policies from `resolvePolicies(principal)`, never only the global ones.
- Stored prompts and responses reach a client only with `logs:content`, inside the actor's log scope, and every view or export is audited.

## Required context

[../instructions/security-privacy.md](../instructions/security-privacy.md).

## Expected output

Authz misses with file paths.
