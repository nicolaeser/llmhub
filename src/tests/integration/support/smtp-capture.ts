import { randomInt } from "node:crypto";
import { createServer } from "node:net";

export type CapturedMail = { recipients: string[]; data: string };

export const capturedMail: CapturedMail[] = [];

const server = createServer((socket) => {
  const mail: CapturedMail = { recipients: [], data: "" };
  let buffer = "";
  let dataLines: string[] | null = null;
  socket.setEncoding("utf8");
  socket.write("220 capture.test ESMTP\r\n");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    for (let idx = buffer.indexOf("\r\n"); idx >= 0; idx = buffer.indexOf("\r\n")) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      if (dataLines && line !== ".") {
        dataLines.push(line);
        continue;
      }
      if (dataLines) {
        mail.data = dataLines.join("\n");
        dataLines = null;
        capturedMail.push({ ...mail, recipients: [...mail.recipients] });
        socket.write("250 queued\r\n");
        continue;
      }
      const verb = line.split(/[ :]/)[0].toUpperCase();
      if (verb === "EHLO") socket.write("250 capture.test\r\n");
      else if (verb === "RCPT") {
        mail.recipients.push(/<([^>]*)>/.exec(line)?.[1] ?? "");
        socket.write("250 ok\r\n");
      } else if (verb === "DATA") {
        dataLines = [];
        socket.write("354 go\r\n");
      } else if (verb === "QUIT") socket.end("221 bye\r\n");
      else socket.write("250 ok\r\n");
    }
  });
  socket.on("error", () => undefined);
});

const port = 20_000 + randomInt(10_000);
server.listen(port, "127.0.0.1");
server.unref();
process.env.SMTP_URL = `smtp://127.0.0.1:${port}`;
