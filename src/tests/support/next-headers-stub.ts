import { registerHooks } from "node:module";

const jar = new Map<string, string>();
let requestHeaders = new Headers();

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "next/headers") return { url: import.meta.url, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

export function setRequest(init: { cookies?: Record<string, string>; headers?: HeadersInit } = {}): void {
  requestHeaders = new Headers(init.headers);
  jar.clear();
  for (const [name, value] of Object.entries(init.cookies ?? {})) jar.set(name, value);
}

export async function headers(): Promise<Headers> {
  return requestHeaders;
}

export async function cookies() {
  return {
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    getAll: () => [...jar].map(([name, value]) => ({ name, value })),
    has: (name: string) => jar.has(name),
    set: (name: string | { name: string; value: string }, value?: string) => {
      if (typeof name === "string") jar.set(name, value ?? "");
      else jar.set(name.name, name.value);
    },
    delete: (name: string | { name: string }) => {
      jar.delete(typeof name === "string" ? name : name.name);
    },
  };
}
