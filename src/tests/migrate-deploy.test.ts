import assert from "node:assert/strict";
import test from "node:test";
import { migrateDatabase, migrationFailureHelp, validateMigrationEnv } from "../../scripts/migrate-deploy.mjs";

const env = {
  NODE_ENV: "production" as const,
  DATABASE_URL: "postgresql://example:example@127.0.0.1/llmhub",
  APP_SECRET: "test-app-secret-aaaaaaaaaaaaaaaaaaaa",
};

test("startup only deploys migrations through the bundled Prisma CLI", async () => {
  const commands: string[][] = [];
  await migrateDatabase({ env, write: () => {}, run: async (args: string[], actual: typeof env) => {
    assert.equal(actual, env);
    commands.push(args);
    return { code: 0, signal: null, output: "No pending migrations to apply." };
  } });
  assert.deepEqual(commands, [["migrate", "deploy"]]);
});

test("migration output reaches the operator before the command exits and is not repeated", async () => {
  const messages: string[] = [];
  await migrateDatabase({ env, write: (message: string) => messages.push(message),
    run: async (_args: string[], _env: typeof env, onOutput: (chunk: string) => void) => {
      onOutput("Applying migration\n");
      assert.deepEqual(messages, ["Applying migration"]);
      onOutput("Migration applied\n");
      return { code: 0, signal: null, output: "Applying migration\nMigration applied\n" };
    },
  });
  assert.deepEqual(messages, ["Applying migration", "Migration applied"]);
});

test("startup retries only transient database and migration-lock failures", async () => {
  for (const code of ["P1001", "P1002", "P1017"]) {
    let calls = 0;
    const delays: number[] = [];
    await migrateDatabase({ env, write: () => {}, delayMs: 3, wait: async (ms: number) => { delays.push(ms); },
      run: async () => ({ code: ++calls < 3 ? 1 : 0, signal: null, output: code }),
    });
    assert.equal(calls, 3);
    assert.deepEqual(delays, [3, 3]);
  }
});

test("startup retries a schema creation race with another start but no other unique violation", async () => {
  let calls = 0;
  const delays: number[] = [];
  await migrateDatabase({ env, write: () => {}, delayMs: 3, wait: async (ms: number) => { delays.push(ms); },
    run: async () => ({ code: ++calls < 2 ? 1 : 0, signal: null, output: "Error: P2002: Unique constraint failed on the fields: (`nspname`)\n" }),
  });
  assert.equal(calls, 2);
  assert.deepEqual(delays, [3]);
  calls = 0;
  await assert.rejects(migrateDatabase({ env, write: () => {},
    wait: async () => { assert.fail("other unique violations must not retry"); },
    run: async () => { calls += 1; return { code: 1, signal: null, output: "Error: P2002: Unique constraint failed on the fields: (`email`)\n" }; },
  }), /migrations failed/);
  assert.equal(calls, 1);
});

test("unreachable databases stop the migration step after bounded retries", async () => {
  let calls = 0;
  let waits = 0;
  await assert.rejects(migrateDatabase({ env, write: () => {}, attempts: 3,
    wait: async () => { waits += 1; },
    run: async () => { calls += 1; return { code: 1, signal: null, output: "P1001" }; },
  }), /migrations failed/);
  assert.equal(calls, 3);
  assert.equal(waits, 2);
});

test("nonempty unbaselined and failed migrations stop without reset, baseline, resolve, or record changes", async () => {
  for (const code of ["P3005", "P3009", "P3018", "P1000"]) {
    const commands: string[][] = [];
    await assert.rejects(migrateDatabase({ env, write: () => {},
      wait: async () => { assert.fail("permanent failures must not retry inside the migration step"); },
      run: async (args: string[]) => {
        commands.push(args);
        return { code: 1, signal: null, output: code };
      },
    }));
    assert.deepEqual(commands, [["migrate", "deploy"]]);
  }
  assert.match(migrationFailureHelp("P3005"), /No automatic baseline/);
  assert.match(migrationFailureHelp("P3009"), /only the verified, fully rolled-back/);
  assert.match(migrationFailureHelp("P3018"), /migrate resolve/);
});

test("invalid startup configuration fails before invoking Prisma", async () => {
  for (const candidate of [
    { ...env, DATABASE_URL: "" },
    { ...env, APP_SECRET: "short" },
    { ...env, NODE_ENV: "test" as const },
  ]) {
    assert.throws(() => validateMigrationEnv(candidate));
    await assert.rejects(migrateDatabase({ env: candidate, run: async () => { assert.fail("invalid environment"); } }));
  }
});

test("verified P3009 recovery retries deploy once and retains conservative schema status", async () => {
  let calls = 0;
  let recoveries = 0;
  const result = await migrateDatabase({ env, write: () => {}, wait: async () => {},
    recover: async (options) => { assert.equal(options?.automatic, true); recoveries++; },
    run: async () => ({ code: ++calls === 1 ? 1 : 0, signal: null, output: calls === 1 ? "P3009" : "No pending migrations to apply." }),
  });
  assert.equal(calls, 2);
  assert.equal(recoveries, 1);
  assert.equal(result?.schemaChanged, "unknown");
});

test("recovery refusals and repeated migration failures never enter an immediate repair loop", async () => {
  for (const refuses of [true, false]) {
    let calls = 0;
    let recoveries = 0;
    await assert.rejects(migrateDatabase({ env, write: () => {}, wait: async () => {},
      recover: async () => { recoveries++; if (refuses) throw new Error("Verification refused"); },
      run: async () => { calls++; return { code: 1, signal: null, output: "P3009" }; },
    }));
    assert.equal(recoveries, 1);
    assert.equal(calls, refuses ? 1 : 2);
  }
  for (const code of ["P3005", "P3018"]) {
    await assert.rejects(migrateDatabase({ env, write: () => {}, recover: async () => assert.fail("not a recovery trigger"),
      run: async () => ({ code: 1, signal: null, output: code }),
    }));
  }
});
