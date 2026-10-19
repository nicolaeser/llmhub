const RELEASE_TAG = /^(?:v|dev-)\d{4}\.\d{2}\.\d{2}\.[0-9a-f]{7,40}$/;
const COMMIT_TAG = /^(?:sha-|dev-)?[0-9a-f]{7,40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

export function parseImageRef(ref) {
  const value = String(ref ?? "").trim();
  if (!value || DIGEST.test(value)) return null;
  const at = value.indexOf("@");
  const digest = at >= 0 ? value.slice(at + 1) : null;
  const named = at >= 0 ? value.slice(0, at) : value;
  const slash = named.lastIndexOf("/");
  const colon = named.lastIndexOf(":");
  const tag = colon > slash ? named.slice(colon + 1) : null;
  const name = colon > slash ? named.slice(0, colon) : named;
  if (!name) return null;
  return { name, tag: tag ?? (digest ? null : "latest"), digest };
}

export function normalizeRepository(name) {
  const parts = String(name).split("/");
  const hasRegistry = parts.length > 1 && (/[.:]/.test(parts[0]) || parts[0] === "localhost");
  if (hasRegistry && parts[0] !== "docker.io" && parts[0] !== "index.docker.io") return parts.join("/");
  const path = hasRegistry ? parts.slice(1) : parts;
  return path.length === 1 ? `docker.io/library/${path[0]}` : `docker.io/${path.join("/")}`;
}

export function isPinned(ref) {
  if (!ref || ref.digest || !ref.tag) return true;
  return RELEASE_TAG.test(ref.tag) || COMMIT_TAG.test(ref.tag);
}

export function digestsFor(repoDigests, name) {
  const wanted = normalizeRepository(name);
  return (Array.isArray(repoDigests) ? repoDigests : []).flatMap((entry) => {
    const at = String(entry).lastIndexOf("@");
    if (at < 0) return [];
    const digest = String(entry).slice(at + 1);
    return normalizeRepository(String(entry).slice(0, at)) === wanted && DIGEST.test(digest) ? [digest] : [];
  });
}

export function updateAvailable(latestDigest, runningDigests) {
  return Boolean(latestDigest) && !runningDigests.includes(latestDigest);
}

export function imageRefOf(ref) {
  return `${ref.name}:${ref.tag}`;
}
