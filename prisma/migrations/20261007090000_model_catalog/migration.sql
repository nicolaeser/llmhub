ALTER TABLE "ModelGroup" ADD COLUMN     "autoRoutes" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "displayName" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "vendor" TEXT NOT NULL DEFAULT '';

CREATE TABLE "CatalogEntry" (
    "providerId" TEXT NOT NULL,
    "upstreamId" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "vendor" TEXT NOT NULL DEFAULT '',
    "alias" TEXT NOT NULL DEFAULT '',
    "source" TEXT NOT NULL DEFAULT '',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "disabled" BOOLEAN NOT NULL DEFAULT false,
    "classifiedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CatalogEntry_pkey" PRIMARY KEY ("providerId","upstreamId")
);

CREATE INDEX "CatalogEntry_alias_idx" ON "CatalogEntry"("alias");

ALTER TABLE "CatalogEntry" ADD CONSTRAINT "CatalogEntry_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "ProviderConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

UPDATE "ModelGroup" AS g
SET "vendor" = v."vendor"
FROM (
  SELECT DISTINCT ON (d."groupAlias")
    d."groupAlias",
    CASE
      WHEN d."kind" IN ('openai', 'anthropic', 'xai', 'typesafe') THEN d."kind"
      WHEN position('/' IN d."model") > 0 THEN
        CASE lower(split_part(d."model", '/', 1)) WHEN 'x-ai' THEN 'xai' ELSE lower(split_part(d."model", '/', 1)) END
      ELSE ''
    END AS "vendor"
  FROM "Deployment" AS d
  ORDER BY
    d."groupAlias",
    CASE
      WHEN d."kind" IN ('openai', 'anthropic', 'xai', 'typesafe') THEN 0
      WHEN d."kind" IN ('openrouter', 'openrouter_eu') THEN 1
      ELSE 2
    END,
    d."id"
) AS v
WHERE g."alias" = v."groupAlias" AND v."vendor" <> '';

UPDATE "ModelGroup" AS g
SET "displayName" = n."name"
FROM (
  SELECT DISTINCT ON (d."groupAlias")
    d."groupAlias",
    CASE
      WHEN d."kind" IN ('openrouter', 'openrouter_eu') THEN regexp_replace(m->>'name', '^[^:]{1,40}:\s+', '')
      ELSE m->>'name'
    END AS "name"
  FROM "Deployment" AS d
  JOIN "ProviderConnection" AS p ON p."id" = d."providerId"
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(p."discovered") = 'array' THEN p."discovered" ELSE '[]'::jsonb END) AS m
  WHERE m->>'id' = d."model" AND coalesce(m->>'name', '') NOT IN ('', d."model")
  ORDER BY
    d."groupAlias",
    CASE
      WHEN d."kind" IN ('openai', 'anthropic', 'xai', 'typesafe') THEN 0
      WHEN d."kind" IN ('openrouter', 'openrouter_eu') THEN 1
      ELSE 2
    END,
    d."id"
) AS n
WHERE g."alias" = n."groupAlias" AND n."name" <> '';
