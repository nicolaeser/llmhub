CREATE TABLE "PolicyOverride" (
    "id" TEXT NOT NULL,
    "orgId" TEXT,
    "teamId" TEXT,
    "projectId" TEXT,
    "keyId" TEXT,
    "pii" JSONB,
    "injection" JSONB,
    "secrets" JSONB,
    "rules" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PolicyOverride_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PolicyOverride_one_target" CHECK (num_nonnulls("orgId", "teamId", "projectId", "keyId") = 1)
);

CREATE UNIQUE INDEX "PolicyOverride_orgId_key" ON "PolicyOverride"("orgId");

CREATE UNIQUE INDEX "PolicyOverride_teamId_key" ON "PolicyOverride"("teamId");

CREATE UNIQUE INDEX "PolicyOverride_projectId_key" ON "PolicyOverride"("projectId");

CREATE UNIQUE INDEX "PolicyOverride_keyId_key" ON "PolicyOverride"("keyId");

ALTER TABLE "PolicyOverride" ADD CONSTRAINT "PolicyOverride_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PolicyOverride" ADD CONSTRAINT "PolicyOverride_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PolicyOverride" ADD CONSTRAINT "PolicyOverride_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PolicyOverride" ADD CONSTRAINT "PolicyOverride_keyId_fkey" FOREIGN KEY ("keyId") REFERENCES "VirtualKey"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "PolicyOverride" ("id", "orgId", "projectId", "keyId", "pii", "injection", "secrets", "rules", "updatedAt")
SELECT
    'policy_' || source."scope" || '_' || source."targetId",
    CASE WHEN source."scope" = 'org' THEN source."targetId" END,
    CASE WHEN source."scope" = 'project' THEN source."targetId" END,
    CASE WHEN source."scope" = 'key' THEN source."targetId" END,
    CASE WHEN jsonb_typeof(source."piiPolicy") = 'object' THEN source."piiPolicy" END,
    CASE WHEN jsonb_typeof(source."guardrailPolicy") = 'object' THEN
        CASE WHEN jsonb_typeof(source."guardrailPolicy" -> 'injection') = 'object'
            THEN source."guardrailPolicy" -> 'injection' ELSE '{}'::jsonb END
    END,
    CASE WHEN jsonb_typeof(source."guardrailPolicy") = 'object' THEN
        CASE WHEN jsonb_typeof(source."guardrailPolicy" -> 'secrets') = 'object'
            THEN source."guardrailPolicy" -> 'secrets' ELSE '{}'::jsonb END
    END,
    CASE WHEN jsonb_typeof(source."guardrailPolicy") = 'object' THEN
        CASE WHEN jsonb_typeof(source."guardrailPolicy" -> 'rules') = 'array'
            THEN source."guardrailPolicy" -> 'rules' ELSE '[]'::jsonb END
    END,
    CURRENT_TIMESTAMP
FROM (
    SELECT 'org' AS "scope", "id" AS "targetId", "piiPolicy", "guardrailPolicy" FROM "Organization"
    UNION ALL
    SELECT 'project', "id", "piiPolicy", "guardrailPolicy" FROM "Project"
    UNION ALL
    SELECT 'key', "id", "piiPolicy", "guardrailPolicy" FROM "VirtualKey"
) AS source
WHERE jsonb_typeof(source."piiPolicy") = 'object' OR jsonb_typeof(source."guardrailPolicy") = 'object';

ALTER TABLE "Organization" DROP COLUMN "guardrailPolicy",
DROP COLUMN "piiPolicy";

ALTER TABLE "Project" DROP COLUMN "guardrailPolicy",
DROP COLUMN "piiPolicy";

ALTER TABLE "VirtualKey" DROP COLUMN "guardrailPolicy",
DROP COLUMN "piiPolicy";
