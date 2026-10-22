import { URL } from "node:url";
import { requestJson } from "./http.mjs";

const TOKENIZE_LIMIT = 16 * 1024 * 1024;
const EMBED_LIMIT = 256 * 1024 * 1024;

function malformed(message) {
  return Object.assign(new Error(message), { code: "LLAMA_MALFORMED" });
}

export function llamaClient(base, { timeoutMs = 120_000 } = {}) {
  const url = (path) => new URL(path, base);
  return {
    async health() {
      const body = await requestJson(url("/health"), { timeoutMs: 5_000 });
      return body?.status === "ok";
    },
    async contextSize() {
      const body = await requestJson(url("/props"), { timeoutMs: 5_000 });
      const size = Number(body?.default_generation_settings?.n_ctx);
      if (!Number.isInteger(size) || size <= 0) throw malformed("props answered without a context size");
      return size;
    },
    async tokenize(text) {
      const body = await requestJson(url("/tokenize"), {
        method: "POST",
        payload: { content: text, add_special: false, parse_special: false, with_pieces: true },
        timeoutMs,
        limit: TOKENIZE_LIMIT,
      });
      const tokens = Array.isArray(body?.tokens) ? body.tokens : null;
      if (!tokens || tokens.some((token) => typeof token?.id !== "number" || token.piece === undefined)) {
        throw malformed("tokenize answered without token pieces");
      }
      return tokens.map((token) => ({ id: token.id, piece: token.piece }));
    },
    async embed(ids) {
      const body = await requestJson(url("/embeddings"), {
        method: "POST",
        payload: { content: ids },
        timeoutMs,
        limit: EMBED_LIMIT,
      });
      const first = Array.isArray(body) ? body[0] : body;
      const states = first?.embedding;
      if (!Array.isArray(states) || !states.every(Array.isArray)) throw malformed("embeddings answered without per-token states");
      return states;
    },
  };
}
