import "server-only";

import { randomUUID } from "node:crypto";
import { connect, isIP, type Socket } from "node:net";
import { hostname } from "node:os";
import { connect as tlsConnect } from "node:tls";
import { env } from "@/lib/env";
import type { MailAttachment, MailInput, MailMessage, MailOptions } from "@/types/mail";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1"]);

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

export function encodeSubject(subject: string): string {
  if (/^[\x20-\x7e]*$/.test(subject)) return subject;
  const words = [""];
  for (const char of subject) {
    if (Buffer.byteLength(words[words.length - 1] + char) > 39) words.push("");
    words[words.length - 1] += char;
  }
  return words.map((word) => `=?UTF-8?B?${b64(word)}?=`).join("\r\n ");
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
  return filename.replace(/[^A-Za-z0-9._-]/g, "_") || "attachment";
}

function attachmentPart(attachment: MailAttachment, boundary: string): string[] {
  const content =
    typeof attachment.content === "string" ? Buffer.from(attachment.content, "utf8") : Buffer.from(attachment.content);
  const name = attachmentName(attachment.filename);
  return [
    `--${boundary}`,
    `Content-Type: ${attachment.contentType}; name="${name}"`,
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: attachment; filename="${name}"`,
    "",
    ...(content.toString("base64").match(/.{1,76}/g) ?? []),
  ];
}

export function buildMessage(message: MailMessage, now = new Date()): string {
  const { from, subject, text } = message;
  const to = recipientsOf(message.to);
  const attachments = message.attachments ?? [];
  const headerValues = [from, subject, ...to, ...attachments.map((item) => item.contentType)];
  if (headerValues.some((value) => /[\r\n]/.test(value))) {
    throw new Error("smtp header contains a line break");
  }
  if (attachments.some((item) => /["\\]/.test(item.contentType))) {
    throw new Error("smtp attachment content type is invalid");
  }
  const domain = /@([^@\s]+)$/.exec(address(from))?.[1] ?? "localhost";
  const body = text.split(/\r\n|\r|\n/).map((line) => (line.startsWith(".") ? `.${line}` : line));
  const headers = [
    `From: ${from}`,
    `To: ${to.join(",\r\n ")}`,
    `Subject: ${encodeSubject(subject)}`,
    `Date: ${now.toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: <${randomUUID()}@${domain}>`,
    "MIME-Version: 1.0",
  ];
  const textHeaders = ["Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: 8bit"];
  if (!attachments.length) return [...headers, ...textHeaders, "", ...body].join("\r\n");
  const boundary = `llmhub-${randomUUID()}`;
  return [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    ...textHeaders,
    "",
    ...body,
    ...attachments.flatMap((attachment) => attachmentPart(attachment, boundary)),
    `--${boundary}--`,
  ].join("\r\n");
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
    await smtp.cmd(`${message}\r\n.`, 250);
    await smtp.cmd("QUIT", 221).catch(() => undefined);
    return { sent: true };
  } finally {
    smtp.close();
  }
}
