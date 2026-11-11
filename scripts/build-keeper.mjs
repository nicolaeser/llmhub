import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));

export const KEEPER_OUT_DIR = ".next/keeper";

await build({
  absWorkingDir: root,
  entryPoints: { keeper: "src/keeper/main.ts" },
  outdir: KEEPER_OUT_DIR,
  outExtension: { ".js": ".mjs" },
  chunkNames: "chunks/[name]-[hash]",
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "node",
  target: "node24",
  tsconfig: "tsconfig.json",
  alias: { "server-only": "./node_modules/server-only/empty.js" },
  external: ["pg-native"],
  banner: { js: 'import { createRequire as __keeperRequire } from "node:module";\nconst require = __keeperRequire(import.meta.url);' },
  logLevel: "warning",
});
