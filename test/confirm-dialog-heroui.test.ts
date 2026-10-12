import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { AlertDialog, Button } from "@heroui/react";
import ConfirmDialog from "@/components/console/confirm-dialog";
import { elementsIn, elementsOf, onlyElement } from "./support/element-tree";

function dialog(change: { description?: string; pending?: boolean; children?: string } = {}) {
  const confirmed: string[] = [];
  const onConfirm = () => {
    confirmed.push("confirmed");
  };
  const tree = ConfirmDialog({
    title: "Revoke key?",
    confirmLabel: "Revoke",
    cancelLabel: "Cancel",
    onConfirm,
    description: change.description,
    pending: change.pending,
    children: change.children ? createElement("span", null, change.children) : undefined,
  });
  return { tree, onConfirm, confirmed };
}

test("confirm-dialog builds the HeroUI AlertDialog compound parts", () => {
  const { tree } = dialog({ description: "The key stops working at once.", children: "trigger" });
  for (const part of [AlertDialog.Trigger, AlertDialog.Backdrop, AlertDialog.Container, AlertDialog.Dialog, AlertDialog.Header, AlertDialog.Footer]) {
    onlyElement(tree, part);
  }
  assert.equal(onlyElement(tree, AlertDialog.Heading).props.children, "Revoke key?");
  assert.equal(onlyElement(tree, AlertDialog.Icon).props.status, "danger");
  assert.equal(onlyElement(onlyElement(tree, AlertDialog.Body), "p").props.children, "The key stops working at once.");
  const bare = dialog().tree;
  assert.deepEqual(elementsOf(bare, AlertDialog.Trigger), []);
  assert.deepEqual(elementsOf(bare, AlertDialog.Body), []);
});

test("both footer buttons close the dialog and only the danger button confirms", () => {
  const { tree, onConfirm, confirmed } = dialog({ pending: true });
  const footer = onlyElement(tree, AlertDialog.Footer);
  const [cancel, confirm] = elementsOf(footer, Button);
  assert.deepEqual(
    [cancel?.props.slot, cancel?.props.variant, cancel?.props.children, cancel?.props.onPress],
    ["close", "tertiary", "Cancel", undefined],
  );
  assert.deepEqual(
    [confirm?.props.slot, confirm?.props.variant, confirm?.props.children, confirm?.props.isPending],
    ["close", "danger", "Revoke", true],
  );
  assert.equal(confirm?.props.onPress, onConfirm);
  (confirm?.props.onPress as () => void)();
  assert.deepEqual(confirmed, ["confirmed"]);
  for (const trigger of elementsOf(tree, AlertDialog.CloseTrigger)) assert.deepEqual(elementsOf(trigger, Button), []);
  assert.equal(elementsIn(tree).some((element) => "onClick" in element.props), false);
});
