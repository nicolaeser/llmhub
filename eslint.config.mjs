import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default defineConfig([
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts", "src/generated/**", "postgres-data/**", "redis-data/**"]),
  js.configs.recommended,
  tseslint.configs.recommended,
  reactHooks.configs.flat["recommended-latest"],
  { rules: { "no-empty": ["error", { allowEmptyCatch: true }] } },
  {
    files: ["scripts/**/*.mjs", "test/**/*.mjs", "*.mjs"],
    languageOptions: { globals: { process: "readonly", console: "readonly", URL: "readonly", setTimeout: "readonly", Buffer: "readonly" } },
  },
]);
