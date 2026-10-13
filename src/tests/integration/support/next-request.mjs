let requestHeaders = new globalThis.Headers();
const cookieJar = new Map();

export function setRequestHeaders(init) {
  requestHeaders = new globalThis.Headers(init);
  cookieJar.clear();
}

export async function headers() {
  return requestHeaders;
}

export async function cookies() {
  return {
    get: (name) => (cookieJar.has(name) ? { name, value: cookieJar.get(name) } : undefined),
    getAll: () => [...cookieJar].map(([name, value]) => ({ name, value })),
    has: (name) => cookieJar.has(name),
    set: (name, value) => {
      if (typeof name === "object") cookieJar.set(name.name, name.value);
      else cookieJar.set(name, value);
    },
    delete: (name) => {
      cookieJar.delete(typeof name === "object" ? name.name : name);
    },
  };
}
