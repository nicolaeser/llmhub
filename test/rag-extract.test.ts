import assert from "node:assert/strict";
import test from "node:test";
import { deflateRawSync } from "node:zlib";
import { decodeText, extensionOf, extractDocument, htmlText, ocrText } from "@/lib/rag/extract";
import { readZipText, zipEntries } from "@/lib/rag/zip";

function zip(files: Record<string, string>, deflate = true): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const raw = Buffer.from(content);
    const data = deflate ? deflateRawSync(raw) : raw;
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, directory, end]));
}

test("zip reader lists entries and inflates stored and deflated files", () => {
  for (const deflate of [true, false]) {
    const bytes = zip({ "a.txt": "hello", "dir/b.xml": "<x/>" }, deflate);
    const entries = zipEntries(bytes);
    assert.deepEqual(entries.map((entry) => entry.name), ["a.txt", "dir/b.xml"]);
    assert.equal(readZipText(bytes, entries, "a.txt"), "hello");
    assert.equal(readZipText(bytes, entries, "missing"), null);
  }
  assert.deepEqual(zipEntries(new Uint8Array(10)), []);
});

test("docx text keeps paragraphs, tabs, and footnotes and skips field codes", () => {
  const body =
    '<w:document><w:body><w:p><w:r><w:t>Hello</w:t></w:r><w:r><w:tab/><w:t xml:space="preserve">world &amp; more</w:t></w:r></w:p>' +
    "<w:p><w:r><w:instrText>PAGE</w:instrText><w:t>Second</w:t></w:r></w:p></w:body></w:document>";
  const docx = zip({ "word/document.xml": body, "word/footnotes.xml": "<w:p><w:t>Note</w:t></w:p>" });
  const result = extractDocument({ filename: "Report.DOCX", contentType: "", payload: docx });
  assert.equal(result.kind, "text");
  assert.equal(result.kind === "text" ? result.text : "", "Hello\tworld & more\nSecond\n\n\nNote\n");
});

test("pptx and xlsx extract slide text and sheet cells", () => {
  const pptx = zip({
    "ppt/slides/slide2.xml": "<a:p><a:t>Second slide</a:t></a:p>",
    "ppt/slides/slide1.xml": "<a:p><a:t>First</a:t></a:p>",
  });
  const slides = extractDocument({ filename: "deck.pptx", contentType: "", payload: pptx });
  assert.equal(slides.kind === "text" ? slides.text : "", "# 1\nFirst\n\n\n# 2\nSecond slide\n");
  const xlsx = zip({
    "xl/sharedStrings.xml": "<sst><si><t>Name</t></si><si><t>Ada</t></si></sst>",
    "xl/worksheets/sheet1.xml":
      '<row r="1"><c t="s"><v>0</v></c><c><v>42</v></c></row><row r="2"><c t="s"><v>1</v></c><c t="inlineStr"><is><t>x</t></is></c></row>',
  });
  const sheet = extractDocument({ filename: "data.xlsx", contentType: "", payload: xlsx });
  assert.equal(sheet.kind === "text" ? sheet.text : "", "Name\t42\nAda\tx");
  const broken = extractDocument({ filename: "bad.docx", contentType: "", payload: new Uint8Array([1, 2, 3]) });
  assert.equal(broken.kind === "error" ? broken.error.code : "", "invalid_file");
});

test("pdf and images go to OCR, legacy office formats are unsupported", () => {
  const pdf = extractDocument({ filename: "scan.pdf", contentType: "", payload: new Uint8Array([37, 80, 68, 70]) });
  assert.equal(pdf.kind, "ocr");
  assert.equal(pdf.kind === "ocr" ? pdf.document.type : "", "document_url");
  assert.match(pdf.kind === "ocr" ? String(pdf.document.document_url) : "", /^data:application\/pdf;base64,/);
  const image = extractDocument({ filename: "photo", contentType: "image/png", payload: new Uint8Array([1]) });
  assert.equal(image.kind === "ocr" ? image.document.type : "", "image_url");
  const legacy = extractDocument({ filename: "old.doc", contentType: "", payload: new Uint8Array([1]) });
  assert.equal(legacy.kind === "error" ? legacy.error.code : "", "unsupported_file");
  const empty = extractDocument({ filename: "a.txt", contentType: "", payload: new Uint8Array() });
  assert.equal(empty.kind === "error" ? empty.error.code : "", "invalid_file");
});

test("text files decode UTF-8 and UTF-16, html is stripped, binaries are rejected", () => {
  assert.equal(decodeText(Buffer.from("\uFEFFhallo")), "hallo");
  assert.equal(decodeText(Buffer.from([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00])), "hi");
  assert.equal(decodeText(new Uint8Array([0x41, 0x00, 0x42])), null);
  const html = htmlText("<html><style>p{}</style><body><h1>Title</h1><p>A &amp; B</p><script>x()</script></body></html>");
  assert.equal(html.trim(), "Title\n\nA & B");
  const page = extractDocument({ filename: "page.html", contentType: "", payload: Buffer.from("<p>Hi</p>") });
  assert.equal(page.kind === "text" ? page.text.trim() : "", "Hi");
  const binary = extractDocument({ filename: "blob.bin", contentType: "", payload: new Uint8Array([0, 1, 2, 3]) });
  assert.equal(binary.kind, "error");
  assert.equal(extensionOf("src/Dockerfile"), "dockerfile");
  assert.equal(extensionOf(".env"), "");
});

test("ocrText reads Mistral-style pages and plain text responses", () => {
  assert.equal(ocrText({ pages: [{ markdown: "# A" }, { text: "B" }, {}] }), "# A\n\nB");
  assert.equal(ocrText({ text: "plain" }), "plain");
  assert.equal(ocrText(null), "");
});
