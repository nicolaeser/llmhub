import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { HttpError, open, requestJson } from "./http.mjs";
import { errorCode, log } from "./log.mjs";
import { CURRENT_LINK, fileFacts, MODEL_FILES, MODEL_REPO, PINNED_FILES, REVISION } from "./model-files.mjs";

const DOWNLOAD_TIMEOUT_MS = 60_000;
const VERIFIED_SUFFIX = ".verified";

function digestOf(facts) {
  return facts.sha256 ? `sha256:${facts.sha256}` : `git-sha1:${facts.gitSha1}`;
}

function hasherFor(facts) {
  if (facts.sha256) return createHash("sha256");
  const hash = createHash("sha1");
  hash.update(`blob ${facts.size}\0`);
  return hash;
}

function expectedHex(facts) {
  return facts.sha256 ?? facts.gitSha1;
}

async function alreadyVerified(file, facts) {
  try {
    const [info, marker] = await Promise.all([stat(file), readFile(`${file}${VERIFIED_SUFFIX}`, "utf8")]);
    return info.size === facts.size && marker.trim() === digestOf(facts);
  } catch {
    return false;
  }
}

function progress(name, total) {
  let seen = 0;
  let reported = 0;
  return new Transform({
    transform(chunk, _encoding, done) {
      seen += chunk.length;
      const percent = total ? Math.floor((seen / total) * 10) * 10 : 0;
      if (percent > reported) {
        reported = percent;
        log("info", "redactor.fetch_progress", { file: name, percent });
      }
      done(null, chunk);
    },
  });
}

export async function downloadFile({ url, file, facts, name }) {
  const part = `${file}.part`;
  const hash = hasherFor(facts);
  const res = await open(url, { timeoutMs: DOWNLOAD_TIMEOUT_MS });
  const status = res.statusCode ?? 0;
  if (status !== 200) {
    res.resume();
    throw new HttpError(status, `download of ${name} answered ${status}`);
  }
  let size = 0;
  const hashing = new Transform({
    transform(chunk, _encoding, done) {
      size += chunk.length;
      hash.update(chunk);
      done(null, chunk);
    },
  });
  await pipeline(res, hashing, progress(name, facts.size), createWriteStream(part, { mode: 0o644 }));
  const digest = hash.digest("hex");
  if (size !== facts.size || digest !== expectedHex(facts)) {
    await rm(part, { force: true });
    throw Object.assign(new Error(`${name} does not match the pinned revision`), { code: "MODEL_DIGEST_MISMATCH" });
  }
  await rename(part, file);
  await writeFile(`${file}${VERIFIED_SUFFIX}`, `${digestOf(facts)}\n`, { mode: 0o644 });
}

async function pointCurrent(dir, revision) {
  const link = path.join(dir, CURRENT_LINK);
  const staged = `${link}.tmp`;
  await unlink(staged).catch(() => undefined);
  await symlink(revision, staged);
  await rename(staged, link);
}

async function pruneOtherRevisions(dir, revision) {
  for (const entry of await readdir(dir)) {
    if (REVISION.test(entry) && entry !== revision) await rm(path.join(dir, entry), { recursive: true, force: true });
  }
}

export async function revisionFacts(endpoint, revision) {
  if (PINNED_FILES[revision]) return PINNED_FILES[revision];
  const tree = await requestJson(`${endpoint}/api/models/${MODEL_REPO}/tree/${revision}`, { timeoutMs: DOWNLOAD_TIMEOUT_MS });
  return fileFacts(tree);
}

export async function fetchModel({ dir, revision, endpoint }) {
  if (!REVISION.test(revision)) {
    throw Object.assign(new Error("LLMHUB_REDACTOR_REVISION must be a 40-character commit hash"), { code: "INVALID_REVISION" });
  }
  const facts = await revisionFacts(endpoint, revision);
  const target = path.join(dir, revision);
  await mkdir(target, { recursive: true });
  for (const name of MODEL_FILES) {
    const file = path.join(target, name);
    if (await alreadyVerified(file, facts[name])) continue;
    log("info", "redactor.fetch_start", { file: name, bytes: facts[name].size, revision });
    try {
      await downloadFile({ url: `${endpoint}/${MODEL_REPO}/resolve/${revision}/${name}`, file, facts: facts[name], name });
    } catch (err) {
      log("error", "redactor.fetch_failed", { file: name, code: errorCode(err) });
      throw err;
    }
    log("info", "redactor.fetch_done", { file: name });
  }
  await pointCurrent(dir, revision);
  await pruneOtherRevisions(dir, revision);
  log("info", "redactor.model_ready", { revision });
}
