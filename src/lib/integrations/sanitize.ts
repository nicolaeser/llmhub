const SECRET_KEYS = /^(?:authorization|proxy-authorization|x-api-key|api-key|apikey|cookie|set-cookie|secret|token|access_token|refresh_token|password|passwd)$/i;
const SECRET_TEXT = /\b(?:bearer\s+[a-z0-9._~+/-]{12,}|sk-[a-z0-9]{8,}|glpat-[a-z0-9_-]{8,})/gi;

export function sanitizeForLog(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[truncated]";
  if (typeof value === "string") {
    const trimmed = value.length > 2000 ? `${value.slice(0, 2000)}…` : value;
    return trimmed.replace(SECRET_TEXT, "[redacted]");
  }
  if (typeof value === "number" || typeof value === "boolean" || value == null) return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitizeForLog(item, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value).slice(0, 80)) {
      out[key] = SECRET_KEYS.test(key) ? "[redacted]" : sanitizeForLog(item, depth + 1);
    }
    return out;
  }
  return "[unsupported]";
}

export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  return /^[a-z]/.test(slug) ? slug : `op_${slug || "item"}`.slice(0, 48);
}
