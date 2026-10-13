import "server-only";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import { Readable } from "node:stream";
import { McpError } from "@/lib/mcp/errors";
import { addressAllowed, checkServerUrl } from "@/lib/mcp/url-guard";
import type { McpFetch } from "@/types/mcp";

const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

function pinnedLookup(internal: boolean): LookupFunction {
  return (hostname, options, callback) => {
    dnsLookup(hostname, { all: true, family: options.family ?? 0, hints: options.hints }, (err, found) => {
      if (err) {
        callback(err, "", 0);
        return;
      }
      const addresses = found as LookupAddress[];
      if (!addresses.length || addresses.some((entry) => !addressAllowed(entry.address, internal))) {
        callback(new McpError("MCP_URL_BLOCKED"), "", 0);
        return;
      }
      if (options.all) callback(null, addresses);
      else callback(null, addresses[0]!.address, addresses[0]!.family);
    });
  };
}

function responseHeaders(res: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(res.headers)) {
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else if (value !== undefined) headers.set(name, value);
  }
  return headers;
}

export function guardedFetch(internal: boolean): McpFetch {
  return (url, init) =>
    new Promise<Response>((resolve, reject) => {
      const verdict = checkServerUrl(url, internal);
      if (!verdict.ok) {
        reject(new McpError(verdict.code));
        return;
      }
      const send = verdict.url.protocol === "https:" ? httpsRequest : httpRequest;
      const req = send(
        verdict.url,
        {
          method: init.method,
          headers: init.headers,
          signal: init.signal,
          lookup: pinnedLookup(internal),
        },
        (res) => {
          const status = res.statusCode ?? 502;
          if (status < 200 || NULL_BODY_STATUS.has(status)) {
            res.resume();
            resolve(new Response(null, { status: status < 200 ? 502 : status, headers: responseHeaders(res) }));
            return;
          }
          resolve(
            new Response(Readable.toWeb(res) as ReadableStream<Uint8Array>, {
              status,
              headers: responseHeaders(res),
            }),
          );
        },
      );
      req.on("error", (err) => reject(err instanceof McpError ? err : (err.cause instanceof McpError ? err.cause : err)));
      if (init.body !== undefined) req.write(init.body);
      req.end();
    });
}
