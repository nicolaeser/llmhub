import { managementRoute, respond } from "@/lib/management/http";

export const dynamic = "force-dynamic";

export const GET = managementRoute(null, async ({ principal }) =>
  respond({
    object: "principal",
    user: {
      id: principal.user.id,
      username: principal.user.username,
      email: principal.user.email,
    },
    permissions: principal.permissions,
  }),
);
