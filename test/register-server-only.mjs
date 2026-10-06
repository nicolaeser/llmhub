import { registerHooks } from "node:module";

const empty = new URL(
  "../node_modules/next/dist/compiled/server-only/empty.js",
  import.meta.url,
).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { url: empty, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
