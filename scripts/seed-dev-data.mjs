import { validateSeedTarget } from "./seed-dev.mjs";
import { insertDevelopmentFixtures } from "./seed-dev-fixtures.mjs";

validateSeedTarget(process.env, process.argv.slice(2));

const { default: prisma } = await import("../src/lib/db/prisma.ts");
try {
  await insertDevelopmentFixtures(prisma);
} finally {
  try {
    await prisma.$disconnect();
  } finally {
    await globalThis.pool?.end();
  }
}
