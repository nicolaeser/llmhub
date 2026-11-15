BEGIN;

LOCK TABLE "RequestLog" IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE "RequestLogContent" IN ACCESS EXCLUSIVE MODE;

CREATE TABLE "RequestLogContent_plain" (
    LIKE "RequestLogContent" INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING STORAGE
);

INSERT INTO "RequestLogContent_plain" ("logId", "request", "response", "truncated", "createdAt")
SELECT "logId", "request", "response", "truncated", "createdAt" FROM "RequestLogContent";

ALTER TABLE "RequestLogContent_plain" ADD CONSTRAINT "RequestLogContent_plain_pkey" PRIMARY KEY ("logId", "createdAt");
CREATE INDEX "RequestLogContent_plain_createdAt_idx" ON "RequestLogContent_plain"("createdAt");
ALTER TABLE "RequestLogContent_plain" ADD CONSTRAINT "RequestLogContent_plain_logId_fkey"
FOREIGN KEY ("logId") REFERENCES "RequestLog"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DO $$
DECLARE
    original_owner name;
    privilege record;
    grantee_name text;
BEGIN
    SELECT pg_get_userbyid(relowner) INTO original_owner
    FROM pg_class WHERE oid = '"RequestLogContent"'::regclass;

    FOR privilege IN
        SELECT DISTINCT acl.grantee
        FROM pg_class c, LATERAL aclexplode(c.relacl) acl
        WHERE c.oid = '"RequestLogContent_plain"'::regclass
    LOOP
        grantee_name := CASE WHEN privilege.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(privilege.grantee)) END;
        EXECUTE format('REVOKE ALL ON TABLE "RequestLogContent_plain" FROM %s', grantee_name);
    END LOOP;

    FOR privilege IN
        SELECT acl.* FROM pg_class c, LATERAL aclexplode(c.relacl) acl
        WHERE c.oid = '"RequestLogContent"'::regclass
    LOOP
        grantee_name := CASE WHEN privilege.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(privilege.grantee)) END;
        EXECUTE format('GRANT %s ON TABLE "RequestLogContent_plain" TO %s%s',
            privilege.privilege_type, grantee_name, CASE WHEN privilege.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
    END LOOP;

    FOR privilege IN
        SELECT a.attname, acl.* FROM pg_attribute a, LATERAL aclexplode(a.attacl) acl
        WHERE a.attrelid = '"RequestLogContent"'::regclass AND a.attnum > 0 AND NOT a.attisdropped
    LOOP
        grantee_name := CASE WHEN privilege.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(privilege.grantee)) END;
        EXECUTE format('GRANT %s (%I) ON TABLE "RequestLogContent_plain" TO %s%s',
            privilege.privilege_type, privilege.attname, grantee_name, CASE WHEN privilege.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
    END LOOP;

    EXECUTE format('ALTER TABLE "RequestLogContent_plain" OWNER TO %I', original_owner);
END
$$;

DROP TABLE "RequestLogContent";
ALTER TABLE "RequestLogContent_plain" RENAME TO "RequestLogContent";
ALTER TABLE "RequestLogContent" RENAME CONSTRAINT "RequestLogContent_plain_pkey" TO "RequestLogContent_pkey";
ALTER TABLE "RequestLogContent" RENAME CONSTRAINT "RequestLogContent_plain_logId_fkey" TO "RequestLogContent_logId_fkey";
ALTER INDEX "RequestLogContent_plain_createdAt_idx" RENAME TO "RequestLogContent_createdAt_idx";
ALTER TABLE "PolicyOverride" DROP CONSTRAINT IF EXISTS "PolicyOverride_one_target";

COMMIT;
