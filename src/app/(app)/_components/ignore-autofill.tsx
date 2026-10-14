"use client";

import { useEffect } from "react";

const KEPT = new Set(["username", "current-password", "new-password", "email", "one-time-code", "webauthn"]);

function kept(element: Element): boolean {
  const value = element.getAttribute("autocomplete")?.toLowerCase() ?? "";
  return value.split(/\s+/).some((token) => KEPT.has(token));
}

function ignore(element: HTMLInputElement | HTMLTextAreaElement) {
  if (element.dataset.autofillIgnored === "true" || kept(element)) return;
  element.dataset.autofillIgnored = "true";
  element.setAttribute("autocomplete", "off");
  element.setAttribute("data-1p-ignore", "");
  element.setAttribute("data-lpignore", "true");
  element.setAttribute("data-bwignore", "");
  element.setAttribute("data-protonpass-ignore", "");
  element.setAttribute("data-form-type", "other");
  if (element instanceof HTMLInputElement && element.type === "password") {
    element.readOnly = true;
    element.addEventListener(
      "focus",
      () => {
        element.readOnly = false;
      },
      { once: true },
    );
  }
}

function ignoreForm(form: HTMLFormElement) {
  if ([...form.querySelectorAll("input, textarea")].some(kept)) return;
  form.setAttribute("autocomplete", "off");
  form.setAttribute("data-1p-ignore", "");
  form.setAttribute("data-lpignore", "true");
}

function scan(root: ParentNode) {
  if (root instanceof HTMLFormElement) ignoreForm(root);
  if (root instanceof HTMLInputElement || root instanceof HTMLTextAreaElement) ignore(root);
  if (!(root instanceof Element) && !(root instanceof Document)) return;
  for (const form of root.querySelectorAll("form")) ignoreForm(form);
  for (const field of root.querySelectorAll("input, textarea")) {
    if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) ignore(field);
  }
}

export default function IgnoreAutofill() {
  useEffect(() => {
    scan(document);
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node instanceof HTMLElement) scan(node);
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);
  return null;
}
