import assert from "node:assert/strict";
import test from "node:test";
import { escapeHtml, renderMailHtml, safeMailHref } from "@/lib/mail/html";
import type { MailHtmlInput } from "@/types/mail";

const hostile = `"><script>alert('x')</script><img src=x onerror=alert(1)>&`;

const base: MailHtmlInput = {
  lang: "en",
  brand: "LLM Hub",
  title: "Usage report",
  footer: "Periods use UTC days.",
};

test("escapeHtml escapes the five HTML metacharacters", () => {
  assert.equal(escapeHtml(`<a href="x" title='y'>&amp;</a>`), "&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;amp;&lt;/a&gt;");
  assert.equal(escapeHtml("Grüße 👋"), "Grüße 👋");
});

test("safeMailHref keeps http and https links only", () => {
  assert.equal(safeMailHref("https://hub.example/usage?a=1&b=2"), "https://hub.example/usage?a=1&b=2");
  assert.equal(safeMailHref("http://localhost:3000/users"), "http://localhost:3000/users");
  for (const href of ["javascript:alert(1)", " JavaScript:alert(1)", "data:text/html,<b>x</b>", "vbscript:x", "mailto:a@b.c", "/relative", ""]) {
    assert.equal(safeMailHref(href), null, href);
  }
});

test("a full layout is an email-safe document with inline styles and console colors", () => {
  const html = renderMailHtml({
    ...base,
    lang: "de",
    intro: "Acme · September 2026",
    rows: [{ label: "Ausgaben", value: "12,30 $" }],
    table: {
      caption: "Ausgaben nach Modell",
      columns: [{ label: "Modell" }, { label: "Ausgaben", align: "end" }],
      rows: [["gpt-5", "12,30 $"]],
    },
    paragraphs: ["Das angehängte PDF zeigt die täglichen Ausgaben."],
    action: { label: "Nutzung öffnen", href: "https://hub.example/usage" },
  });
  assert.ok(html.startsWith("<!DOCTYPE html>\n<html lang=\"de\">"));
  assert.match(html, /<title>Usage report<\/title>/);
  assert.match(html, /<h1 [^>]*>Usage report<\/h1>/);
  assert.match(html, /role="presentation"/);
  assert.match(html, /<a href="https:\/\/hub\.example\/usage" [^>]*>Nutzung öffnen<\/a>/);
  assert.match(html, /<th align="right"[^>]*>Ausgaben<\/th>/);
  assert.match(html, /<caption[^>]*>Ausgaben nach Modell<\/caption>/);
  assert.match(html, /#5252e8/);
  for (const text of ["Acme · September 2026", "12,30 $", "gpt-5", "Das angehängte PDF zeigt die täglichen Ausgaben.", "Periods use UTC days.", "LLM Hub"]) {
    assert.ok(html.includes(text), text);
  }
  assert.doesNotMatch(html, /<script|<link|<img|<style|src=|url\(|class=/i);
});

test("optional sections are left out", () => {
  const html = renderMailHtml(base);
  assert.doesNotMatch(html, /<a |<th|<caption|<p /);
  assert.equal(renderMailHtml({ ...base, table: { columns: [{ label: "Model" }], rows: [] } }).includes("<th"), false);
});

test("every interpolated value is escaped and unsafe links are dropped", () => {
  const html = renderMailHtml({
    lang: `en"><script>alert(1)</script>`,
    brand: hostile,
    title: hostile,
    intro: hostile,
    rows: [{ label: hostile, value: hostile }],
    table: { caption: hostile, columns: [{ label: hostile }], rows: [[hostile]] },
    paragraphs: [hostile],
    action: { label: hostile, href: "javascript:alert(document.cookie)" },
    footer: hostile,
  });
  assert.doesNotMatch(html, /<script|<img|javascript:|<a /i);
  assert.match(html, /<html lang="en">/);
  const escaped = "&quot;&gt;&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;&lt;img src=x onerror=alert(1)&gt;&amp;";
  assert.equal(html.split(escaped).length - 1, 11);
  const linked = renderMailHtml({ ...base, action: { label: "Open", href: `https://hub.example/usage?q="><script>&x='1'` } });
  const href = /<a href="([^"]*)"/.exec(linked)?.[1] ?? "";
  assert.doesNotMatch(href, /[<>"']/);
  assert.match(href, /^https:\/\/hub\.example\/usage\?q=%22%3E%3Cscript%3E&amp;x=/);
});
