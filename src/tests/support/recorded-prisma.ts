export type PrismaCall = { model: string; method: string; args: unknown };
export type PrismaHandler = (args: never) => unknown;
type Handlers = Record<string, Record<string, PrismaHandler>>;

export const recordedPrisma = {
  calls: [] as PrismaCall[],
  base: {} as Handlers,
  handlers: {} as Handlers,
  reset(handlers: Handlers = {}): void {
    recordedPrisma.calls.length = 0;
    recordedPrisma.handlers = handlers;
  },
  called(model: string, method?: string): PrismaCall[] {
    return recordedPrisma.calls.filter((call) => call.model === model && (method === undefined || call.method === method));
  },
};

function emptyResult(method: string, args: { data?: object } | undefined): unknown {
  if (method === "findMany" || method === "groupBy") return [];
  if (method === "count") return 0;
  if (method.endsWith("Many")) return { count: 0 };
  if (method === "aggregate") return { _sum: {} };
  if (method === "create" || method === "upsert") return { id: "row-1", ...(args?.data ?? {}) };
  return null;
}

const client: unknown = new Proxy(
  {},
  {
    get: (_client, model: string) => {
      if (model === "$transaction") {
        return async (work: unknown) =>
          typeof work === "function" ? work(client) : Promise.all(work as Promise<unknown>[]);
      }
      return new Proxy(
        {},
        {
          get: (_delegate, method: string) => async (args: never) => {
            recordedPrisma.calls.push({ model, method, args });
            const handler = recordedPrisma.handlers[model]?.[method] ?? recordedPrisma.base[model]?.[method];
            return handler ? handler(args) : emptyResult(method, args);
          },
        },
      );
    },
  },
);

(globalThis as { prisma?: unknown }).prisma = client;
