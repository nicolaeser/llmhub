import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { LOGIN_JOURNAL_KEEP, LoginJournal } from "@/lib/gateway/upstreams/login-journal";
import type { LoginJournalEntry } from "@/types/providers";

function entry(providerId: string, refreshedAt: number, refresh = `r-${refreshedAt}`): LoginJournalEntry {
  return {
    providerId,
    kind: "codex",
    refreshedAt,
    session: {
      tokens: { access: `a-${refreshedAt}`, refresh, accountId: "acct_1", residency: "" },
      expiresAt: refreshedAt + 3_600_000,
      account: "dev@example.com",
      plan: "pro",
    },
  };
}

async function withJournal(run: (journal: LoginJournal, dir: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), "llmhub-login-journal-"));
  try {
    await run(new LoginJournal(dir), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("a journal entry is sealed, private, and read back as the newest session", async () => {
  await withJournal(async (journal, dir) => {
    assert.equal(await journal.record(entry("prov_1", 1_000, "secret-refresh")), true);
    assert.equal(await journal.record(entry("prov_1", 2_000, "newer-refresh")), true);
    assert.equal(await journal.latestStamp("prov_1"), 2_000);
    assert.equal((await journal.latest("prov_1"))?.session.tokens.refresh, "newer-refresh");
    const files = await readdir(path.join(dir, "prov_1"));
    assert.equal(files.length, 2);
    for (const name of files) {
      const text = await readFile(path.join(dir, "prov_1", name), "utf8");
      assert.match(text, /^enc1:/);
      assert.doesNotMatch(text, /refresh|dev@example\.com/);
      assert.equal((await stat(path.join(dir, "prov_1", name))).mode & 0o777, 0o600);
    }
    assert.equal((await stat(path.join(dir, "prov_1"))).mode & 0o777, 0o700);
    assert.deepEqual(await journal.providers(), ["prov_1"]);
  });
});

test("the journal keeps the newest entries and skips one it cannot read", async () => {
  await withJournal(async (journal, dir) => {
    for (const stamp of [1_000, 2_000, 3_000, 4_000, 5_000]) await journal.record(entry("prov_2", stamp));
    const names = (await readdir(path.join(dir, "prov_2"))).sort();
    assert.equal(names.length, LOGIN_JOURNAL_KEEP);
    assert.deepEqual(names.map((name) => Number(name.slice(0, 13))), [3_000, 4_000, 5_000]);
    await writeFile(path.join(dir, "prov_2", "0000000009000-00000000000000ff.login"), "enc1:broken", "utf8");
    assert.equal(await journal.latestStamp("prov_2"), 9_000);
    assert.equal((await journal.latest("prov_2"))?.refreshedAt, 5_000);
  });
});

test("the journal stays off without its directory and refuses ids that are not plain", async () => {
  await withJournal(async (_journal, dir) => {
    const absent = new LoginJournal(path.join(dir, "missing"));
    assert.equal(await absent.available(), false);
    assert.equal(await absent.record(entry("prov_3", 1_000)), false);
    assert.equal(await absent.latest("prov_3"), null);
    assert.deepEqual(await absent.providers(), []);
    await assert.rejects(new LoginJournal(dir).record(entry("../escape", 1_000)));
    await assert.rejects(new LoginJournal(dir).latest("a/b"));
  });
});

test("orphaned entries are removed only after they stopped changing, a removed provider at once", async () => {
  await withJournal(async (journal, dir) => {
    await journal.record(entry("prov_4", 1_000));
    const now = Date.now();
    assert.equal(await journal.removeUnchangedSince("prov_4", now - 60_000), false);
    const [name] = await readdir(path.join(dir, "prov_4"));
    const old = new Date(now - 120_000);
    await utimes(path.join(dir, "prov_4", name!), old, old);
    assert.equal(await journal.removeUnchangedSince("prov_4", now - 60_000), true);
    assert.deepEqual(await journal.providers(), []);
    await mkdir(path.join(dir, "prov_5"));
    assert.equal(await journal.removeUnchangedSince("prov_5", now), true);
    await journal.record(entry("prov_6", 1_000));
    await journal.forget("prov_6");
    await journal.forget("prov_6");
    assert.deepEqual(await journal.providers(), []);
  });
});
