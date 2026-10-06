import type { Socket } from "node:net";

export type MailInput = { to: string; subject: string; text: string };

export type MailMessage = MailInput & { from: string };

export type MailOptions = {
  url?: string;
  from?: string;
  timeoutMs?: number;
  connect?: (host: string, port: number, secure: boolean) => Socket;
  upgrade?: (socket: Socket, host: string) => Socket;
};
