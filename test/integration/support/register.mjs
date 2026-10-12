import { registerHooks } from "node:module";

const nextRequest = new URL("./next-request.mjs", import.meta.url).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "next/headers") {
      return { url: nextRequest, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
