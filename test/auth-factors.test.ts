import assert from "node:assert/strict";
import test from "node:test";
import { NobleCryptoPlugin, ScureBase32Plugin, TOTP } from "otplib";
import { digest, keyedDigest, open, seal } from "@/lib/crypto";
import {
  RECOVERY_CODE_COUNT,
  newRecoveryCodes,
  normalizeRecoveryCode,
  recoveryCodeHash,
} from "@/lib/auth/recovery-codes";
import { matchTotp, newTotpSecret, openTotpSecret, sealTotpSecret } from "@/lib/auth/totp";

const generator = new TOTP({
  period: 30,
  digits: 6,
  algorithm: "sha1",
  crypto: new NobleCryptoPlugin(),
  base32: new ScureBase32Plugin(),
});

test("TOTP accepts a current code once and rejects replays", async () => {
  const secret = newTotpSecret();
  const epoch = 1_800_000_000;
  const code = await generator.generate({ secret, epoch });
  const step = await matchTotp(secret, code, null, epoch);
  assert.equal(typeof step, "number");
  assert.equal(await matchTotp(secret, code, step, epoch), null);
  assert.equal(await matchTotp(secret, "12345", null, epoch), null);
  assert.equal(await matchTotp(secret, "abcdef", null, epoch), null);
});

test("TOTP tolerates one step of clock drift but not more", async () => {
  const secret = newTotpSecret();
  const epoch = 1_800_000_000;
  const previous = await generator.generate({ secret, epoch: epoch - 30 });
  const stale = await generator.generate({ secret, epoch: epoch - 120 });
  assert.notEqual(await matchTotp(secret, previous, null, epoch), null);
  assert.equal(await matchTotp(secret, stale, null, epoch), null);
});

test("sealed TOTP secrets are bound to their user", () => {
  const secret = newTotpSecret();
  const sealed = sealTotpSecret("user-a", secret);
  assert.doesNotMatch(sealed, new RegExp(secret));
  assert.equal(openTotpSecret("user-a", sealed), secret);
  assert.throws(() => openTotpSecret("user-b", sealed), /TWO_FACTOR_CHANGED/);
});

test("sealed secrets reject tampering", () => {
  const sealed = seal("value");
  assert.notEqual(sealed, "value");
  assert.equal(open(sealed), "value");
  const tampered = `${sealed.slice(0, -2)}${sealed.at(-2) === "A" ? "B" : "A"}${sealed.at(-1)}`;
  assert.equal(open(tampered), "");
});

test("recovery codes are unique, normalized, and stored as keyed hashes", () => {
  const { codes, hashes } = newRecoveryCodes();
  assert.equal(codes.length, RECOVERY_CODE_COUNT);
  assert.equal(new Set(codes).size, RECOVERY_CODE_COUNT);
  for (const code of codes) assert.match(code, /^[0-9a-f]{8}-[0-9a-f]{8}$/);
  assert.equal(hashes[0], recoveryCodeHash(codes[0]));
  assert.notEqual(hashes[0], digest(codes[0]));
  assert.equal(keyedDigest("recovery-code", codes[0]), hashes[0]);
  assert.equal(normalizeRecoveryCode(` ${codes[0].toUpperCase().replace("-", " ")} `), codes[0]);
  assert.equal(normalizeRecoveryCode("not-a-code"), null);
});
