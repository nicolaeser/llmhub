import { isZip, readZipText, zipEntries } from "@/lib/rag/zip";
import { asRecord } from "@/lib/gateway/core";
import type { Extraction, VectorFileError, ZipEntry } from "@/types/rag";

const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "mdx", "rst", "adoc", "tex", "log", "csv", "tsv", "json", "jsonl", "ndjson",
  "yaml", "yml", "toml", "ini", "cfg", "conf", "env", "properties", "xml", "svg", "rtf",
  "c", "h", "cc", "cpp", "hpp", "cs", "go", "java", "kt", "kts", "scala", "swift", "m", "rs", "rb", "php",
  "py", "pyi", "r", "jl", "lua", "pl", "sh", "bash", "zsh", "ps1", "bat", "sql", "graphql", "proto",
  "js", "mjs", "cjs", "jsx", "ts", "mts", "cts", "tsx", "vue", "svelte", "css", "scss", "less", "dart",
  "ex", "exs", "erl", "hs", "clj", "fs", "vb", "groovy", "gradle", "tf", "hcl", "dockerfile", "makefile",
]);
const HTML_EXTENSIONS = new Set(["html", "htm", "xhtml"]);
const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  tif: "image/tiff",
  tiff: "image/tiff",
  bmp: "image/bmp",
  avif: "image/avif",
};
const MAX_INVALID_RATIO = 0.01;
const SNIFF_BYTES = 8192;

function failure(code: VectorFileError["code"], message: string): Extraction {
  return { kind: "error", error: { code, message } };
}

export function extensionOf(filename: string): string {
  const base = filename.toLowerCase().split("/").pop() ?? "";
  if (base === "dockerfile" || base === "makefile") return base;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1) : "";
}

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower === "amp") return "&";
    if (lower === "lt") return "<";
    if (lower === "gt") return ">";
    if (lower === "quot") return '"';
    if (lower === "apos") return "'";
    if (lower === "nbsp") return " ";
    const code = lower.startsWith("#x") ? Number.parseInt(lower.slice(2), 16) : Number.parseInt(lower.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
  });
}

export function htmlText(html: string): string {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1\s*>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/?(p|div|section|article|header|footer|li|ul|ol|tr|table|h[1-6]|blockquote|pre|dt|dd)\b[^>]*>/gi, "\n")
      .replace(/<\/t[dh]\s*>/gi, "\t")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n");
}

function wordXmlText(xml: string): string {
  const out: string[] = [];
  const pattern = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:(?:br|cr)\b[^>]*\/>|<\/w:p>/g;
  for (const match of xml.matchAll(pattern)) {
    const token = match[0];
    if (match[1] !== undefined) out.push(decodeEntities(match[1]));
    else if (token.startsWith("<w:tab")) out.push("\t");
    else out.push("\n");
  }
  return out.join("");
}

function drawingXmlText(xml: string): string {
  const out: string[] = [];
  for (const match of xml.matchAll(/<a:t(?:\s[^>]*)?>([^<]*)<\/a:t>|<\/a:p>|<a:br\b[^>]*\/>/g)) {
    out.push(match[1] !== undefined ? decodeEntities(match[1]) : "\n");
  }
  return out.join("");
}

function numbered(entries: ZipEntry[], pattern: RegExp): string[] {
  return entries
    .map((entry) => ({ name: entry.name, n: Number(pattern.exec(entry.name)?.[1] ?? NaN) }))
    .filter((item) => Number.isFinite(item.n))
    .sort((a, b) => a.n - b.n)
    .map((item) => item.name);
}

function docxText(bytes: Uint8Array, entries: ZipEntry[]): string | null {
  const body = readZipText(bytes, entries, "word/document.xml");
  if (body === null) return null;
  const extras = ["word/footnotes.xml", "word/endnotes.xml"]
    .map((name) => readZipText(bytes, entries, name))
    .filter((xml): xml is string => xml !== null)
    .map(wordXmlText);
  return [wordXmlText(body), ...extras].join("\n\n");
}

function pptxText(bytes: Uint8Array, entries: ZipEntry[]): string | null {
  const slides = numbered(entries, /^ppt\/slides\/slide(\d+)\.xml$/);
  if (!slides.length) return null;
  return slides
    .map((name, i) => {
      const xml = readZipText(bytes, entries, name) ?? "";
      const notes = readZipText(bytes, entries, name.replace("slides/slide", "notesSlides/notesSlide"));
      return [`# ${i + 1}`, drawingXmlText(xml), notes ? drawingXmlText(notes) : ""].filter(Boolean).join("\n");
    })
    .join("\n\n");
}

function xlsxText(bytes: Uint8Array, entries: ZipEntry[]): string | null {
  const sheets = numbered(entries, /^xl\/worksheets\/sheet(\d+)\.xml$/);
  if (!sheets.length) return null;
  const shared = [...(readZipText(bytes, entries, "xl/sharedStrings.xml") ?? "").matchAll(/<si>([\s\S]*?)<\/si>/g)].map(
    (match) => decodeEntities([...match[1]!.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((t) => t[1]).join("")),
  );
  return sheets
    .map((name) => {
      const xml = readZipText(bytes, entries, name) ?? "";
      const rows = [...xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)].map((row) =>
        [...row[1]!.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)]
          .map((cell) => {
            const attrs = cell[1] ?? "";
            const inner = cell[2] ?? "";
            const value = /<v>([^<]*)<\/v>/.exec(inner)?.[1];
            if (/\bt="s"/.test(attrs) && value !== undefined) return shared[Number(value)] ?? "";
            const inline = [...inner.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((t) => t[1]).join("");
            return decodeEntities(inline || value || "");
          })
          .join("\t"),
      );
      return rows.join("\n");
    })
    .join("\n\n");
}

function officeText(bytes: Uint8Array, extension: string): Extraction {
  if (!isZip(bytes)) return failure("invalid_file", `the .${extension} file is not a valid Office document`);
  const entries = zipEntries(bytes);
  const text =
    extension === "docx"
      ? docxText(bytes, entries)
      : extension === "pptx"
        ? pptxText(bytes, entries)
        : xlsxText(bytes, entries);
  if (text === null) return failure("invalid_file", `the .${extension} file has no readable content`);
  return { kind: "text", text };
}

export function decodeText(bytes: Uint8Array): string | null {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  const sniff = bytes.subarray(0, SNIFF_BYTES);
  if (sniff.includes(0)) return null;
  const text = new TextDecoder("utf-8").decode(bytes);
  if (!text) return "";
  let invalid = 0;
  for (const char of text) if (char === "�") invalid += 1;
  return invalid / text.length > MAX_INVALID_RATIO ? null : text.replace(/^\uFEFF/, "");
}

function dataUrl(media: string, bytes: Uint8Array): string {
  return `data:${media};base64,${Buffer.from(bytes).toString("base64")}`;
}

export function extractDocument(input: { filename: string; contentType: string; payload: Uint8Array }): Extraction {
  const extension = extensionOf(input.filename);
  const media = input.contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  const bytes = input.payload;
  if (!bytes.byteLength) return failure("invalid_file", "the file is empty");
  if (extension === "pdf" || media === "application/pdf") {
    return { kind: "ocr", document: { type: "document_url", document_url: dataUrl("application/pdf", bytes) } };
  }
  const image = IMAGE_TYPES[extension] ?? (media.startsWith("image/") && media !== "image/svg+xml" ? media : "");
  if (image) return { kind: "ocr", document: { type: "image_url", image_url: dataUrl(image, bytes) } };
  if (extension === "docx" || extension === "pptx" || extension === "xlsx") return officeText(bytes, extension);
  if (["doc", "ppt", "xls", "odt", "odp", "ods", "pages", "key", "numbers", "zip", "epub"].includes(extension)) {
    return failure("unsupported_file", `.${extension} files are not supported; convert them to PDF, DOCX, or text`);
  }
  const text = decodeText(bytes);
  if (text === null) {
    return failure("unsupported_file", "the file is binary or not valid UTF-8 text");
  }
  const known = TEXT_EXTENSIONS.has(extension) || HTML_EXTENSIONS.has(extension) || media.startsWith("text/") || media.includes("json") || media.includes("xml");
  if (!known && extension && /[^\s\p{L}\p{N}\p{P}\p{S}]/u.test(text.slice(0, 2048).replace(/[\n\r\t]/g, ""))) {
    return failure("unsupported_file", `.${extension} files are not supported`);
  }
  if (HTML_EXTENSIONS.has(extension) || media === "text/html" || media === "application/xhtml+xml") {
    return { kind: "text", text: htmlText(text) };
  }
  return { kind: "text", text };
}

export function ocrText(json: unknown): string {
  const rec = asRecord(json);
  if (!rec) return "";
  if (Array.isArray(rec.pages)) {
    return rec.pages
      .map((page) => {
        const item = asRecord(page);
        return typeof item?.markdown === "string" ? item.markdown : typeof item?.text === "string" ? item.text : "";
      })
      .filter(Boolean)
      .join("\n\n");
  }
  if (typeof rec.text === "string") return rec.text;
  if (typeof rec.markdown === "string") return rec.markdown;
  return "";
}
