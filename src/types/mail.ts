import type { Socket } from "node:net";

export type MailAttachment = { filename: string; contentType: string; content: Uint8Array | string };

export type MailInput = {
  to: string | string[];
  subject: string;
  text: string;
  html?: string;
  attachments?: MailAttachment[];
};

export type MailMessage = MailInput & { from: string };

export type MailOptions = {
  url?: string;
  from?: string;
  timeoutMs?: number;
  connect?: (host: string, port: number, secure: boolean) => Socket;
  upgrade?: (socket: Socket, host: string) => Socket;
};

export type MimePart = { headers: string[]; body: string[] };

export type MailHtmlRow = { label: string; value: string };

export type MailHtmlColumn = { label: string; align?: "start" | "end" };

export type MailHtmlTable = { caption?: string; columns: MailHtmlColumn[]; rows: string[][] };

export type MailHtmlLink = { label: string; href: string };

export type MailHtmlInput = {
  lang: string;
  brand: string;
  title: string;
  intro?: string;
  rows?: MailHtmlRow[];
  table?: MailHtmlTable;
  paragraphs?: string[];
  action?: MailHtmlLink;
  footer: string;
};
