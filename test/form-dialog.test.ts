import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (rel: string) => readFile(path.join(root, rel), "utf8");

const FORM_DIALOGS = [
  "src/app/(app)/account/_components/management-keys-card.tsx",
  "src/app/(app)/account/_components/passkeys-card.tsx",
  "src/app/(app)/companies/_components/boost-dialog.tsx",
  "src/app/(app)/companies/_components/node-dialog.tsx",
  "src/app/(app)/companies/_components/report-dialog.tsx",
  "src/app/(app)/guardrails/_components/guardrail-override-dialog.tsx",
  "src/app/(app)/guardrails/_components/pii-override-dialog.tsx",
  "src/app/(app)/keys/_components/key-dialog.tsx",
  "src/app/(app)/knowledge/_components/store-dialog.tsx",
  "src/app/(app)/markups/_components/markup-dialog.tsx",
  "src/app/(app)/model-catalog/_components/assign-dialog.tsx",
  "src/app/(app)/model-templates/_components/template-dialog.tsx",
  "src/app/(app)/models/_components/model-group-dialog.tsx",
  "src/app/(app)/roles/_components/role-editor-dialog.tsx",
  "src/app/(app)/subscriptions/_components/access-dialog.tsx",
  "src/app/(app)/users/_components/user-dialogs.tsx",
  "src/components/budget/budget-dialog.tsx",
  "src/components/providers/provider-dialog.tsx",
];

test("form-dialog submits a HeroUI Form from the standard footer", async () => {
  const source = await read("src/components/console/form-dialog.tsx");
  assert.match(source, /import \{[^}]*\bForm\b[^}]*\bModal\b[^}]*\} from ["']@heroui\/react["']/);
  assert.match(source, /<Modal state=\{state\}>/);
  assert.match(source, /<Modal\.Backdrop>/);
  assert.match(source, /<Modal\.Container>/);
  assert.match(source, /<Modal\.Dialog className=\{WIDTHS\[size\]\}>/);
  assert.match(source, /<Form\s+id=\{formId\}[\s\S]*?onSubmit=\{\(event\) => \{\s*event\.preventDefault\(\);/);
  assert.match(source, /<Button\s+type="submit"\s+form=\{formId\}/);
  assert.match(source, /isPending=\{pending\}/);
  assert.doesNotMatch(source, /\bonClick\b/);
  const sizes = /const WIDTHS = \{([\s\S]*?)\} as const;/.exec(source)?.[1] ?? "";
  assert.deepEqual([...sizes.matchAll(/(\w+): "max-w-\w+"/g)].map((match) => match[1]), ["sm", "md", "lg", "xl"]);
});

for (const rel of FORM_DIALOGS) {
  test(`${rel} uses the shared FormDialog`, async () => {
    const source = await read(rel);
    assert.match(source, /from "@\/components\/console\/form-dialog"/);
    assert.match(source, /<FormDialog\b/);
    assert.doesNotMatch(source, /<Modal\b/);
  });
}
