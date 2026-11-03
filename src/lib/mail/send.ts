import "server-only";

import { randomUUID } from "node:crypto";
import { connect, isIP, type Socket } from "node:net";
import { hostname } from "node:os";
import { connect as tlsConnect } from "node:tls";
import { env } from "@/lib/env";
import type { MailAttachment, MailInput, MailMessage, MailOptions, MimePart } from "@/types/mail";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1"]);

export const MAIL_HTML_MAX_BYTES = 1024 * 1024;
export const MAIL_MESSAGE_MAX_BYTES = 20 * 1024 * 1024;

const QP_LINE = 76;
const HEADER_LINE = 78;
const LINE_LIMIT = 998;
const WORD_BYTES = 39;
const FILENAME_MAX = 100;

function b64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

function address(value: string): string {
  return /<([^<>]*)>\s*$/.exec(value)?.[1] ?? value;
}

function heloName(): string {
  const name = hostname();
  return name.includes(".") ? name : "[127.0.0.1]";
}

function open(host: string, port: number, secure: boolean): Socket {
  return secure
    ? tlsConnect({ host, port, servername: isIP(host) ? undefined : host })
    : connect({ host, port });
}

function upgrade(socket: Socket, host: string): Socket {
  return tlsConnect({ socket, host, servername: isIP(host) ? undefined : host });
}

function sizeError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

function encodedWords(value: string): string[] {
  const words = [""];
  for (const char of value) {
    if (Buffer.byteLength(words[words.length - 1] + char) > WORD_BYTES) words.push("");
    words[words.length - 1] += char;
  }
  return words.map((word) => `=?UTF-8?B?${b64(word)}?=`);
}

function plainHeaderText(value: string): boolean {
  return /^[\x20-\x7e]*$/.test(value) && !value.includes("=?");
}

export function encodeSubject(subject: string): string {
  if (plainHeaderText(subject) && !/\S{77}/.test(subject)) return subject;
  return encodedWords(subject).join("\r\n ");
}

export function encodeMailbox(value: string): string {
  const mailbox = value.trim();
  const match = /^(.*?)\s*<([^<>]*)>$/.exec(mailbox);
  if (!match?.[1]) return mailbox;
  const name = match[1].replace(/^"(.*)"$/, "$1").replace(/\\(.)/g, "$1");
  if (plainHeaderText(name)) return mailbox;
  return `${encodedWords(name).join(" ")} <${match[2]}>`;
}

function foldHeader(line: string): string[] {
  if (line.length <= HEADER_LINE) return [line];
  const start = Math.max(line.search(/\S/), 0);
  const before = line.lastIndexOf(" ", HEADER_LINE);
  const cut = before > start ? before : line.indexOf(" ", start + 1);
  if (cut < 0 || !line.slice(cut).trim()) return [line];
  return [line.slice(0, cut), ...foldHeader(line.slice(cut))];
}

function headerLines(headers: string[]): string[] {
  return headers.flatMap((header) => header.split("\r\n").flatMap(foldHeader));
}

function quotedPrintableTokens(line: string): string[] {
  const bytes = Buffer.from(line, "utf8");
  return Array.from(bytes, (byte, index) => {
    const printable = byte >= 33 && byte <= 126 && byte !== 61;
    const innerSpace = (byte === 32 || byte === 9) && index < bytes.length - 1;
    return printable || innerSpace ? String.fromCharCode(byte) : `=${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  });
}

export function quotedPrintable(text: string): string[] {
  return text.split(/\r\n|\r|\n/).flatMap((line) => {
    const lines: string[] = [];
    let current = "";
    for (const token of quotedPrintableTokens(line)) {
      if (current.length + token.length >= QP_LINE) {
        lines.push(`${current}=`);
        current = "";
      }
      current += !current && token === "." ? "=2E" : token;
    }
    return [...lines, current];
  });
}

export function mailEnabled(): boolean {
  return Boolean(env.SMTP_URL);
}

export function mailErrorCode(err: unknown): string {
  if (!(err instanceof Error)) return "MAIL_FAILED";
  const reply = /^smtp (\d{3})\b/.exec(err.message);
  if (reply) return `SMTP_${reply[1]}`;
  if (err.message === "smtp timeout") return "SMTP_TIMEOUT";
  if ("code" in err && typeof err.code === "string" && /^[A-Z][A-Z0-9_]{1,40}$/.test(err.code)) return err.code;
  return "MAIL_FAILED";
}

export function recipientsOf(to: MailInput["to"]): string[] {
  const list = (Array.isArray(to) ? to : [to]).map((value) => value.trim()).filter(Boolean);
  if (!list.length) throw new Error("smtp message has no recipient");
  return list;
}

function attachmentName(filename: string): string {
  const name = filename.replace(/[^A-Za-z0-9._-]/g, "_") || "attachment";
  if (name.length <= FILENAME_MAX) return name;
  const extension = /\.[A-Za-z0-9]{1,10}$/.exec(name)?.[0] ?? "";
  return name.slice(0, FILENAME_MAX - extension.length) + extension;
}

function textPart(subtype: "plain" | "html", content: string): MimePart {
  return {
    headers: [`Content-Type: text/${subtype}; charset=utf-8`, "Content-Transfer-Encoding: quoted-printable"],
    body: quotedPrintable(content),
  };
}

function attachmentPart(attachment: MailAttachment): MimePart {
  const content =
    typeof attachment.content === "string" ? Buffer.from(attachment.content, "utf8") : Buffer.from(attachment.content);
  const name = attachmentName(attachment.filename);
  return {
    headers: [
      `Content-Type: ${attachment.contentType}; name="${name}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${name}"`,
    ],
    body: content.toString("base64").match(/.{1,76}/g) ?? [],
  };
}

function multipart(subtype: "alternative" | "mixed", parts: MimePart[]): MimePart {
  const boundary = `=_${randomUUID().replaceAll("-", "")}`;
  return {
    headers: [`Content-Type: multipart/${subtype}; boundary="${boundary}"`],
    body: [
      ...parts.flatMap((part) => [`--${boundary}`, ...headerLines(part.headers), "", ...part.body]),
      `--${boundary}--`,
    ],
  };
}

export function buildMessage(message: MailMessage, now = new Date()): string {
  const { from, subject, text, html } = message;
  const to = recipientsOf(message.to);
  const attachments = message.attachments ?? [];
  const headerValues = [from, subject, ...to, ...attachments.map((item) => item.contentType)];
  if (headerValues.some((value) => /[\r\n]/.test(value))) {
    throw new Error("smtp header contains a line break");
  }
  if (attachments.some((item) => /["\\]/.test(item.contentType))) {
    throw new Error("smtp attachment content type is invalid");
  }
  if (html && Buffer.byteLength(html) > MAIL_HTML_MAX_BYTES) {
    throw sizeError("smtp html body is too large", "MAIL_HTML_TOO_LARGE");
  }
  const domain = /@([^@\s]+)$/.exec(address(from))?.[1] ?? "localhost";
  const content = html ? multipart("alternative", [textPart("plain", text), textPart("html", html)]) : textPart("plain", text);
  const root = attachments.length ? multipart("mixed", [content, ...attachments.map(attachmentPart)]) : content;
  const lines = [
    ...headerLines([
      `From: ${encodeMailbox(from)}`,
      `To: ${to.map(encodeMailbox).join(",\r\n ")}`,
      `Subject: ${encodeSubject(subject)}`,
      `Date: ${now.toUTCString().replace("GMT", "+0000")}`,
      `Message-ID: <${randomUUID()}@${domain}>`,
      "MIME-Version: 1.0",
      ...root.headers,
    ]),
    "",
    ...root.body,
  ];
  if (lines.some((line) => Buffer.byteLength(line) > LINE_LIMIT)) {
    throw new Error("smtp line is too long");
  }
  const built = lines.join("\r\n");
  if (Buffer.byteLength(built) > MAIL_MESSAGE_MAX_BYTES) {
    throw sizeError("smtp message is too large", "MAIL_TOO_LARGE");
  }
  return built;
}

function stuffDots(message: string): string {
  return message.replace(/^\./gm, "..");
}

class SmtpSession {
  private buf = "";
  private lines: string[] = [];
  private failure: Error | undefined;
  private wake: (() => void) | undefined;
  private readonly sockets = new Set<Socket>();

  constructor(
    private socket: Socket,
    private readonly timeoutMs: number,
  ) {
    this.attach(socket);
  }

  private readonly onData = (chunk: string) => {
    const parts = (this.buf + chunk).split("\n");
    this.buf = parts.pop() ?? "";
    this.lines.push(...parts.map((line) => line.replace(/\r$/, "")));
    this.wake?.();
  };

  private readonly onError = (err: Error) => this.fail(err);

  private readonly onClose = () => this.fail(new Error("smtp connection closed"));

  private readonly onTimeout = () => {
    this.fail(new Error("smtp timeout"));
    this.socket.destroy();
  };

  attach(socket: Socket) {
    this.socket = socket;
    this.sockets.add(socket);
    socket.setEncoding("utf8");
    socket.setTimeout(this.timeoutMs);
    socket
      .on("data", this.onData)
      .on("error", this.onError)
      .on("close", this.onClose)
      .on("timeout", this.onTimeout);
  }

  detach(): Socket {
    if (this.buf || this.lines.length) throw new Error("smtp unexpected data before TLS");
    this.socket.setTimeout(0);
    this.socket.off("data", this.onData).off("close", this.onClose).off("timeout", this.onTimeout);
    return this.socket;
  }

  close() {
    for (const socket of this.sockets) socket.destroy();
  }

  async read(...codes: number[]): Promise<string[]> {
    const lines: string[] = [];
    for (;;) {
      const match = /^(\d{3})([ -]|$)(.*)$/.exec(await this.next());
      if (!match) throw new Error("smtp malformed reply");
      lines.push(match[3]);
      if (match[2] === "-") continue;
      if (!codes.includes(Number(match[1]))) throw new Error(`smtp ${match[1]} ${lines.join(" ")}`.trim());
      return lines;
    }
  }

  cmd(line: string, ...codes: number[]): Promise<string[]> {
    this.socket.write(`${line}\r\n`);
    return this.read(...codes);
  }

  private fail(err: Error) {
    this.failure ??= err;
    this.wake?.();
  }

  private async next(): Promise<string> {
    for (;;) {
      const line = this.lines.shift();
      if (line !== undefined) return line;
      if (this.failure) throw this.failure;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }
}

export async function sendMail(
  input: MailInput,
  options: MailOptions = {},
): Promise<{ sent: boolean }> {
  const smtpUrl = options.url ?? env.SMTP_URL;
  if (!smtpUrl) return { sent: false };
  const url = new URL(smtpUrl);
  const secure = url.protocol === "smtps:";
  if (!secure && url.protocol !== "smtp:") throw new Error("SMTP_URL must use smtp:// or smtps://");
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
  const port = Number(url.port || (secure ? 465 : 587));
  const user = decodeURIComponent(url.username);
  const pass = decodeURIComponent(url.password);
  const from = options.from ?? (env.SMTP_FROM || "llmhub@localhost");
  const message = buildMessage({ ...input, from });
  const recipients = recipientsOf(input.to);
  const smtp = new SmtpSession((options.connect ?? open)(host, port, secure), options.timeoutMs ?? 20_000);
  const ehlo = async () =>
    new Set((await smtp.cmd(`EHLO ${heloName()}`, 250)).slice(1).flatMap((line) => line.toUpperCase().split(/[ =]/)));
  try {
    await smtp.read(220);
    let caps = await ehlo();
    if (!secure && caps.has("STARTTLS")) {
      await smtp.cmd("STARTTLS", 220);
      smtp.attach((options.upgrade ?? upgrade)(smtp.detach(), host));
      caps = await ehlo();
    } else if (!secure && !LOOPBACK.has(host.toLowerCase())) {
      throw new Error("smtp server does not offer STARTTLS");
    }
    if (user && pass) {
      if (caps.has("PLAIN")) {
        await smtp.cmd(`AUTH PLAIN ${b64(`\0${user}\0${pass}`)}`, 235);
      } else {
        await smtp.cmd("AUTH LOGIN", 334);
        await smtp.cmd(b64(user), 334);
        await smtp.cmd(b64(pass), 235);
      }
    }
    await smtp.cmd(`MAIL FROM:<${address(from)}>${caps.has("8BITMIME") ? " BODY=8BITMIME" : ""}`, 250);
    for (const recipient of recipients) await smtp.cmd(`RCPT TO:<${address(recipient)}>`, 250, 251);
    await smtp.cmd("DATA", 354);
    await smtp.cmd(`${stuffDots(message)}\r\n.`, 250);
    await smtp.cmd("QUIT", 221).catch(() => undefined);
    return { sent: true };
  } finally {
    smtp.close();
  }
}
