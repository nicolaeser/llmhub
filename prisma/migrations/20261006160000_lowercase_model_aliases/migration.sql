UPDATE "ModelGroup" AS g
SET "alias" = CASE
  WHEN EXISTS (SELECT 1 FROM "ModelGroup" AS o WHERE o."alias" = lower(g."alias"))
    OR g."alias" <> (
      SELECT min(v."alias")
      FROM "ModelGroup" AS v
      WHERE lower(v."alias") = lower(g."alias") AND v."alias" <> lower(v."alias")
    )
  THEN lower(g."alias") || '-' || substr(md5(g."alias"), 1, 6)
  ELSE lower(g."alias")
END
WHERE g."alias" <> lower(g."alias");

UPDATE "ModelGroup" SET "overflowGroup" = lower("overflowGroup") WHERE "overflowGroup" <> lower("overflowGroup");

UPDATE "ModelGroup" SET "fallbackGroups" = lower("fallbackGroups"::text)::jsonb WHERE "fallbackGroups"::text <> lower("fallbackGroups"::text);

UPDATE "VirtualKey" SET "models" = lower("models"::text)::jsonb WHERE "models"::text <> lower("models"::text);

UPDATE "ModelTemplate" SET "models" = lower("models"::text)::jsonb WHERE "models"::text <> lower("models"::text);
