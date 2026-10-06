import assert from "node:assert/strict";
import { once } from "node:events";
import { connect, createServer, Socket, type AddressInfo, type Server } from "node:net";
import test from "node:test";
import { buildMessage, encodeSubject, sendMail } from "@/lib/mail/send";

delete process.env.SMTP_URL;

type FakeSession = { commands: string[]; data: string; raw: string; closed: Promise<unknown> };

const b64 = (value: string) => Buffer.from(value, "utf8").toString("base64");

const input = { to: "user@example.com", subject: "Reset", text: "hello" };

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

test("body line endings become CRLF and leading dots are stuffed", () => {
  const message = buildMessage({ ...input, from: "hub@example.org", text: "one\n.two\r\n..three\rfour" });
  const body = message.slice(message.indexOf("\r\n\r\n") + 4);
  assert.equal(body, "one\r\n..two\r\n...three\r\nfour");
  assert.equal(/\r(?!\n)|(?<!\r)\n/.test(message), false);
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
  assert.equal(header(message, "Content-Transfer-Encoding"), "8bit");
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
    assert.ok(session.raw.includes("\r\n\r\nline\r\n..dot\r\nlast\r\n.\r\nQUIT\r\n"));
    assert.equal(session.data.split("\r\n\r\n")[1], "line\r\n..dot\r\nlast");
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
