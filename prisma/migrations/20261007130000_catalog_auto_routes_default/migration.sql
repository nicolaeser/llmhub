ALTER TABLE "ModelGroup" ALTER COLUMN "autoRoutes" DROP NOT NULL,
ALTER COLUMN "autoRoutes" DROP DEFAULT;

UPDATE "ModelGroup" AS g
SET "autoRoutes" = NULL
WHERE NOT EXISTS (
  SELECT 1
  FROM "GatewayAuditLog" AS a
  WHERE a."objectType" = 'model'
    AND a."objectId" = g."alias"
    AND (
      a."action" = 'model.auto_routes'
      OR (
        a."action" = 'model.update'
        AND (
          (a."beforeJson" LIKE '%"autoRoutes":true%' AND a."afterJson" LIKE '%"autoRoutes":false%')
          OR (a."beforeJson" LIKE '%"autoRoutes":false%' AND a."afterJson" LIKE '%"autoRoutes":true%')
        )
      )
    )
);
