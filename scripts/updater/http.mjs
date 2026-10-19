import { Buffer } from "node:buffer";
import http from "node:http";
import https from "node:https";

const BODY_LIMIT = 16 * 1024 * 1024;

export function send(options, body) {
  const transport = options.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = transport.request(options, resolve);
    req.on("timeout", () => req.destroy(new Error(`${options.method} ${options.path} timed out`)));
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

export function readBuffer(res, limit = BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    res.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        res.destroy(new Error("response body is too large"));
        return;
      }
      chunks.push(chunk);
    });
    res.on("end", () => resolve(Buffer.concat(chunks)));
    res.on("error", reject);
    res.on("aborted", () => reject(new Error("response aborted")));
  });
}

export async function readText(res, limit) {
  return (await readBuffer(res, limit)).toString("utf8");
}

export function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
