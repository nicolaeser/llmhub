import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default defineConfig([
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts", "src/generated/**", "postgres-data/**", "redis-data/**"]),
  js.configs.recommended,
  tseslint.configs.recommended,
  reactHooks.configs.flat["recommended-latest"],
  {
    files: [
      "src/lib/**",
      "src/types/**",
      "src/schemas/**",
      "src/worker/**",
      "src/app/api/**",
      "src/app/internal-api/**",
      "src/app/scim/**",
      "src/app/sso/**",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/app/*", "@/app/**"],
              message: "Server actions and route modules belong to their page. Import the service from src/lib instead.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["scripts/**/*.mjs", "test/**/*.mjs", "*.mjs"],
    languageOptions: { globals: { process: "readonly", console: "readonly", URL: "readonly", setTimeout: "readonly", Buffer: "readonly" } },
  },
]);
