import "server-only";

import { env } from "@/lib/env";
import { currentBuild } from "@/lib/updates/build";
import { DEVELOPMENT_BUILD } from "@/lib/updates/build-change";

export function exportIdentity(): { instance: string; edition?: string } {
  const build = currentBuild();
  return {
    instance: env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, ""),
    ...(build === DEVELOPMENT_BUILD ? {} : { edition: build }),
  };
}
