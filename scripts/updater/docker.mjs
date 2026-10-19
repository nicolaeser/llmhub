import { Buffer } from "node:buffer";
import { URLSearchParams } from "node:url";
import { parseJson, readBuffer, readText, send } from "./http.mjs";

export const DOCKER_SOCKET = "/var/run/docker.sock";

const DEFAULT_TIMEOUT_MS = 30_000;
const PULL_IDLE_TIMEOUT_MS = 10 * 60_000;

export class DockerError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "DockerError";
    this.status = status;
  }
}

function queryString(query) {
  if (!query) return "";
  const entries = Object.entries(query).filter(([, value]) => value !== undefined && value !== null);
  return entries.length ? `?${new URLSearchParams(entries.map(([key, value]) => [key, String(value)]))}` : "";
}

function failureOf(status, text) {
  const json = parseJson(text);
  return new DockerError(status, (json && typeof json.message === "string" ? json.message : text.trim()) || `HTTP ${status}`);
}

function demultiplex(buffer) {
  const lines = [];
  let offset = 0;
  while (offset + 8 <= buffer.length && buffer[offset] <= 2 && buffer[offset + 1] === 0) {
    const size = buffer.readUInt32BE(offset + 4);
    lines.push(buffer.subarray(offset + 8, offset + 8 + size).toString("utf8"));
    offset += 8 + size;
  }
  if (offset < buffer.length) lines.push(buffer.subarray(offset).toString("utf8"));
  return lines.join("");
}

export function untarFirstFile(archive) {
  if (archive.length < 512) return null;
  const size = Number.parseInt(archive.subarray(124, 136).toString("ascii").replace(/\0/g, "").trim(), 8);
  if (!Number.isFinite(size) || archive.length < 512 + size) return null;
  return archive.subarray(512, 512 + size).toString("utf8");
}

function pullFailure(event) {
  if (!event || typeof event !== "object") return null;
  if (event.errorDetail && typeof event.errorDetail.message === "string") return event.errorDetail.message;
  return typeof event.error === "string" ? event.error : null;
}

export function dockerClient(socketPath = DOCKER_SOCKET) {
  function open(method, path, { query, body, timeout = DEFAULT_TIMEOUT_MS } = {}) {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers = payload
      ? { Host: "docker", "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
      : { Host: "docker" };
    return send({ socketPath, method, path: `${path}${queryString(query)}`, headers, timeout }, payload);
  }

  async function call(method, path, options) {
    const res = await open(method, path, options);
    const text = await readText(res);
    if (res.statusCode >= 400) throw failureOf(res.statusCode, text);
    return text ? parseJson(text) : null;
  }

  async function optional(promise) {
    try {
      return await promise;
    } catch (err) {
      if (err instanceof DockerError && err.status === 404) return null;
      throw err;
    }
  }

  async function pull(name, tag) {
    const res = await open("POST", "/images/create", {
      query: { fromImage: name, tag },
      timeout: PULL_IDLE_TIMEOUT_MS,
    });
    if (res.statusCode >= 400) throw failureOf(res.statusCode, await readText(res));
    let pending = "";
    let failure = null;
    let status = null;
    const consume = (line) => {
      const event = parseJson(line.trim());
      failure ??= pullFailure(event);
      if (typeof event?.status === "string" && event.status.startsWith("Status:")) status = event.status;
    };
    await new Promise((resolve, reject) => {
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        pending += chunk;
        let index = pending.indexOf("\n");
        while (index >= 0) {
          consume(pending.slice(0, index));
          pending = pending.slice(index + 1);
          index = pending.indexOf("\n");
        }
      });
      res.on("end", resolve);
      res.on("error", reject);
      res.on("aborted", () => reject(new Error("image pull aborted")));
    });
    if (pending.trim()) consume(pending);
    if (failure) throw new DockerError(500, failure);
    return status;
  }

  async function logs(id, tail) {
    const res = await open("GET", `/containers/${id}/logs`, { query: { stdout: 1, stderr: 1, tail } });
    const buffer = await readBuffer(res, 1024 * 1024);
    if (res.statusCode >= 400) throw failureOf(res.statusCode, buffer.toString("utf8"));
    return demultiplex(buffer);
  }

  async function readFile(id, path) {
    const res = await open("GET", `/containers/${id}/archive`, { query: { path } });
    const archive = await readBuffer(res, 1024 * 1024);
    if (res.statusCode >= 400) throw failureOf(res.statusCode, archive.toString("utf8"));
    return untarFirstFile(archive);
  }

  return {
    readFile,
    inspectContainer: (id) => optional(call("GET", `/containers/${id}/json`)),
    listContainers: (labels, all = false) =>
      call("GET", "/containers/json", { query: { all: String(all), filters: JSON.stringify({ label: labels }) } }),
    inspectImage: (ref, manifests = false) =>
      optional(call("GET", `/images/${ref}/json`, { query: manifests ? { manifests: "1" } : undefined })),
    distribution: (ref) => call("GET", `/distribution/${ref}/json`, { timeout: 60_000 }),
    pull,
    logs,
    create: (name, body) => call("POST", "/containers/create", { query: { name }, body }),
    start: (id) => call("POST", `/containers/${id}/start`),
    stop: (id, seconds) =>
      call("POST", `/containers/${id}/stop`, { query: { t: seconds }, timeout: (seconds + 30) * 1000 }),
    rename: (id, name) => call("POST", `/containers/${id}/rename`, { query: { name } }),
    remove: (id) => call("DELETE", `/containers/${id}`, { query: { force: "true", v: "false" } }),
    removeImage: (id) => call("DELETE", `/images/${id}`),
  };
}
