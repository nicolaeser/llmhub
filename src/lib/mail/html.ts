import "server-only";

import { COLORS } from "@/lib/export/pdf";
import type { PdfColor } from "@/types/export";
import type { MailHtmlInput, MailHtmlLink, MailHtmlRow, MailHtmlTable } from "@/types/mail";

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

const FONT = "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;";

function hex(color: PdfColor): string {
  return `#${color.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

const PALETTE = {
  accent: hex(COLORS.accent),
  onAccent: hex(COLORS.onAccent),
  ink: hex(COLORS.ink),
  muted: hex(COLORS.muted),
  border: hex(COLORS.border),
  surface: hex(COLORS.surface),
  panel: "#ffffff",
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
}

export function safeMailHref(value: string): string | null {
  if (!URL.canParse(value)) return null;
  const url = new URL(value);
  return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
}

function langTag(value: string): string {
  return /^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/.test(value) ? value : "en";
}

function paragraph(value: string): string {
  return `<p style="margin:0 0 16px;${FONT}font-size:15px;line-height:22px;color:${PALETTE.ink};">${escapeHtml(value)}</p>`;
}

function rowsHtml(rows: MailHtmlRow[]): string {
  const cells = rows.map(
    (row) =>
      `<tr><td style="padding:8px 0;border-bottom:1px solid ${PALETTE.border};${FONT}font-size:14px;color:${PALETTE.muted};">${escapeHtml(row.label)}</td>` +
      `<td align="right" style="padding:8px 0;border-bottom:1px solid ${PALETTE.border};${FONT}font-size:14px;font-weight:600;color:${PALETTE.ink};">${escapeHtml(row.value)}</td></tr>`,
  );
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;border-collapse:collapse;">${cells.join("\n")}</table>`;
}

function tableHtml(table: MailHtmlTable): string {
  const align = (index: number) => (table.columns[index]?.align === "end" ? "right" : "left");
  const caption = table.caption
    ? `<caption align="top" style="padding:0 0 8px;text-align:left;${FONT}font-size:14px;font-weight:600;color:${PALETTE.ink};">${escapeHtml(table.caption)}</caption>`
    : "";
  const head = table.columns
    .map(
      (column, index) =>
        `<th align="${align(index)}" style="padding:6px 8px;background-color:${PALETTE.surface};border-bottom:1px solid ${PALETTE.border};${FONT}font-size:12px;font-weight:600;color:${PALETTE.muted};">${escapeHtml(column.label)}</th>`,
    )
    .join("");
  const body = table.rows.map(
    (row) =>
      `<tr>${row
        .map(
          (cell, index) =>
            `<td align="${align(index)}" style="padding:6px 8px;border-bottom:1px solid ${PALETTE.border};${FONT}font-size:13px;color:${PALETTE.ink};word-break:break-word;">${escapeHtml(cell)}</td>`,
        )
        .join("")}</tr>`,
  );
  return `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;border-collapse:collapse;">${caption}<thead><tr>${head}</tr></thead><tbody>${body.join("\n")}</tbody></table>`;
}

function actionHtml(action: MailHtmlLink): string {
  const href = safeMailHref(action.href);
  if (!href) return "";
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 20px;"><tr>` +
    `<td style="background-color:${PALETTE.accent};border-radius:8px;">` +
    `<a href="${escapeHtml(href)}" style="display:inline-block;padding:10px 18px;${FONT}font-size:14px;font-weight:600;color:${PALETTE.onAccent};text-decoration:none;">${escapeHtml(action.label)}</a>` +
    `</td></tr></table>`
  );
}

export function renderMailHtml(input: MailHtmlInput): string {
  const content = [
    `<h1 style="margin:0 0 12px;${FONT}font-size:20px;line-height:28px;font-weight:600;color:${PALETTE.ink};">${escapeHtml(input.title)}</h1>`,
    input.intro ? paragraph(input.intro) : "",
    input.rows?.length ? rowsHtml(input.rows) : "",
    input.table?.rows.length ? tableHtml(input.table) : "",
    ...(input.paragraphs ?? []).map(paragraph),
    input.action ? actionHtml(input.action) : "",
  ].filter(Boolean);
  return [
    "<!DOCTYPE html>",
    `<html lang="${escapeHtml(langTag(input.lang))}">`,
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="color-scheme" content="light">',
    '<meta name="supported-color-schemes" content="light">',
    `<title>${escapeHtml(input.title)}</title>`,
    "</head>",
    `<body style="margin:0;padding:0;background-color:${PALETTE.surface};">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${PALETTE.surface};">`,
    `<tr><td align="center" style="padding:24px 12px;">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background-color:${PALETTE.panel};border:1px solid ${PALETTE.border};border-radius:12px;border-collapse:separate;">`,
    `<tr><td style="padding:16px 24px;background-color:${PALETTE.accent};border-radius:12px 12px 0 0;${FONT}font-size:15px;font-weight:600;color:${PALETTE.onAccent};">${escapeHtml(input.brand)}</td></tr>`,
    `<tr><td style="padding:24px;">`,
    ...content,
    "</td></tr>",
    `<tr><td style="padding:16px 24px;border-top:1px solid ${PALETTE.border};${FONT}font-size:12px;line-height:18px;color:${PALETTE.muted};">${escapeHtml(input.footer)}</td></tr>`,
    "</table>",
    "</td></tr>",
    "</table>",
    "</body>",
    "</html>",
  ].join("\n");
}
