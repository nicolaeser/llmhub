import assert from "node:assert/strict";
import { once } from "node:events";
import { connect, createServer, Socket, type AddressInfo, type Server } from "node:net";
import test from "node:test";
import {
  buildMessage,
  encodeMailbox,
  encodeSubject,
  MAIL_HTML_MAX_BYTES,
  MAIL_MESSAGE_MAX_BYTES,
  mailErrorCode,
  quotedPrintable,
  sendMail,
} from "@/lib/mail/send";

delete process.env.SMTP_URL;

type FakeSession = { commands: string[]; data: string; raw: string; closed: Promise<unknown> };

type MimeNode = { headers: Map<string, string>; body: string; boundary?: string; parts: MimeNode[] };

const b64 = (value: string) => Buffer.from(value, "utf8").toString("base64");

const input = { to: "user@example.com", subject: "Reset", text: "hello" };

function decodeQp(body: string): string {
  const joined = body.replace(/=\r\n/g, "");
  const bytes: number[] = [];
  for (let index = 0; index < joined.length; index++) {
    if (joined[index] === "=") {
      bytes.push(parseInt(joined.slice(index + 1, index + 3), 16));
      index += 2;
    } else {
      bytes.push(joined.charCodeAt(index));
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

function decodeWords(value: string): string {
  return value
    .replace(/\?=\s+=\?/g, "?==?")
    .replace(/=\?UTF-8\?B\?([A-Za-z0-9+/=]*)\?=/g, (_, word: string) => Buffer.from(word, "base64").toString("utf8"));
}

function parseMime(raw: string): MimeNode {
  const split = raw.indexOf("\r\n\r\n");
  const head = split < 0 ? raw : raw.slice(0, split);
  const body = split < 0 ? "" : raw.slice(split + 4);
  const headers = new Map<string, string>();
  for (const line of head.replace(/\r\n(?=[ \t])/g, "").split("\r\n")) {
    const colon = line.indexOf(":");
    headers.set(line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim());
  }
  const boundary = /^multipart\/[a-z]+; boundary="([^"]+)"$/.exec(headers.get("content-type") ?? "")?.[1];
  if (!boundary) return { headers, body, parts: [] };
  const segments = `\r\n${body}`.split(`\r\n--${boundary}`);
  assert.equal(segments[0], "");
  assert.equal(segments.at(-1), "--");
  const parts = segments.slice(1, -1).map((segment) => {
    assert.ok(segment.startsWith("\r\n"));
    return parseMime(segment.slice(2));
  });
  return { headers, body, boundary, parts };
}

const contentType = (node: MimeNode) => node.headers.get("content-type");

const header = (message: string, name: string) =>
  message.split("\r\n").find((line) => line.startsWith(`${name}: `))?.slice(name.length + 2);

async function fakeSmtp(options: { caps: string[]; starttls?: boolean; replies?: Record<string, string> }) {
  const sessions: FakeSession[] = [];
  const server: Server = createServer((socket) => {
    const closed = new Promise((resolve) => socket.on("close", resolve));
    const session: FakeSession = { commands: [], data: "", raw: "", closed };
    sessions.push(session);
    let buffer = "";
    let dataLines: string[] | null = null;
    let login = 0;
    let upgraded = false;
    const reply = (line: string): string => {
      const verb = line.split(" ")[0].toUpperCase();
      const custom = options.replies?.[verb];
      if (custom) return custom;
      if (login > 0) return --login ? "334 UGFzc3dvcmQ6\r\n" : "235 ok\r\n";
      if (verb === "EHLO") {
        const caps = options.starttls && !upgraded ? ["STARTTLS", ...options.caps] : options.caps;
        return ["fake.test", ...caps].map((cap, i, all) => `250${i < all.length - 1 ? "-" : " "}${cap}\r\n`).join("");
      }
      if (verb === "STARTTLS") {
        upgraded = true;
        return "220 go ahead\r\n";
      }
      if (line === "AUTH LOGIN") {
        login = 2;
        return "334 VXNlcm5hbWU6\r\n";
      }
      if (verb === "AUTH") return "235 ok\r\n";
      if (verb === "MAIL" || verb === "RCPT") return "250 ok\r\n";
      if (verb === "DATA") {
        dataLines = [];
        return "354 go\r\n";
      }
      if (verb === "QUIT") {
        socket.end("221 bye\r\n");
        return "";
      }
      return "500 unknown\r\n";
    };
    socket.setEncoding("utf8");
    socket.write("220-fake.test ESMTP\r\n220 ready\r\n");
    socket.on("data", (chunk: string) => {
      session.raw += chunk;
      buffer += chunk;
      for (let idx = buffer.indexOf("\r\n"); idx >= 0; idx = buffer.indexOf("\r\n")) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (dataLines && line !== ".") {
          dataLines.push(line);
        } else if (dataLines) {
          session.data = dataLines.join("\r\n");
          dataLines = null;
          socket.write("250 queued\r\n");
        } else {
          session.commands.push(line);
          const out = reply(line);
          if (out) socket.write(out);
        }
      }
    });
    socket.on("error", () => undefined);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  return { server, sessions, port, dial: (): Socket => connect(port, "127.0.0.1") };
}

const verbs = (session: FakeSession) =>
  session.commands.map((line) => (/^[A-Z]{4}/.test(line) ? line.split(/[ :]/)[0] : line));

test("body line endings become CRLF and leading dots are quoted-printable encoded", () => {
  const message = buildMessage({ ...input, from: "hub@example.org", text: "one\n.two\r\n..three\rfour" });
  const body = message.slice(message.indexOf("\r\n\r\n") + 4);
  assert.equal(body, "one\r\n=2Etwo\r\n=2E.three\r\nfour");
  assert.equal(/\r(?!\n)|(?<!\r)\n/.test(message), false);
  assert.equal(decodeQp(body), "one\r\n.two\r\n..three\r\nfour");
});

test("headers carry MIME, charset, transfer encoding, date and message id", () => {
  const now = new Date(Date.UTC(2026, 9, 5, 8, 4, 3));
  const message = buildMessage({ ...input, from: "LLM Hub <hub@example.org>" }, now);
  assert.equal(header(message, "From"), "LLM Hub <hub@example.org>");
  assert.equal(header(message, "To"), "user@example.com");
  assert.equal(header(message, "Subject"), "Reset");
  assert.equal(header(message, "Date"), "Mon, 05 Oct 2026 08:04:03 +0000");
  assert.equal(header(message, "MIME-Version"), "1.0");
  assert.equal(header(message, "Content-Type"), "text/plain; charset=utf-8");
  assert.equal(header(message, "Content-Transfer-Encoding"), "quoted-printable");
  const id = header(message, "Message-ID");
  assert.match(id ?? "", /^<[0-9a-f-]{36}@example\.org>$/);
  assert.notEqual(header(buildMessage({ ...input, from: "hub@example.org" }, now), "Message-ID"), id);
});

test("CR or LF in to, from or subject is rejected", async () => {
  const from = "hub@example.org";
  assert.throws(() => buildMessage({ ...input, from, to: "a@b.c\r\nBcc: x@y.z" }), /line break/);
  assert.throws(() => buildMessage({ ...input, from: "hub@example.org\nBcc: x@y.z" }), /line break/);
  assert.throws(() => buildMessage({ ...input, from, subject: "hi\rBcc: x@y.z" }), /line break/);
  let dialed = false;
  await assert.rejects(
    sendMail(
      { ...input, subject: "a\nb" },
      {
        url: "smtp://127.0.0.1:2525",
        from,
        connect: () => {
          dialed = true;
          return new Socket();
        },
      },
    ),
    /line break/,
  );
  assert.equal(dialed, false);
});

test("non-ASCII subjects are RFC 2047 encoded in UTF-8 base64 words", () => {
  assert.equal(encodeSubject("Reset your password"), "Reset your password");
  assert.equal(encodeSubject("Passwort zurücksetzen"), `=?UTF-8?B?${b64("Passwort zurücksetzen")}?=`);
  const long = "Zurücksetzen 🔑 ".repeat(8);
  const encoded = encodeSubject(long);
  const words = encoded.split("\r\n ");
  assert.ok(words.length > 1);
  for (const word of words) {
    assert.match(word, /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
    assert.ok(word.length <= 75);
  }
  const decoded = words.map((word) => Buffer.from(word.slice(10, -2), "base64").toString("utf8")).join("");
  assert.equal(decoded, long);
  const message = buildMessage({ ...input, from: "hub@example.org", subject: "Grüße" });
  assert.equal(header(message, "Subject"), `=?UTF-8?B?${b64("Grüße")}?=`);
});

test("returns sent false when SMTP_URL is not set", async () => {
  assert.deepEqual(await sendMail(input), { sent: false });
});

test("loopback exchange authenticates, sends data and terminates it", async () => {
  const smtp = await fakeSmtp({ caps: ["SIZE 1000", "AUTH PLAIN LOGIN", "8BITMIME"] });
  try {
    const result = await sendMail(
      { ...input, text: "line\n.dot\nlast" },
      { url: `smtp://bob%40corp:p%40ss@127.0.0.1:${smtp.port}`, from: "Hub <hub@example.org>" },
    );
    assert.deepEqual(result, { sent: true });
    const [session] = smtp.sessions;
    await session.closed;
    assert.deepEqual(verbs(session), ["EHLO", "AUTH", "MAIL", "RCPT", "DATA", "QUIT"]);
    assert.equal(session.commands[1], `AUTH PLAIN ${b64("\0bob@corp\0p@ss")}`);
    assert.equal(session.commands[2], "MAIL FROM:<hub@example.org> BODY=8BITMIME");
    assert.equal(session.commands[3], "RCPT TO:<user@example.com>");
    assert.ok(session.raw.includes("\r\n\r\nline\r\n=2Edot\r\nlast\r\n.\r\nQUIT\r\n"));
    assert.equal(session.data.split("\r\n\r\n")[1], "line\r\n=2Edot\r\nlast");
    assert.equal(session.data.split("\r\n").some((line) => line.startsWith(".")), false);
  } finally {
    smtp.server.close();
  }
});

test("loopback without credentials skips AUTH", async () => {
  const smtp = await fakeSmtp({ caps: ["AUTH PLAIN"] });
  try {
    await sendMail(input, { url: `smtp://127.0.0.1:${smtp.port}`, from: "hub@example.org" });
    assert.deepEqual(verbs(smtp.sessions[0]), ["EHLO", "MAIL", "RCPT", "DATA", "QUIT"]);
    assert.equal(smtp.sessions[0].commands[1], "MAIL FROM:<hub@example.org>");
  } finally {
    smtp.server.close();
  }
});

test("other loopback spellings are allowed without STARTTLS", async () => {
  const smtp = await fakeSmtp({ caps: [] });
  try {
    for (const host of ["LOCALHOST", "[::1]"]) {
      let dialed = "";
      const dial = (target: string) => {
        dialed = target;
        return smtp.dial();
      };
      assert.deepEqual(await sendMail(input, { url: `smtp://${host}:25`, from: "hub@example.org", connect: dial }), {
        sent: true,
      });
      assert.equal(dialed, host.replace(/^\[|\]$/g, ""));
    }
  } finally {
    smtp.server.close();
  }
});

test("STARTTLS upgrades the socket and repeats EHLO before AUTH", async () => {
  const smtp = await fakeSmtp({ caps: ["AUTH LOGIN"], starttls: true });
  try {
    let upgradedHost = "";
    await sendMail(input, {
      url: "smtp://bob:secret@mail.example.com:587",
      from: "hub@example.org",
      connect: (host, port, secure) => {
        assert.deepEqual([host, port, secure], ["mail.example.com", 587, false]);
        return smtp.dial();
      },
      upgrade: (socket, host) => {
        upgradedHost = host;
        return socket;
      },
    });
    const [session] = smtp.sessions;
    assert.equal(upgradedHost, "mail.example.com");
    assert.deepEqual(verbs(session), ["EHLO", "STARTTLS", "EHLO", "AUTH", b64("bob"), b64("secret"), "MAIL", "RCPT", "DATA", "QUIT"]);
    assert.equal(session.commands[3], "AUTH LOGIN");
  } finally {
    smtp.server.close();
  }
});

test("non-loopback host without STARTTLS is refused before AUTH", async () => {
  const smtp = await fakeSmtp({ caps: ["AUTH PLAIN LOGIN"] });
  try {
    await assert.rejects(
      sendMail(input, { url: "smtp://bob:secret@mail.example.com:25", from: "hub@example.org", connect: smtp.dial }),
      /STARTTLS/,
    );
    const [session] = smtp.sessions;
    await session.closed;
    assert.deepEqual(verbs(session), ["EHLO"]);
    assert.equal(session.raw.includes(b64("secret")), false);
  } finally {
    smtp.server.close();
  }
});

test("data injected after the STARTTLS reply is rejected", async () => {
  const smtp = await fakeSmtp({
    caps: ["AUTH PLAIN"],
    starttls: true,
    replies: { STARTTLS: "220 go ahead\r\n250 injected\r\n" },
  });
  try {
    await assert.rejects(
      sendMail(input, {
        url: "smtp://bob:secret@mail.example.com:587",
        from: "hub@example.org",
        connect: smtp.dial,
        upgrade: (socket) => socket,
      }),
      /unexpected data/,
    );
    await smtp.sessions[0].closed;
    assert.deepEqual(verbs(smtp.sessions[0]), ["EHLO", "STARTTLS"]);
  } finally {
    smtp.server.close();
  }
});

test("unexpected status codes fail the send and close the socket", async () => {
  const smtp = await fakeSmtp({ caps: [], replies: { RCPT: "550-no such\r\n550 user\r\n" } });
  try {
    await assert.rejects(
      sendMail(input, { url: `smtp://127.0.0.1:${smtp.port}`, from: "hub@example.org" }),
      /^Error: smtp 550 no such user$/,
    );
    await smtp.sessions[0].closed;
    assert.deepEqual(verbs(smtp.sessions[0]), ["EHLO", "MAIL", "RCPT"]);
  } finally {
    smtp.server.close();
  }
});

test("a silent server times out and the socket is closed", async () => {
  const sockets: Promise<unknown>[] = [];
  const server = createServer((socket) => {
    sockets.push(new Promise((resolve) => socket.on("close", resolve)));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const { port } = server.address() as AddressInfo;
    await assert.rejects(
      sendMail(input, { url: `smtp://127.0.0.1:${port}`, from: "hub@example.org", timeoutMs: 50 }),
      /smtp timeout/,
    );
    await Promise.all(sockets);
    assert.equal(sockets.length, 1);
  } finally {
    server.close();
  }
});

test("attachments build a multipart message with a base64 part per file", () => {
  const pdf = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, ...Array.from({ length: 120 }, (_, i) => i)]);
  const message = buildMessage({
    ...input,
    from: "hub@example.org",
    text: "Summary\n.dot",
    attachments: [
      { filename: "llmhub-usage-2026-09.pdf", contentType: "application/pdf", content: pdf },
      { filename: "usage ä/../x.csv", contentType: "text/csv; charset=utf-8", content: "a,b\n1,2\n" },
    ],
  });
  const boundary = /^Content-Type: multipart\/mixed; boundary="([^"]+)"$/m.exec(message)?.[1];
  assert.ok(boundary);
  assert.equal(header(message, "MIME-Version"), "1.0");
  const parts = message.split(`--${boundary}`);
  assert.equal(parts.length, 5);
  assert.equal(parts[4], "--");
  assert.match(
    parts[1],
    /Content-Type: text\/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nSummary\r\n=2Edot\r\n$/,
  );
  const decode = (part: string) => Buffer.from(part.split("\r\n\r\n")[1].replace(/\r\n/g, ""), "base64");
  assert.match(parts[2], /Content-Type: application\/pdf; name="llmhub-usage-2026-09\.pdf"/);
  assert.match(parts[2], /Content-Disposition: attachment; filename="llmhub-usage-2026-09\.pdf"/);
  assert.deepEqual(new Uint8Array(decode(parts[2])), pdf);
  assert.ok(parts[2].split("\r\n").every((line) => line.length <= 76));
  assert.match(parts[3], /filename="usage___\.\._x\.csv"/);
  assert.equal(decode(parts[3]).toString("utf8"), "a,b\n1,2\n");
  assert.throws(
    () =>
      buildMessage({
        ...input,
        from: "hub@example.org",
        attachments: [{ filename: "x", contentType: "text/plain\r\nBcc: x@y.z", content: "" }],
      }),
    /line break/,
  );
});

test("several recipients share one message and each gets a RCPT", async () => {
  const to = ["a@example.com", "b@example.com"];
  const message = buildMessage({ ...input, to, from: "hub@example.org" });
  assert.match(message, /\r\nTo: a@example\.com,\r\n b@example\.com\r\n/);
  assert.throws(() => buildMessage({ ...input, to: [], from: "hub@example.org" }), /no recipient/);
  const smtp = await fakeSmtp({ caps: [] });
  try {
    await sendMail({ ...input, to }, { url: `smtp://127.0.0.1:${smtp.port}`, from: "hub@example.org" });
    const [session] = smtp.sessions;
    assert.deepEqual(verbs(session), ["EHLO", "MAIL", "RCPT", "RCPT", "DATA", "QUIT"]);
    assert.equal(session.commands[2], "RCPT TO:<a@example.com>");
    assert.equal(session.commands[3], "RCPT TO:<b@example.com>");
  } finally {
    smtp.server.close();
  }
});

test("mail errors reduce to codes without addresses", () => {
  assert.equal(mailErrorCode(new Error("smtp 550 5.1.1 <x@y.z> unknown user")), "SMTP_550");
  assert.equal(mailErrorCode(new Error("smtp timeout")), "SMTP_TIMEOUT");
  assert.equal(mailErrorCode(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })), "ECONNREFUSED");
  assert.equal(mailErrorCode(new Error("something with a@b.c")), "MAIL_FAILED");
  assert.equal(mailErrorCode("nope"), "MAIL_FAILED");
});

test("a text-only message is one quoted-printable part that round-trips UTF-8", () => {
  const text = "Grüße aus Zürich 👋\nZeile mit = Zeichen und Tab\t\nEnde mit Leerzeichen \n";
  const message = buildMessage({ ...input, from: "hub@example.org", text });
  const root = parseMime(message);
  assert.equal(contentType(root), "text/plain; charset=utf-8");
  assert.equal(root.headers.get("content-transfer-encoding"), "quoted-printable");
  assert.equal(root.parts.length, 0);
  assert.equal(decodeQp(root.body), text.replace(/\n/g, "\r\n"));
  assert.match(root.body, /^Gr=C3=BC=C3=9Fe aus Z=C3=BCrich =F0=9F=91=8B\r\n/);
  assert.match(root.body, /Tab=09\r\nEnde mit Leerzeichen=20\r\n$/);
  assert.match(root.body, /mit =3D Zeichen/);
});

test("an HTML body becomes multipart/alternative with the text part first", () => {
  const text = "Grüße 👋\n.Punkt";
  const html = '<!DOCTYPE html>\n<p style="color:#5252e8">Grüße 👋 &amp; Straße</p>\n.Punkt';
  const message = buildMessage({ ...input, from: "hub@example.org", text, html });
  const root = parseMime(message);
  assert.match(contentType(root) ?? "", /^multipart\/alternative; boundary="=_[0-9a-f]{32}"$/);
  assert.equal(root.headers.get("mime-version"), "1.0");
  assert.equal(root.headers.has("content-transfer-encoding"), false);
  assert.deepEqual(root.parts.map(contentType), ["text/plain; charset=utf-8", "text/html; charset=utf-8"]);
  for (const part of root.parts) assert.equal(part.headers.get("content-transfer-encoding"), "quoted-printable");
  assert.equal(decodeQp(root.parts[0].body), text.replace(/\n/g, "\r\n"));
  assert.equal(decodeQp(root.parts[1].body), html.replace(/\n/g, "\r\n"));
  assert.equal(message.split("\r\n").some((line) => line.startsWith(".")), false);
  assert.equal(message.split(`--${root.boundary}--`).length, 2);
});

test("an empty HTML body keeps the single text part", () => {
  const root = parseMime(buildMessage({ ...input, from: "hub@example.org", html: "" }));
  assert.equal(contentType(root), "text/plain; charset=utf-8");
});

test("HTML with attachments nests the alternative part first inside multipart/mixed", () => {
  const pdf = Uint8Array.from({ length: 300 }, (_, i) => (i * 37) % 256);
  const message = buildMessage({
    ...input,
    from: "hub@example.org",
    text: "Summary ä",
    html: "<p>Summary ä</p>",
    attachments: [
      { filename: "report.pdf", contentType: "application/pdf", content: pdf },
      { filename: "report.csv", contentType: "text/csv; charset=utf-8", content: "a,b\n1,2\n" },
    ],
  });
  const root = parseMime(message);
  assert.match(contentType(root) ?? "", /^multipart\/mixed; boundary="=_[0-9a-f]{32}"$/);
  assert.equal(root.parts.length, 3);
  const [alternative, file, csv] = root.parts;
  assert.match(contentType(alternative) ?? "", /^multipart\/alternative; boundary=/);
  assert.notEqual(alternative.boundary, root.boundary);
  assert.deepEqual(alternative.parts.map(contentType), ["text/plain; charset=utf-8", "text/html; charset=utf-8"]);
  assert.equal(decodeQp(alternative.parts[0].body), "Summary ä");
  assert.equal(decodeQp(alternative.parts[1].body), "<p>Summary ä</p>");
  assert.equal(contentType(file), 'application/pdf; name="report.pdf"');
  assert.equal(file.headers.get("content-transfer-encoding"), "base64");
  assert.deepEqual(new Uint8Array(Buffer.from(file.body.replace(/\r\n/g, ""), "base64")), pdf);
  assert.equal(Buffer.from(csv.body.replace(/\r\n/g, ""), "base64").toString("utf8"), "a,b\n1,2\n");
  const lines = message.split("\r\n");
  assert.equal(lines.filter((line) => line === `--${root.boundary}--`).length, 1);
  assert.equal(lines.filter((line) => line === `--${alternative.boundary}--`).length, 1);
  assert.ok(lines.indexOf(`--${alternative.boundary}--`) < lines.indexOf(`--${root.boundary}`, lines.indexOf(`--${alternative.boundary}--`)));
  assert.equal(lines.at(-1), `--${root.boundary}--`);
});

test("every line stays within 998 octets, headers fold at 78 and encoded bodies at 76", () => {
  const longLine = "Ä".repeat(150) + " 🙂".repeat(60) + "=".repeat(80) + "x".repeat(300);
  const message = buildMessage({
    ...input,
    to: ["Jörg Müller-Lüdenscheidt von und zu Großherzogtum <joerg@example.com>", "plain@example.com"],
    from: "LLM Hub Notifications For Every Department <hub@example.org>",
    subject: "A very long but plain ASCII subject line that keeps going well past the seventy-eight character mark",
    text: `${longLine}\n${"word ".repeat(100)}`,
    html: `<table>${"<td>Zelle ä</td>".repeat(400)}</table>`,
    attachments: [
      {
        filename: `${"long-report-name-".repeat(12)}.csv`,
        contentType: "text/csv; charset=utf-8; header=present",
        content: "a,b\n".repeat(400),
      },
    ],
  });
  const lines = message.split("\r\n");
  for (const line of lines) assert.ok(Buffer.byteLength(line) <= 998);
  for (const line of lines) assert.ok(line.length <= 78 || /^ \S+$/.test(line), line);
  assert.ok(lines.some((line) => /^ name="long-report-name-/.test(line)));
  const root = parseMime(message);
  const [alternative, file] = root.parts;
  for (const part of [...alternative.parts, file]) {
    for (const line of part.body.split("\r\n")) assert.ok(line.length <= 76, line);
  }
  assert.equal(decodeQp(alternative.parts[0].body), `${longLine}\r\n${"word ".repeat(100)}`);
  assert.match(alternative.parts[0].body, /=\r\n/);
  assert.equal(
    root.headers.get("subject"),
    "A very long but plain ASCII subject line that keeps going well past the seventy-eight character mark",
  );
  const name = /filename="([^"]+)"/.exec(file.headers.get("content-disposition") ?? "")?.[1] ?? "";
  assert.ok(name.length <= 100);
  assert.ok(name.endsWith(".csv"));
});

test("soft line breaks never split an escape and a dot after a soft break is encoded", () => {
  const lines = quotedPrintable(`${"a".repeat(75)}.b\n${"a".repeat(74)}ü`);
  assert.deepEqual(lines, [`${"a".repeat(75)}=`, "=2Eb", `${"a".repeat(74)}=`, "=C3=BC"]);
  const wide = quotedPrintable("é".repeat(100));
  for (const line of wide) {
    assert.ok(line.length <= 76);
    assert.match(line, /^(=[0-9A-F]{2})+=?$/);
  }
  assert.equal(decodeQp(wide.join("\r\n")), "é".repeat(100));
  assert.deepEqual(quotedPrintable("trailing \nspace\t"), ["trailing=20", "space=09"]);
});

test("non-ASCII display names and subjects become encoded words", () => {
  assert.equal(encodeMailbox("LLM Hub <hub@example.org>"), "LLM Hub <hub@example.org>");
  assert.equal(encodeMailbox("plain@example.com"), "plain@example.com");
  assert.equal(encodeMailbox('"Zoë Ünal" <z@example.com>'), `=?UTF-8?B?${b64("Zoë Ünal")}?= <z@example.com>`);
  const message = buildMessage({
    ...input,
    from: "Bericht-Zentrale Größe <hub@example.org>",
    to: ['"Zoë" <z@example.com>', "plain@example.com"],
    subject: "Nutzungsbericht für Müller 📈",
  });
  const root = parseMime(message);
  const headerBlock = message.slice(0, message.indexOf("\r\n\r\n")).split("\r\n");
  assert.ok(headerBlock.every((line) => /^[\x20-\x7e]+$/.test(line)));
  assert.equal(decodeWords(root.headers.get("from") ?? ""), "Bericht-Zentrale Größe <hub@example.org>");
  assert.equal(decodeWords(root.headers.get("to") ?? ""), "Zoë <z@example.com>, plain@example.com");
  assert.equal(decodeWords(root.headers.get("subject") ?? ""), "Nutzungsbericht für Müller 📈");
  assert.match(encodeSubject("looks =?UTF-8?B?like?= a word"), /^=\?UTF-8\?B\?/);
  assert.match(encodeSubject(`id ${"x".repeat(90)}`), /^=\?UTF-8\?B\?/);
});

test("HTML content cannot inject headers and header values still reject line breaks", () => {
  const message = buildMessage({
    ...input,
    from: "hub@example.org",
    html: "<p>x</p>\r\n\r\nBcc: evil@example.com\r\n--fake--",
  });
  const root = parseMime(message);
  assert.equal(root.headers.has("bcc"), false);
  assert.equal(root.parts.length, 2);
  assert.equal(root.parts.every((part) => !part.headers.has("bcc")), true);
  assert.equal(decodeQp(root.parts[1].body), "<p>x</p>\r\n\r\nBcc: evil@example.com\r\n--fake--");
  assert.throws(
    () => buildMessage({ ...input, from: "hub@example.org", subject: "a\r\nBcc: x@y.z", html: "<p>x</p>" }),
    /line break/,
  );
  assert.throws(
    () => buildMessage({ ...input, from: "Hub\n <hub@example.org>", html: "<p>x</p>" }),
    /line break/,
  );
});

test("HTML bodies and whole messages above their caps are rejected with a code", () => {
  const from = "hub@example.org";
  assert.ok(buildMessage({ ...input, from, html: "a".repeat(MAIL_HTML_MAX_BYTES) }));
  assert.throws(
    () => buildMessage({ ...input, from, html: "ä".repeat(MAIL_HTML_MAX_BYTES / 2 + 1) }),
    (err: unknown) => err instanceof Error && /html body is too large/.test(err.message) && mailErrorCode(err) === "MAIL_HTML_TOO_LARGE",
  );
  const content = new Uint8Array(Math.ceil((MAIL_MESSAGE_MAX_BYTES * 3) / 4));
  assert.throws(
    () => buildMessage({ ...input, from, attachments: [{ filename: "big.bin", contentType: "application/octet-stream", content }] }),
    (err: unknown) => err instanceof Error && /message is too large/.test(err.message) && mailErrorCode(err) === "MAIL_TOO_LARGE",
  );
});
