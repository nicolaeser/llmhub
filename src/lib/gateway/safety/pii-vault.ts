const CREDENTIALS = new Set(["SECRET", "JWT", "PRIVATE_KEY", "CONNECTION_STRING", "ENV_SECRET"]);
const NUMBERED_PLACEHOLDER = /\[[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_\d+\]/g;
const SIGNED_KEYS = new Set(["thinking", "signature", "encrypted_content", "thinking_blocks", "reasoning_details"]);
const JSON_TEXT_KEYS = new Set(["arguments"]);
const asIs = (value: string): string => value;

export const jsonStringBody = (value: string): string => JSON.stringify(value).slice(1, -1);

export class PiiVault {
  private readonly values = new Map<string, string>();
  private readonly tokens = new Map<string, string>();
  private readonly counts = new Map<string, number>();

  placeholder(id: string, value: string): string {
    if (CREDENTIALS.has(id)) return `[${id}]`;
    const key = `${id}\0${value}`;
    const existing = this.tokens.get(key);
    if (existing) return existing;
    const count = (this.counts.get(id) ?? 0) + 1;
    this.counts.set(id, count);
    const token = `[${id}_${count}]`;
    this.tokens.set(key, token);
    this.values.set(token, value);
    return token;
  }

  get size(): number {
    return this.values.size;
  }

  restore(text: string, encode: (value: string) => string = asIs): string {
    return text.replace(NUMBERED_PLACEHOLDER, (token) => {
      const value = this.values.get(token);
      return value === undefined ? token : encode(value);
    });
  }
}

let active: PiiVault | null = null;

export function activeVault(): PiiVault | null {
  return active;
}

export function withActiveVault<T>(vault: PiiVault | null, run: () => T): T {
  const previous = active;
  active = vault;
  try {
    return run();
  } finally {
    active = previous;
  }
}

const traces = new WeakMap<object, PiiVault>();

export function bindPiiVault(trace: object, vault: PiiVault): void {
  traces.set(trace, vault);
}

export function vaultOf(trace: object | undefined): PiiVault | null {
  return trace ? (traces.get(trace) ?? null) : null;
}

export function restoreJson(value: unknown, vault: PiiVault | null, key = ""): unknown {
  if (!vault || SIGNED_KEYS.has(key)) return value;
  if (typeof value === "string") return vault.restore(value, JSON_TEXT_KEYS.has(key) ? jsonStringBody : asIs);
  if (Array.isArray(value)) return value.map((item) => restoreJson(item, vault, key));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [name, item] of Object.entries(value)) out[name] = restoreJson(item, vault, name);
    return out;
  }
  return value;
}
