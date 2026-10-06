import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const file = (relative: string) => readFile(path.join(root, relative), "utf8");

function body(source: string, name: string) {
  const start = source.search(new RegExp(`export (async )?function ${name}[(<]`));
  assert.ok(start >= 0, name);
  const next = source.indexOf("\nexport ", start + 1);
  return source.slice(start, next === -1 ? undefined : next);
}

test("the password step never creates a session and is throttled per client and per account", async () => {
  const source = await file("src/lib/auth/sign-in.ts");
  const passwordStep = body(source, "passwordSignIn");
  assert.doesNotMatch(passwordStep, /startSession|sessions:/);
  assert.match(passwordStep, /issueLoginChallenge\(user\.id, "ENROLL"\)/);
  assert.match(passwordStep, /issueLoginChallenge\(user\.id, "VERIFY"\)/);
  assert.match(passwordStep, /assertRequestRate\(`login:/);
  assert.match(passwordStep, /reserveAttempts\(\[/);
  assert.match(passwordStep, /key: throttleKey/);
  assert.match(passwordStep, /key: account/);
  assert.ok(passwordStep.indexOf("reserveAttempts") < passwordStep.indexOf("checkCredentials"));
  assert.match(source, /dummyHash/);
});

test("sessions require a completed second factor and an unblocked user", async () => {
  const source = await file("src/lib/auth/session.ts");
  const loader = body(source, "getSession");
  assert.match(loader, /!factor/);
  assert.match(loader, /row\.user\.blocked/);
  assert.match(loader, /SESSION_IDLE_TTL_MS/);
  assert.match(loader, /tokenHash: digest\(token\)/);
  assert.match(body(source, "startSession"), /revokeSessionCookie/);
  assert.match(body(source, "setSessionCookie"), /revokeSessionCookie/);
});

test("second factors are single use and reserve an attempt before verification", async () => {
  const source = await file("src/lib/auth/second-factor.ts");
  assert.match(source, /lastTimeStep: \{ lt: step \}/);
  assert.match(source, /usedAt: null/);
  const guard = body(source, "guardSecondFactor");
  assert.ok(guard.indexOf("reserveSecondFactorAttempt") < guard.indexOf("verify()"));
  assert.match(guard, /releaseAttempts\(reservation\)/);
  assert.match(guard, /secondFactorLockReached/);
  assert.match(body(source, "verifySecondFactor"), /guardSecondFactor/);
  const passkeys = await file("src/lib/auth/passkeys.ts");
  assert.match(passkeys, /counter: passkey\.counter/);
  assert.match(passkeys, /requireUserVerification: true/);
  assert.match(body(passkeys, "verifyPasskeyAssertion"), /guardSecondFactor/);
  const [signIn, account] = await Promise.all([
    file("src/lib/auth/sign-in.ts"),
    file("src/lib/auth/account-security.ts"),
  ]);
  assert.match(body(signIn, "confirmEnrollment"), /guardSecondFactor/);
  assert.match(body(account, "confirmTotpReplacement"), /guardSecondFactor/);
  for (const source of [signIn, account]) assert.doesNotMatch(source, /assertSecondFactorAllowed/);
});

test("attempt reservations count before the check and release on unrelated errors", async () => {
  const source = await file("src/lib/auth/throttle.ts");
  const reserve = body(source, "reserveAttempts");
  assert.ok(reserve.indexOf("loginAttempt.create") < reserve.indexOf("attemptsSince"));
  assert.match(reserve, /releaseAttempts\(ids\)/);
  assert.match(body(source, "consumeQuota"), /reserveAttempts/);
});

test("passwordless passkey sign-in is rate limited before it stores a ceremony", async () => {
  const source = await file("src/lib/auth/sign-in.ts");
  const options = body(source, "passwordlessOptions");
  assert.ok(options.indexOf("assertPasswordlessRate") < options.indexOf("startPasswordlessCeremony"));
  assert.match(body(source, "verifyPasswordless"), /assertPasswordlessRate/);
  assert.match(source, /assertRequestRate\("passkey-login"/);
});

test("setup and registration start two-factor enrollment instead of a session", async () => {
  const [setup, register] = await Promise.all([
    file("src/app/internal-api/setup/_action.ts"),
    file("src/app/internal-api/account/register/route.ts"),
  ]);
  for (const source of [setup, register]) {
    assert.match(source, /issueEnrollmentChallenge/);
    assert.doesNotMatch(source, /createSession|startSession/);
  }
  assert.match(setup, /isOwner: true/);
  assert.match(register, /SETUP_REQUIRED/);
});

test("sensitive account actions require a step-up code", async () => {
  const source = await file("src/lib/auth/account-security.ts");
  for (const name of ["startTotpReplacement", "regenerateRecoveryCodes", "startPasskeyRegistration", "removeOwnPasskey"]) {
    assert.match(body(source, name), /requireStepUp/, name);
  }
  const users = await file("src/lib/auth/users.ts");
  assert.match(body(users, "resetUserTwoFactor"), /requireStepUp/);
  assert.match(body(users, "resetUserTwoFactor"), /clearSecondFactorFailures/);
  assert.match(body(users, "setUserPassword"), /requireStepUp/);
});

test("new passwords are checked against the account's own identifiers", async () => {
  const [signIn, account, users, reset] = await Promise.all([
    file("src/lib/auth/sign-in.ts"),
    file("src/lib/auth/account-security.ts"),
    file("src/lib/auth/users.ts"),
    file("src/app/internal-api/account/reset-password/route.ts"),
  ]);
  assert.match(body(signIn, "completePasswordChange"), /assertPasswordPolicy/);
  assert.match(body(account, "changeOwnPassword"), /assertPasswordPolicy/);
  assert.match(body(users, "setUserPassword"), /assertPasswordPolicy/);
  assert.match(reset, /passwordPolicyIssue\(body\.data\.password, \[row\.user\.email, row\.user\.username\]\)/);
  assert.match(reset, /PASSWORD_REUSED/);
});

test("cookie-authenticated account routes reject cross-site requests", async () => {
  for (const route of ["logout", "register", "forgot-password", "reset-password"]) {
    const source = await file(`src/app/internal-api/account/${route}/route.ts`);
    assert.match(source, /isSameOriginRequest\(req\.headers/, route);
  }
  const expired = await file("src/app/internal-api/account/expired/route.ts");
  assert.ok(expired.indexOf("getSession") < expired.indexOf("clearedSessionCookieOptions()"));
});

test("SSO uses PKCE, a separate state, and rotates the browser session", async () => {
  const [login, callback] = await Promise.all([
    file("src/app/sso/login/route.ts"),
    file("src/app/sso/callback/route.ts"),
  ]);
  assert.match(login, /buildAuthorizationUrl\(disc, resolved, state\)/);
  assert.match(callback, /verifyOidcState\(\{ cookie, state \}\)/);
  assert.match(callback, /verifier: verified\.verifier/);
  assert.match(callback, /revokeSessionCookie/);
});

test("the maintenance sweep purges stale sign-in records", async () => {
  const [jobs, cleanup] = await Promise.all([
    file("src/worker/jobs.ts"),
    file("src/lib/auth/cleanup.ts"),
  ]);
  assert.match(jobs, /purgeAuthRecords\(now\)/);
  assert.match(cleanup, /loginChallenge\.deleteMany/);
  assert.match(cleanup, /authCeremony\.deleteMany/);
  assert.match(cleanup, /SESSION_IDLE_TTL_MS/);
});

test("permission guards fail with a translated error code", async () => {
  const source = await file("src/lib/auth/guards.ts");
  assert.match(body(source, "requirePermission"), /new AuthError\("FORBIDDEN"\)/);
});
