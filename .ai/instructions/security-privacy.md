---
type: instruction
description: Load for authentication, sessions, two-factor, passkeys, roles, permissions, PII, or secret handling.
scope: repository
---

# Security and privacy

Load before changing sign-in, sessions, account security, roles, permissions, first-operator setup, virtual keys, PII, or environment secrets.

## Mandatory rules

- One secret, `APP_SECRET` (at least 32 characters). `src/lib/crypto.ts` derives HKDF-SHA256 subkeys: `signingSecret()` signs session cookies, OIDC state, and try-bearers; the `data` subkey seals TOTP secrets, provider keys, and secret settings and keys recovery-code HMACs.
- Sessions are opaque 256-bit tokens. The cookie is `token.hmac` (`src/lib/auth/cookie.ts`, HMAC with `signingSecret()`); the database stores only `sha256(token)` (`Session.tokenHash`). `src/proxy.ts` only checks the signature; `getSession` checks the row, 7-day idle and 30-day absolute expiry, a blocked user, and a completed second factor. Starting a session revokes the session the browser already held (`setSessionCookie`, `startSession`, SSO callback).
- Every session records its factor (`TOTP` | `RECOVERY` | `PASSKEY` | `SSO`). A session without a factor must be rejected.
- Two-factor authentication is mandatory for password sign-ins. `passwordSignIn` never creates a session; it issues a `LoginChallenge` (`VERIFY`, `ENROLL`, or `PASSWORD`) in a separate `SameSite=strict` cookie (`src/lib/auth/sign-in.ts`, `src/lib/auth/login-challenge.ts`). Setup and public registration issue an `ENROLL` challenge instead of a session. OIDC sign-ins count as the `SSO` factor.
- TOTP secrets are sealed with AES-256-GCM bound to the user id (`src/lib/auth/totp.ts`, `src/lib/crypto.ts` data subkey). Accepted codes advance `lastTimeStep` with a conditional write; recovery codes are keyed HMACs consumed with a conditional `usedAt` write; passkey counters advance with a conditional write.
- Every second-factor check (TOTP, recovery code, passkey, step-up, enrollment confirm) runs through `guardSecondFactor` (`src/lib/auth/second-factor.ts`): it reserves a `LoginAttempt` row before verifying, so parallel guesses cannot pass the lockout (10 per 15 minutes, 30 per 24 hours per user). A failure keeps the row; success clears the user's failures; unrelated errors release the reservation. Reaching the limit ends pending sign-ins and records `2fa.locked`.
- Password sign-in reserves attempts before hashing: 10 failures per account and client and 50 per account per 15 minutes (`reserveAttempts`), plus 30 sign-ins per client per minute. Passwordless passkey sign-in is limited to 20 per client and 120 overall per minute before a ceremony row is stored. Window limits use Redis when configured and a bounded in-memory map otherwise (`src/lib/rate-limit/window.ts`). Client keys come from `clientIp`, which trusts the last `X-Forwarded-For` hop, so account-wide limits must stay in place.
- Replacing the authenticator, regenerating recovery codes, adding or removing a passkey, setting another user's password, and resetting another user's two-factor require a step-up code (`requireStepUp`). Password and authenticator changes sign out every other session.
- One password policy (`src/lib/auth/password-policy.ts`) backs `newPasswordSchema` and every password write: 10 to 256 characters with a letter and a number (`WEAK_PASSWORD`), not a common, sequential, or repetitive password, and not containing the username or email name (`PASSWORD_GUESSABLE`). `parseAuthInput` and `inputErrorCode` surface these codes instead of `VALIDATION`.
- Passkeys use `@simplewebauthn` with the relying party from `NEXT_PUBLIC_APP_URL`; they are only offered for HTTPS domains or `localhost`. WebAuthn challenges live in `AuthCeremony` and are consumed once.
- Permissions come from the catalog in `src/lib/auth/permissions.ts` (domain plus `view` / `work` / `sensitive` level). Code checks permissions, never role names; `requirePermission` throws `AuthError("FORBIDDEN")`. Roles are editable permission bundles; `admin`, `operator`, `finance`, and `viewer` are templates seeded once and restorable.
- The setup user is the owner (`User.isOwner`): every permission, cannot be blocked, deleted, or re-roled. Nobody grants or manages beyond their own permissions (`src/lib/auth/grants.ts`); role and user edits use a `revision` fence.
- Management keys (`ManagementKey`, `src/lib/management/auth.ts`) are personal `/api` credentials: created on the account page with a step-up code and `assertCanGrant`, limited to `MANAGEMENT_PERMISSIONS` (no users, roles, settings, or tools), stored as `sha256` with an 8-character prefix, shown once, at most 25 per user, optional expiry. At request time the scope is intersected with the owner's current role; blocked owners and expired keys fail with `INVALID_API_KEY`. Create and revoke write `management_key.*` security events and the audit log.
- Security-relevant changes write `UserSecurityEvent` rows; console mutations also write the gateway audit log.
- First operator: `/internal-api/setup` (`src/app/internal-api/setup/_action.ts`). The layout redirects home when `prisma.user.count() > 0`; the action recounts inside a serializable transaction. Login and register must not redirect to setup.
- Public registration, invites, SSO upsert, and SCIM create must not insert the first user; they answer `SETUP_REQUIRED` while the user table is empty.
- OIDC uses the authorization code flow with PKCE (`S256`), a random `state` distinct from the `nonce`, and a signed, 10-minute state cookie that carries the nonce and code verifier (`src/lib/auth/oidc.ts`).
- Cookie-authenticated `POST` routes under `/internal-api/account` reject cross-site requests with `FORBIDDEN` (`isSameOriginRequest`, `src/lib/auth/request-origin.ts`). `/internal-api/account/expired` clears the cookie only when the session is invalid; logout also drops the pending login challenge and passkey ceremony.
- Self-registration is off by default (`Enterprise.registration_enabled`, Admin settings → Sign-in). When on, accounts get the `viewer` template and must enroll two-factor. The owner always signs in with password and second factor, independent of OIDC; SSO creates accounts on first sign-in regardless of the switch.
- Password reset needs `SMTP_URL`. Requests are limited to 10 per IP and 3 per email per hour (`consumeQuota`), answer the same whether the account exists, send mail in `after()`, keep one live token per user, and every successful reset deletes the user's tokens and sessions.
- Throttle rows in `LoginAttempt` are kept for 24 hours (`ATTEMPT_RETENTION_MS`) so the 24-hour second-factor window holds. The maintenance sweep also runs `purgeAuthRecords` (`src/lib/auth/cleanup.ts`): idle or expired sessions, expired or consumed login challenges, expired WebAuthn ceremonies, and abandoned authenticator enrollments.
- Return paths after login must stay in-app (`src/lib/auth/return-path.ts`).
- Request content (prompts and responses) is logged by default. It is off when `Enterprise.log_content` is false, when the key has `VirtualKey.logContent` false, or when the request's user has `User.logContent` false; the user switch also covers keys that user owns. `contentSkip` records the reason. Only `users:manage` changes a user's switch, and the owner is not manageable.
- Reading stored content requires `logs:content` (sensitive; only the `admin` template). Log rows stay scoped by `spend:read` / `spend:read-all`. Every detail view that returns content writes a `log.content_view` audit row.
- PII policy is global (`Enterprise.pii`) with optional per-organization and per-key overrides (`Organization.piiPolicy`, `VirtualKey.piiPolicy`; `null` inherits). Overrides are edited on the Guardrails page with `settings:manage` and audited as `pii.override`. Request handling and logging must use the effective policy from `resolvePii(principal)` (key, then organization, then global).
- While the effective PII policy is enabled, stored request and response content, the logged error, and the logged tag are masked with it, even when output redaction to the client is off. Each log records `piiMode`, `piiInput`, and `piiOutput`; requests stopped by block mode are logged with outcome `pii_blocked`. Request content logging is the product's audit store, not application logging.
- PII catalog matches Presidio-style ids in `src/lib/gateway/pii.ts`. Do not log raw passwords, codes, recovery codes, reset tokens or links, SCIM tokens, plaintext virtual keys, or email addresses; log user ids. Mail and SMTP failures log an error code or name, never the message.

## Sources of truth

- `src/lib/auth/`, `src/lib/management/auth.ts`, `src/lib/gateway/settings.ts` (`resolvePii`), `src/lib/rate-limit/window.ts`, `src/proxy.ts`, `src/types/auth.ts`, `src/types/security.ts`, `src/schemas/auth.ts`, `prisma/schema/auth.prisma`, `src/app/internal-api/setup/_action.ts`, `src/app/internal-api/account/`, `src/app/sso/`.

## Validation

`npm test` (auth-permissions, auth-cookie, auth-factors, auth-schemas, auth-flow, auth-request-guards, password, oidc, first-admin-setup, return-path, pii, pii-policy, request-log-record, management-api).
