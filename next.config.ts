import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  turbopack: {
    root: path.dirname(fileURLToPath(import.meta.url)),
  },
  allowedDevOrigins: ["localhost", "127.0.0.1"],
  redirects() {
    return ["/organizations", "/teams", "/projects", "/budgets"].map((source) => ({
      source,
      destination: "/structure",
      permanent: false,
    }));
  },
};

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

export default withNextIntl(nextConfig);
