import "server-only";
import prisma from "@/lib/db/prisma";
import { roleTemplateKeys, roleTemplates } from "@/lib/auth/permissions";
import { ensureRedactorProvider } from "@/lib/bootstrap/redactor-provider";
import { adoptMcpAccessLevels } from "@/lib/bootstrap/mcp-access-levels";
import { adoptRetentionDefaults } from "@/lib/bootstrap/retention-defaults";

const TEMPLATES_SEEDED = "role_templates_seeded";

let pending: Promise<void> | null = null;

async function seedRoleTemplates(): Promise<void> {
  const seeded = await prisma.setting.findUnique({ where: { key: TEMPLATES_SEEDED } });
  if (seeded) return;
  for (const templateKey of roleTemplateKeys) {
    await prisma.role.upsert({
      where: { templateKey },
      update: {},
      create: { templateKey, permissions: [...roleTemplates[templateKey]] },
    });
  }
  await prisma.setting.upsert({
    where: { key: TEMPLATES_SEEDED },
    update: {},
    create: { key: TEMPLATES_SEEDED, value: "1" },
  });
}

async function upsertCatalog(): Promise<void> {
  await seedRoleTemplates();

  await prisma.setting.upsert({
    where: { key: "enterprise" },
    update: {},
    create: {
      key: "enterprise",
      value: JSON.stringify({
        cache_ttl_seconds: 0,
        pii: { enabled: true, mode: "mask", output: true },
      }),
    },
  });
  await adoptRetentionDefaults();
  await adoptMcpAccessLevels();
  await ensureRedactorProvider();
}

export function ensureSystemCatalog(): Promise<void> {
  if (!pending) pending = upsertCatalog();
  return pending;
}
