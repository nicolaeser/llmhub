export const MODEL_REPO = "perplexity-ai/PII-Tracer-GGUF";
export const DEFAULT_REVISION = "79277a185c6d0a93ab29448e6981ebc722839c2c";
export const BACKBONE_FILE = "pplx-pii-masking-backbone-f16.gguf";
export const HEADS_FILE = "heads.safetensors";
export const HEAD_CONFIG_FILE = "pii_head_config.json";
export const MODEL_FILES = [BACKBONE_FILE, HEADS_FILE, HEAD_CONFIG_FILE];
export const CURRENT_LINK = "current";
export const REVISION = /^[0-9a-f]{40}$/;

export const PINNED_FILES = {
  [DEFAULT_REVISION]: {
    [BACKBONE_FILE]: { size: 1198177888, sha256: "343e6e67f1933b1fe55c9cc9c834224bb5ea573acd57b2042c741eab181fedbd" },
    [HEADS_FILE]: { size: 156136, sha256: "1b52889ee5ba59aac21958cf2e2b5dc7a87603063141f0f02e461bc9fab50f94" },
    [HEAD_CONFIG_FILE]: { size: 1217, gitSha1: "944d30d4734d6b2c61db8cac79b0cf367ebf2565" },
  },
};

export function fileFacts(tree) {
  const facts = {};
  for (const entry of Array.isArray(tree) ? tree : []) {
    if (!entry || typeof entry.path !== "string" || !MODEL_FILES.includes(entry.path)) continue;
    if (entry.lfs && typeof entry.lfs.oid === "string") {
      facts[entry.path] = { size: Number(entry.lfs.size ?? entry.size), sha256: entry.lfs.oid };
    } else if (typeof entry.oid === "string") {
      facts[entry.path] = { size: Number(entry.size), gitSha1: entry.oid };
    }
  }
  const missing = MODEL_FILES.filter((name) => !facts[name]);
  if (missing.length) throw Object.assign(new Error(`revision lacks ${missing.join(", ")}`), { code: "MODEL_FILES_MISSING" });
  return facts;
}
