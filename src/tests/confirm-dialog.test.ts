import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AlertDialog, type useOverlayState } from "@heroui/react";
import ConfirmDialog from "@/components/console/confirm-dialog";
import { importedAs, readJsx, type JsxNode } from "./support/jsx-source";

const root = fileURLToPath(new URL("../..", import.meta.url));
const CONFIRM_DIALOG = "@/components/console/confirm-dialog";
const NATIVE_CONFIRM = /(?<![\w.])(?:window\.)?confirm\(/;

function overlay(isOpen: boolean): ReturnType<typeof useOverlayState> {
  const noop = () => {};
  return { isOpen, setOpen: noop, open: noop, close: noop, toggle: noop };
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith(".tsx") ? [full] : [];
  });
}

test("confirm-dialog is a HeroUI AlertDialog driven by the caller's overlay state", () => {
  const state = overlay(true);
  const controlled = ConfirmDialog({ title: "Delete?", confirmLabel: "Delete", cancelLabel: "Cancel", onConfirm: () => {}, state });
  assert.equal(controlled.type, AlertDialog.Backdrop);
  assert.equal(controlled.props.isOpen, true);
  assert.equal(controlled.props.onOpenChange, state.setOpen);
  const triggered = ConfirmDialog({
    title: "Delete?",
    confirmLabel: "Delete",
    cancelLabel: "Cancel",
    onConfirm: () => {},
    children: "Delete",
  });
  assert.equal(triggered.type, AlertDialog);
  assert.equal(triggered.props.isOpen, undefined);
  assert.equal(triggered.props.onOpenChange, undefined);
});

test("no console component falls back to the browser confirm prompt", () => {
  const files = [...sourceFiles(path.join(root, "src/app")), ...sourceFiles(path.join(root, "src/components"))];
  const offenders = files.filter((file) => NATIVE_CONFIRM.test(readFileSync(file, "utf8")));
  assert.deepEqual(offenders.map((file) => path.relative(root, file)), []);
});

test("key rotation and revocation only run once their ConfirmDialog is confirmed", () => {
  const dialogs = readJsx(path.join(root, "src/components/keys/use-key-dialogs.tsx"));
  const dialog = importedAs(dialogs, CONFIRM_DIALOG);
  assert.ok(dialog);
  for (const action of ["rotate", "revoke"]) {
    const call = new RegExp(`\\b${action}\\(`);
    const confirm: JsxNode | undefined = dialogs.elements.find(
      (element) => element.tag === dialog && call.test(element.attributes.get("onConfirm") ?? ""),
    );
    assert.ok(confirm, action);
    assert.equal(confirm.attributes.get("state"), `${action}State`);
    assert.match(confirm.attributes.get("title") ?? "", new RegExp(`"${action}Confirm\\.title"`));
  }
  const callers = [
    "src/components/keys/use-key-dialogs.tsx",
    "src/app/(app)/keys/page.tsx",
    "src/app/(app)/keys/_components/key-list.tsx",
    "src/app/(app)/keys/[id]/page.tsx",
  ];
  for (const rel of callers) {
    const source = readJsx(path.join(root, rel));
    const direct = source.elements.filter((element) =>
      ["onPress", "onAction"].some((name) => /\b(?:rotate|revoke)\(/.test(element.attributes.get(name) ?? "")),
    );
    assert.deepEqual(direct, [], rel);
  }
});

test("user and role deletion use the shared ConfirmDialog", () => {
  for (const rel of ["src/app/(app)/users/_components/users-tab.tsx", "src/app/(app)/users/_components/roles-tab.tsx"]) {
    const page = readJsx(path.join(root, rel));
    const dialog = importedAs(page, CONFIRM_DIALOG);
    const confirm = page.elements.find((element) => element.tag === dialog && element.attributes.get("state") === "deleteState");
    assert.ok(confirm, rel);
    assert.match(confirm.attributes.get("onConfirm") ?? "", /\bremove\(/, rel);
  }
  const userDialogs = readFileSync(path.join(root, "src/app/(app)/users/_components/user-dialogs.tsx"), "utf8");
  assert.doesNotMatch(userDialogs, /\bDeleteUserDialog\b/);
  assert.equal(existsSync(path.join(root, "src/app/(app)/users/_components/delete-role-dialog.tsx")), false);
});
