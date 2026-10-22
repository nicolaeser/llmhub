import { Buffer } from "node:buffer";
import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

const MAX_REDIRECTS = 5;

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = `HTTP_${status}`;
  }
}

function transportOf(url) {
  if (url.protocol === "https:") return https;
  if (url.protocol === "http:") return http;
  throw new Error(`unsupported protocol ${url.protocol}`);
}

export function open(target, { method = "GET", headers = {}, body, timeoutMs = 30_000, redirects = 0 } = {}) {
  const url = target instanceof URL ? target : new URL(target);
  return new Promise((resolve, reject) => {
    const req = transportOf(url).request(url, { method, headers, timeout: timeoutMs }, (res) => {
      const status = res.statusCode ?? 0;
      const location = res.headers.location;
      if (status >= 300 && status < 400 && location && redirects < MAX_REDIRECTS) {
        res.resume();
        resolve(open(new URL(location, url), { method, headers, body, timeoutMs, redirects: redirects + 1 }));
        return;
      }
      resolve(res);
    });
    req.on("timeout", () => req.destroy(Object.assign(new Error(`${method} ${url.host} timed out`), { code: "TIMEOUT" })));
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

export function readBody(res, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    res.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        res.destroy(Object.assign(new Error("response body is too large"), { code: "TOO_LARGE" }));
        return;
      }
      chunks.push(chunk);
    });
    res.on("end", () => resolve(Buffer.concat(chunks)));
    res.on("error", reject);
    res.on("aborted", () => reject(Object.assign(new Error("response aborted"), { code: "ABORTED" })));
  });
}

export async function requestJson(target, { method = "GET", payload, timeoutMs, limit = 1024 * 1024 } = {}) {
  const body = payload === undefined ? undefined : Buffer.from(JSON.stringify(payload));
  const headers = body ? { "content-type": "application/json", "content-length": String(body.length) } : {};
  const res = await open(target, { method, headers, body, timeoutMs });
  const raw = await readBody(res, limit);
  const status = res.statusCode ?? 0;
  if (status < 200 || status >= 300) throw new HttpError(status, `${method} ${new URL(target).pathname} answered ${status}`);
  return JSON.parse(raw.toString("utf8"));
}
