import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { Button, Form, Modal, Spinner, type useOverlayState } from "@heroui/react";
import FormDialog, { type FormDialogSize } from "@/components/console/form-dialog";
import { elementsIn, elementsOf, onlyElement, type TreeElement } from "./support/element-tree";
import { importedAs, readJsx, rendersComponent } from "./support/jsx-source";

const root = fileURLToPath(new URL("../..", import.meta.url));

const FORM_DIALOGS = [
  "src/app/(app)/account/_components/management-keys-card.tsx",
  "src/app/(app)/account/_components/passkeys-card.tsx",
  "src/app/(app)/companies/_components/node-dialog.tsx",
  "src/app/(app)/companies/_components/report-dialog.tsx",
  "src/app/(app)/keys/[id]/_components/key-section-dialog.tsx",
  "src/components/keys/key-mcp-dialog.tsx",
  "src/app/(app)/guardrails/_components/rule-dialog.tsx",
  "src/app/(app)/guardrails/_components/check-dialog.tsx",
  "src/app/(app)/knowledge/_components/store-dialog.tsx",
  "src/app/(app)/mcp/_components/access-dialog.tsx",
  "src/app/(app)/mcp/_components/permissions-dialog.tsx",
  "src/app/(app)/usage/_components/markup-dialog.tsx",
  "src/app/(app)/models/_components/assign-dialog.tsx",
  "src/app/(app)/models/_components/model-group-dialog.tsx",
  "src/app/(app)/models/_components/preset-dialog.tsx",
  "src/app/(app)/providers/_components/access-dialog.tsx",
  "src/app/(app)/providers/_components/add-provider-dialog.tsx",
  "src/app/(app)/providers/_components/provider-dialog.tsx",
  "src/app/(app)/users/_components/role-editor-dialog.tsx",
  "src/app/(app)/users/_components/user-dialogs.tsx",
  "src/components/budget/boost-dialog.tsx",
  "src/components/budget/budget-dialog.tsx",
];

type DialogProps = {
  size?: FormDialogSize;
  pending?: boolean;
  isSubmitDisabled?: boolean;
  onSubmit?: (close: () => void) => void;
};

const state: ReturnType<typeof useOverlayState> = {
  isOpen: true,
  setOpen: () => {},
  open: () => {},
  close: () => {},
  toggle: () => {},
};

function render(props: DialogProps = {}): TreeElement {
  let tree: TreeElement | null = null;
  function Capture() {
    tree = FormDialog({
      state,
      title: "Create key",
      submitLabel: "Save",
      submitIcon: createElement("svg", { "data-icon": "save" }),
      onSubmit: props.onSubmit ?? (() => {}),
      size: props.size,
      pending: props.pending,
      isSubmitDisabled: props.isSubmitDisabled,
      children: createElement("input", { name: "alias" }),
    }) as TreeElement;
    return null;
  }
  renderToStaticMarkup(
    createElement(NextIntlClientProvider, {
      locale: "en",
      timeZone: "UTC",
      messages: { Common: { cancel: "Cancel" } },
      children: createElement(Capture),
    }),
  );
  return tree!;
}

function opened(tree: TreeElement, close: () => void = () => {}) {
  const dialog = onlyElement(tree, Modal.Dialog);
  const content = (dialog.props.children as (bag: { close: () => void }) => ReactNode)({ close });
  const form = onlyElement(content, Form);
  const [cancel, submit] = elementsOf(onlyElement(content, Modal.Footer), Button);
  return { dialog, content, form, cancel: cancel!, submit: submit! };
}

function submitForm(form: TreeElement): { prevented: boolean } {
  const event = { prevented: false, preventDefault() { event.prevented = true; } };
  (form.props.onSubmit as (event: { preventDefault: () => void }) => void)(event);
  return event;
}

test("form-dialog renders a controlled HeroUI Modal backdrop around a Form submitted from the footer", () => {
  const tree = render();
  assert.equal(tree.type, Modal.Backdrop);
  assert.equal(tree.props.isOpen, state.isOpen);
  assert.equal(tree.props.onOpenChange, state.setOpen);
  onlyElement(tree, Modal.Container);
  const closed: string[] = [];
  const close = () => {
    closed.push("closed");
  };
  const { form, cancel, submit, content } = opened(tree, close);
  assert.equal(typeof form.props.id, "string");
  assert.deepEqual([submit.props.type, submit.props.form, submit.props.variant], ["submit", form.props.id, "primary"]);
  assert.deepEqual([cancel.props.variant, cancel.props.children, cancel.props.onPress], ["tertiary", "Cancel", close]);
  assert.equal([...elementsIn(tree), ...elementsIn(content)].some((element) => "onClick" in element.props), false);
  const label = submit.props.children as (render: { isPending: boolean }) => ReactElement;
  assert.equal(elementsOf(label({ isPending: true }), Spinner).length, 1);
  assert.equal(elementsOf(label({ isPending: false }), "svg").length, 1);
});

test("submitting prevents the native post and hands the close callback to onSubmit", () => {
  const submitted: unknown[] = [];
  const close = () => {};
  const { form } = opened(render({ onSubmit: (done) => submitted.push(done) }), close);
  assert.equal(submitForm(form).prevented, true);
  assert.deepEqual(submitted, [close]);
});

test("a pending or disabled dialog ignores submits and locks its buttons", () => {
  for (const props of [{ pending: true }, { isSubmitDisabled: true }]) {
    const submitted: unknown[] = [];
    const { form, cancel, submit } = opened(render({ ...props, onSubmit: (done) => submitted.push(done) }));
    assert.equal(submitForm(form).prevented, true);
    assert.deepEqual(submitted, [], JSON.stringify(props));
    assert.equal(submit.props.isPending, props.pending === true);
    assert.equal(submit.props.isDisabled, props.isSubmitDisabled === true);
    assert.equal(cancel.props.isDisabled, props.pending === true);
  }
});

test("form-dialog offers four distinct widths and defaults to md", () => {
  const sizes: FormDialogSize[] = ["sm", "md", "lg", "xl"];
  const widths = sizes.map((size) => String(opened(render({ size })).dialog.props.className));
  for (const width of widths) assert.match(width, /^max-w-\w+$/);
  assert.equal(new Set(widths).size, sizes.length);
  assert.equal(opened(render()).dialog.props.className, widths[sizes.indexOf("md")]);
});

for (const rel of FORM_DIALOGS) {
  test(`${rel} uses the shared FormDialog or StepDialog`, () => {
    const source = readJsx(path.join(root, rel));
    const shared = ["@/components/console/form-dialog", "@/components/console/step-dialog"].map((from) =>
      importedAs(source, from),
    );
    assert.ok(
      shared.some((local) => rendersComponent(source, local)),
      "renders FormDialog or StepDialog",
    );
    assert.equal(rendersComponent(source, importedAs(source, "@heroui/react", "Modal")), false, "renders Modal directly");
  });
}
