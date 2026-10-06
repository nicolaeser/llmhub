import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { toCsv } from "@/lib/http/export";

const root = fileURLToPath(new URL("..", import.meta.url));
const route = path.join(root, "src/app/internal-api/usage/chargeback/route.ts");
const misplaced = path.join(root, "src/app/api/usage/chargeback/route.ts");

test("chargeback CSV lives under internal-api and uses loadUsageAction", async () => {
  assert.equal(existsSync(route), true);
  assert.equal(
    existsSync(misplaced),
    false,
    "chargeback must live under src/app/internal-api not src/app/api",
  );
  assert.equal(
    route.includes(`${path.sep}app${path.sep}internal-api${path.sep}`),
    true,
  );
  assert.equal(route.includes(`${path.sep}app${path.sep}api${path.sep}`), false);
  const source = await readFile(route, "utf8");
  assert.match(source, /loadUsageAction/);
  assert.match(source, /toCsv/);
  assert.match(source, /llmhub-chargeback\.csv/);
});

test("toCsv writes a chargeback row", () => {
  const csv = toCsv([
    {
      org_id: "o1",
      team_id: "t1",
      project_id: "p1",
      key_id: "k1",
      user_id: "u1",
      model: "gpt",
      spend: 1.5,
      prompt_tokens: 10,
      completion_tokens: 5,
    },
  ]);
  assert.match(
    csv,
    /^org_id,team_id,project_id,key_id,user_id,model,spend,prompt_tokens,completion_tokens\n/,
  );
  assert.match(csv, /o1,t1,p1,k1,u1,gpt,1\.5,10,5\n/);
});
