export function parseJsonOrNull(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export async function readJsonOr(body: Pick<Body, "json">, fallback: unknown): Promise<unknown> {
  try {
    return (await body.json()) as unknown;
  } catch {
    return fallback;
  }
}

export async function readTextOr(body: Pick<Body, "text">, fallback = ""): Promise<string> {
  try {
    return await body.text();
  } catch {
    return fallback;
  }
}
