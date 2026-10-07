import assert from "node:assert/strict";
import test from "node:test";
import { requestLogMarkdown } from "@/lib/http/request-log-markdown";
import { requestLogPdf } from "@/lib/http/request-log-pdf";
import type { RequestLogDocument } from "@/types/logs";

function doc(overrides: Partial<RequestLogDocument["content"]> = {}): RequestLogDocument {
  return {
    brand: "LLM Hub",
    title: "Anfragedetails",
    subtitle: "gpt-4o · 6. Okt. 2026, 12:10:05 UTC",
    status: "200 · OK",
    generated: "Erstellt am 6. Okt. 2026, 12:11:00 UTC",
    error: null,
    fields: [
      { label: "Anfrage-ID", value: "log_123", mono: true },
      { label: "Modell", value: "gpt_4o*mini" },
    ],
    privacy: {
      heading: "Datenschutz",
      fields: [{ label: "Prompt-Filter", value: "Vor dem Modell maskiert" }],
      note: "Gespeicherte Inhalte sind maskiert.",
    },
    content: {
      heading: "Inhalt",
      notice: "",
      truncated: "",
      conversation: "Verlauf",
      empty: "Kein lesbarer Text.",
      input: [
        {
          role: "Benutzer",
          assistant: false,
          heading: "",
          kind: "text",
          text: "# Überschrift\n\nSchreib an [EMAIL_ADDRESS] und **fett** mit `code`.\n\n- eins\n- zwei\n\n| A | B |\n| --- | ---: |\n| 1 | 2 |",
        },
      ],
      output: [
        {
          role: "Assistent",
          assistant: true,
          heading: "",
          kind: "text",
          text: "```ts\nconst answer = 42;\n```",
        },
        {
          role: "Assistent",
          assistant: true,
          heading: "Tool-Aufruf lookup",
          kind: "tool_call",
          text: '{"query":"```"}',
        },
      ],
      payloads: [
        { heading: "Anfrage-JSON", json: '{\n  "model": "gpt-4o"\n}' },
        { heading: "Antwort-JSON", json: "" },
      ],
      noJson: "Nichts gespeichert.",
      ...overrides,
    },
    piiLabel: (entity) => (entity === "EMAIL_ADDRESS" ? "E-Mail" : entity),
    pageLabel: (page, total) => `Seite ${page} von ${total}`,
  };
}

const latin1 = (bytes: Uint8Array) => Buffer.from(bytes).toString("latin1");
const winAnsiHex = (value: string) => Buffer.from(value, "latin1").toString("hex");

function assertValidPdf(pdf: string) {
  assert.match(pdf, /^%PDF-1\.4\n/);
  assert.match(pdf, /%%EOF$/);
  const startxref = Number(pdf.match(/startxref\n(\d+)\n%%EOF$/)?.[1]);
  assert.equal(pdf.slice(startxref, startxref + 4), "xref");
  const offsets = [...pdf.matchAll(/^(\d{10}) 00000 n $/gm)].map((match) => Number(match[1]));
  offsets.forEach((offset, index) => {
    assert.ok(pdf.startsWith(`${index + 1} 0 obj\n`, offset), `object ${index + 1} offset`);
  });
  assert.doesNotMatch(pdf, /NaN|Infinity/);
}

test("requestLogPdf renders markdown with fonts, PII labels, and valid offsets", () => {
  const pdf = latin1(requestLogPdf(doc()));
  assertValidPdf(pdf);
  assert.match(pdf, /\/BaseFont \/Courier \/Encoding \/WinAnsiEncoding/);
  assert.match(pdf, /\/BaseFont \/Helvetica-Bold \/Encoding \/WinAnsiEncoding/);
  assert.ok(pdf.includes(`<${winAnsiHex("Überschrift")}>`));
  assert.ok(pdf.includes(`<${winAnsiHex("E-Mail")}>`));
  assert.ok(!pdf.includes(winAnsiHex("[EMAIL_ADDRESS]")));
  assert.ok(pdf.includes(`<${winAnsiHex("const answer = 42;")}>`));
  assert.ok(pdf.includes(`<${winAnsiHex("Nichts gespeichert.")}>`));
  assert.ok(pdf.includes(`<${winAnsiHex("Seite 1 von 1")}>`));
});

test("requestLogPdf flows long transcripts onto numbered pages", () => {
  const paragraph = "Ein langer Absatz mit vielen Wörtern, der umbrechen muss. ".repeat(40);
  const longWord = "x".repeat(4000);
  const base = doc();
  const pdf = latin1(
    requestLogPdf({
      ...base,
      content: {
        ...base.content,
        input: Array.from({ length: 12 }, () => ({
          role: "Benutzer",
          assistant: false,
          heading: "",
          kind: "text" as const,
          text: `${paragraph}\n\n${longWord}`,
        })),
      },
    }),
  );
  assertValidPdf(pdf);
  const count = Number(pdf.match(/\/Type \/Pages \/Kids \[[^\]]*\] \/Count (\d+)/)?.[1]);
  assert.ok(count > 2, `expected several pages, got ${count}`);
  assert.equal([...pdf.matchAll(/\/Type \/Page \/Parent/g)].length, count);
  assert.ok(pdf.includes(`<${winAnsiHex(`Seite ${count} von ${count}`)}>`));
});

test("requestLogPdf shows the notice instead of the conversation when content is missing", () => {
  const pdf = latin1(requestLogPdf(doc({ notice: "Keine Inhalte gespeichert.", input: [], output: [] })));
  assertValidPdf(pdf);
  assert.ok(pdf.includes(`<${winAnsiHex("Keine Inhalte gespeichert.")}>`));
  assert.ok(!pdf.includes(`<${winAnsiHex("Verlauf")}>`));
});

test("requestLogMarkdown keeps content, escapes fields, and fences code safely", () => {
  const md = requestLogMarkdown(doc());
  assert.match(md, /^# Anfragedetails\n/);
  assert.ok(md.includes("- **Anfrage-ID:** `log_123`"));
  assert.ok(md.includes("- **Modell:** gpt\\_4o\\*mini"));
  assert.ok(md.includes("Schreib an [EMAIL_ADDRESS] und **fett**"));
  assert.ok(md.includes('#### Assistent · Tool-Aufruf lookup\n\n````json\n{"query":"```"}\n````'));
  assert.ok(md.includes("### Antwort-JSON\n\n_Nichts gespeichert._"));
  assert.ok(md.endsWith("_Erstellt am 6. Okt. 2026, 12:11:00 UTC · LLM Hub_\n"));
});

test("requestLogMarkdown quotes reasoning and replaces the conversation with the notice", () => {
  const base = doc();
  const withReasoning = requestLogMarkdown({
    ...base,
    content: {
      ...base.content,
      output: [{ role: "Assistent", assistant: true, heading: "Denkprozess", kind: "reasoning", text: "erst A\n\ndann B" }],
    },
  });
  assert.ok(withReasoning.includes("#### Assistent · Denkprozess\n\n> erst A\n>\n> dann B"));

  const missing = requestLogMarkdown(doc({ notice: "Keine Inhalte gespeichert.", input: [], output: [] }));
  assert.ok(missing.includes("## Inhalt\n\nKeine Inhalte gespeichert."));
  assert.ok(!missing.includes("### Verlauf"));
});
