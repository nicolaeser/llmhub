import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createClassifier, MAX_WINDOW } from "./redactor/classify.mjs";
import { fetchModel } from "./redactor/fetch.mjs";
import { readSafetensors } from "./redactor/heads.mjs";
import { requestJson } from "./redactor/http.mjs";
import { llamaClient } from "./redactor/llama.mjs";
import { errorCode, log } from "./redactor/log.mjs";
import { CURRENT_LINK, DEFAULT_REVISION, HEAD_CONFIG_FILE, HEADS_FILE } from "./redactor/model-files.mjs";
import { createServer } from "./redactor/server.mjs";

const DEFAULT_MODEL_URL = "http://redactor-model:8080";
const DEFAULT_PORT = 8080;

function settings() {
  const port = Number(process.env.LLMHUB_REDACTOR_PORT?.trim() || DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("LLMHUB_REDACTOR_PORT must be a port number");
  return {
    dir: process.env.LLMHUB_REDACTOR_MODEL_DIR?.trim() || "/models",
    revision: process.env.LLMHUB_REDACTOR_REVISION?.trim() || DEFAULT_REVISION,
    endpoint: (process.env.HF_ENDPOINT?.trim() || "https://huggingface.co").replace(/\/+$/, ""),
    modelUrl: process.env.LLMHUB_REDACTOR_MODEL_URL?.trim() || DEFAULT_MODEL_URL,
    port,
  };
}

async function healthcheck(port) {
  try {
    const body = await requestJson(`http://127.0.0.1:${port}/health`, { timeoutMs: 4_000 });
    return body?.status === "ok" ? 0 : 1;
  } catch {
    return 1;
  }
}

async function serve(config) {
  const current = path.join(config.dir, CURRENT_LINK);
  const [tensors, headConfig] = await Promise.all([
    readFile(path.join(current, HEADS_FILE)).then(readSafetensors),
    readFile(path.join(current, HEAD_CONFIG_FILE), "utf8").then(JSON.parse),
  ]);
  const llama = llamaClient(config.modelUrl);
  const window = Math.min(MAX_WINDOW, await llama.contextSize());
  const classifier = createClassifier({ llama, tensors, headConfig, window });
  const server = createServer({ classifier, llama });
  server.listen(config.port, "0.0.0.0", () => log("info", "redactor.listening", { port: config.port, window, labels: classifier.labels }));
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

async function main() {
  const config = settings();
  if (process.argv.includes("--healthcheck")) {
    process.exitCode = await healthcheck(config.port);
    return;
  }
  if (process.argv.includes("fetch")) {
    await fetchModel(config);
    return;
  }
  await serve(config);
}

main().catch((err) => {
  log("error", "redactor.failed", { code: errorCode(err), message: err instanceof Error ? err.message.slice(0, 300) : "" });
  process.exit(1);
});
