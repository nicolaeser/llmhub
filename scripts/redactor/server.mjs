import { Buffer } from "node:buffer";
import http from "node:http";
import { performance } from "node:perf_hooks";
import { readBody } from "./http.mjs";
import { errorCode, log } from "./log.mjs";

export const MODEL_ID = "pii-tracer";
export const DETECT_PATHS = new Set(["/", "/v1/token-classification"]);
export const BODY_LIMIT = 4 * 1024 * 1024;
export const MAX_INPUTS = 64;
export const MAX_QUEUE = 32;

function reply(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

function failure(res, status, type, message) {
  reply(res, status, { error: { type, message } });
}

export function parseInputs(payload) {
  const inputs = payload?.inputs;
  if (typeof inputs === "string") return { texts: [inputs], single: true };
  if (Array.isArray(inputs) && inputs.length <= MAX_INPUTS && inputs.every((item) => typeof item === "string")) {
    return { texts: inputs, single: false };
  }
  return null;
}

export function serialQueue(limit = MAX_QUEUE) {
  let tail = Promise.resolve();
  let waiting = 0;
  return {
    get waiting() {
      return waiting;
    },
    run(task) {
      if (waiting >= limit) return null;
      waiting += 1;
      const result = tail.then(task);
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result.finally(() => {
        waiting -= 1;
      });
    },
  };
}

export function createServer({ classifier, llama }) {
  const queue = serialQueue();

  async function detect(req, res) {
    let payload;
    try {
      payload = JSON.parse((await readBody(req, BODY_LIMIT)).toString("utf8"));
    } catch (err) {
      if (errorCode(err) === "TOO_LARGE") return failure(res, 413, "invalid_request", "request body is too large");
      return failure(res, 400, "invalid_request", "request body must be JSON");
    }
    const parsed = parseInputs(payload);
    if (!parsed) return failure(res, 400, "invalid_request", `inputs must be a string or an array of at most ${MAX_INPUTS} strings`);
    const started = performance.now();
    const work = queue.run(async () => {
      const results = [];
      let tokens = 0;
      for (const text of parsed.texts) {
        if (res.destroyed) break;
        const result = await classifier.classify(text);
        tokens += result.tokens;
        results.push(result.spans);
      }
      return { results, tokens };
    });
    if (!work) return failure(res, 503, "overloaded", "the redactor queue is full");
    try {
      const { results, tokens } = await work;
      log("info", "redactor.detect", {
        inputs: parsed.texts.length,
        tokens,
        spans: results.reduce((sum, list) => sum + list.length, 0),
        ms: Math.round(performance.now() - started),
      });
      reply(res, 200, parsed.single ? results[0] : results);
    } catch (err) {
      log("error", "redactor.detect_failed", { code: errorCode(err), ms: Math.round(performance.now() - started) });
      failure(res, 502, "model_error", "the model server failed");
    }
  }

  async function health(res) {
    try {
      if (await llama.health()) return reply(res, 200, { status: "ok", model: MODEL_ID });
    } catch (err) {
      log("warn", "redactor.health_failed", { code: errorCode(err) });
    }
    failure(res, 503, "unavailable", "the model server is not ready");
  }

  return http.createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (req.method === "GET" && path === "/health") return void health(res);
    if (req.method === "GET" && path === "/v1/models") {
      return reply(res, 200, { object: "list", data: [{ id: MODEL_ID, object: "model", owned_by: "llmhub" }] });
    }
    if (req.method === "POST" && DETECT_PATHS.has(path)) return void detect(req, res);
    failure(res, 404, "not_found", "unknown path");
  });
}
