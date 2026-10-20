import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import {
  buildInfoOf,
  checkDue,
  DEVELOPMENT_BUILD,
  FOCUS_CHECK_GAP_MS,
  reloadRequired,
  UPDATE_RECHECK_MS,
  VERSION_POLL_MS,
} from "@/lib/updates/build-change";
import { importedAs, readJsx, rendersComponent, type JsxNode } from "./support/jsx-source";

const root = fileURLToPath(new URL("../..", import.meta.url));
const components = path.join(root, "src/app/(app)/_components");

function source(file: string) {
  return readFileSync(path.join(components, file), "utf8");
}

test("a different served build asks for a reload, the same build or an unknown answer does not", () => {
  assert.equal(reloadRequired("v2026.10.07.38e8b1b", "v2026.10.09.671389b"), true);
  assert.equal(reloadRequired("dev-2026.10.07.9472612", "v2026.10.07.38e8b1b"), true);
  assert.equal(reloadRequired("v2026.10.07.38e8b1b", "v2026.10.07.38e8b1b"), false);
  assert.equal(reloadRequired("v2026.10.07.38e8b1b", null), false);
});

test("development builds never ask for a reload", () => {
  assert.equal(reloadRequired(DEVELOPMENT_BUILD, DEVELOPMENT_BUILD), false);
  assert.equal(reloadRequired(DEVELOPMENT_BUILD, "v2026.10.07.38e8b1b"), false);
  assert.equal(reloadRequired("v2026.10.07.38e8b1b", DEVELOPMENT_BUILD), false);
});

test("version bodies parse only with a version and a start time", () => {
  assert.deepEqual(buildInfoOf({ version: "v2026.10.07.38e8b1b", startedAt: "2026-10-07T07:46:21.000Z" }), {
    version: "v2026.10.07.38e8b1b",
    startedAt: "2026-10-07T07:46:21.000Z",
  });
  for (const body of [null, "v1", [], {}, { version: "", startedAt: "x" }, { version: " ", startedAt: "x" }, { version: "v1" }, { version: 1, startedAt: "x" }]) {
    assert.equal(buildInfoOf(body), null, JSON.stringify(body));
  }
});

test("checks are due when never run or once their interval has passed", () => {
  const now = 1_000_000_000;
  assert.equal(checkDue(null, now, UPDATE_RECHECK_MS), true);
  assert.equal(checkDue(now - UPDATE_RECHECK_MS, now, UPDATE_RECHECK_MS), true);
  assert.equal(checkDue(now - UPDATE_RECHECK_MS + 1, now, UPDATE_RECHECK_MS), false);
  assert.equal(checkDue(now - 1_000, now, FOCUS_CHECK_GAP_MS), false);
  assert.equal(VERSION_POLL_MS, 30_000);
  assert.equal(UPDATE_RECHECK_MS, 6 * 3_600_000);
});

test("the console polls only the version endpoint and the sidebar carries the update notices", () => {
  const status = source("build-status.tsx");
  assert.match(status, /fetch\("\/internal-api\/version", \{ cache: "no-store" \}\)/);
  assert.match(status, /window\.location\.reload\(\)/);
  assert.match(status, /rel="noreferrer noopener"/);
  assert.match(status, /target="_blank"/);

  for (const file of ["console-topbar.tsx", "user-menu.tsx"]) {
    assert.doesNotMatch(source(file), /fetch\(|loadUpdateStatusAction|setInterval/, file);
  }
  assert.equal(importedAs(readJsx(path.join(components, "user-menu.tsx")), "./build-status", "useBuildStatus"), "useBuildStatus");
  const topbar = readJsx(path.join(components, "console-topbar.tsx"));
  assert.ok(rendersComponent(topbar, importedAs(topbar, "./live-badge")));
  assert.ok(rendersComponent(topbar, importedAs(topbar, "./user-menu")));

  const sidebar = readJsx(path.join(components, "sidebar.tsx"));
  assert.ok(rendersComponent(sidebar, importedAs(sidebar, "./build-status", "BuildNotice")));
  assert.ok(rendersComponent(sidebar, importedAs(sidebar, "./build-status", "BuildVersion")));

  const layout = readJsx(path.join(root, "src/app/(app)/layout.tsx"));
  const provider = layout.elements.filter(
    (element) => element.tag === importedAs(layout, "./_components/build-status"),
  );
  assert.equal(provider.length, 1);
  assert.equal(provider[0]!.attributes.get("version"), "currentBuild()");
  const within = (element: JsxNode): JsxNode[] => [element, ...element.children.flatMap(within)];
  assert.ok(within(provider[0]!).some((element) => element.tag === "Sidebar"));
});

test("before the first check the sidebar shows the loaded version and no notice", async () => {
  const { default: BuildStatusProvider, BuildNotice, BuildVersion } = await import("@/app/(app)/_components/build-status");
  const messages = JSON.parse(readFileSync(path.join(root, "lang/en/Common.json"), "utf8"));
  const html = renderToStaticMarkup(
    createElement(NextIntlClientProvider, {
      locale: "en",
      timeZone: "UTC",
      messages: { Common: messages },
      children: createElement(BuildStatusProvider, {
        version: "v2026.10.07.38e8b1b",
        children: [
          createElement(BuildNotice, { key: "notice", collapsed: false }),
          createElement(BuildVersion, { key: "version" }),
        ],
      }),
    }),
  );
  assert.equal(html, '<p class="truncate px-2 text-xs text-muted" title="v2026.10.07.38e8b1b">Version v2026.10.07.38e8b1b</p>');
});

test("without a notice the footer status slot keeps the version in place", async () => {
  const { default: BuildStatusProvider, BuildNotice, BuildVersion } = await import("@/app/(app)/_components/build-status");
  const messages = JSON.parse(readFileSync(path.join(root, "lang/en/Common.json"), "utf8"));
  const html = renderToStaticMarkup(
    createElement(NextIntlClientProvider, {
      locale: "en",
      timeZone: "UTC",
      messages: { Common: messages },
      children: createElement(BuildStatusProvider, {
        version: "v2026.10.07.38e8b1b",
        children: createElement(BuildNotice, { collapsed: false, fallback: createElement(BuildVersion) }),
      }),
    }),
  );
  assert.equal(html, '<p class="truncate px-2 text-xs text-muted" title="v2026.10.07.38e8b1b">Version v2026.10.07.38e8b1b</p>');
});
