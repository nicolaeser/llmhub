import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingIncludes: {
    "/internal-api/usage/export": ["./src/lib/export/fonts/*"],
  },
  poweredByHeader: false,
  turbopack: {
    root: path.dirname(fileURLToPath(import.meta.url)),
  },
  allowedDevOrigins: ["localhost", "127.0.0.1"],
  redirects() {
    const moved: [string, string][] = [
      ...["/structure", "/organizations", "/teams", "/projects", "/budgets"].map((source): [string, string] => [
        source,
        "/companies",
      ]),
      ["/subscriptions", "/providers?tab=subscriptions"],
      ["/provider-health", "/providers?tab=health"],
      ["/model-catalog", "/models"],
      ["/model-templates", "/models?tab=presets"],
      ["/roles", "/users?tab=roles"],
      ["/markups", "/usage?tab=markups"],
      ["/what-if", "/usage"],
      ["/admin-settings", "/settings"],
      ["/logging", "/settings?tab=logging"],
      ["/cache", "/settings?tab=cache"],
      ["/playground", "/developer?tab=playground"],
      ["/api-ref", "/developer?tab=api"],
      ["/assistant", "/"],
      ["/integrations", "/mcp"],
    ];
    const movedTabs: [string, string, string][] = [["/keys", "templates", "/models?tab=presets"]];
    return [
      ...moved.map(([source, destination]) => ({ source, destination, permanent: false })),
      ...movedTabs.map(([source, tab, destination]) => ({
        source,
        has: [{ type: "query" as const, key: "tab", value: tab }],
        destination,
        permanent: false,
      })),
    ];
  },
};

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

export default withNextIntl(nextConfig);
