import { cancelQuietly } from "@/lib/utils/streams";

const CREDENTIALS = new Set(["SECRET", "JWT", "PRIVATE_KEY", "CONNECTION_STRING", "ENV_SECRET"]);

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

  restore(text: string): string {
    return text.replace(/\[[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_\d+\]/g, (token) => this.values.get(token) ?? token);
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

export function restoreJson(value: unknown, vault: PiiVault | null): unknown {
  if (!vault) return value;
  if (typeof value === "string") return vault.restore(value);
  if (Array.isArray(value)) return value.map((item) => restoreJson(item, vault));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = restoreJson(item, vault);
    return out;
  }
  return value;
}

export function restoreSseResponse(response: Response, vault: PiiVault | null): Response {
  if (!vault || !response.body) return response;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const reader = response.body.getReader();
  let pending = "";
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          const text = vault.restore(pending + decoder.decode());
          pending = "";
          if (text) controller.enqueue(encoder.encode(text));
          controller.close();
          return;
        }
        const combined = pending + decoder.decode(value, { stream: true });
        const hold = combined.match(/\[[A-Z0-9_]{0,80}$/);
        pending = hold?.[0] ?? "";
        const emit = vault.restore(hold ? combined.slice(0, -pending.length) : combined);
        if (!emit) continue;
        controller.enqueue(encoder.encode(emit));
        return;
      }
    },
    cancel() {
      void cancelQuietly(reader);
    },
  });
  return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
}
