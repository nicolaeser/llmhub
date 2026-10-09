import type { Socket } from "node:net";

export type MailAttachment = { filename: string; contentType: string; content: Uint8Array | string };

export type MailInput = {
  to: string | string[];
  subject: string;
  text: string;
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
