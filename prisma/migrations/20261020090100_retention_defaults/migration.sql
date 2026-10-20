DO $$
BEGIN
  UPDATE "Setting"
  SET "value" = ("value"::jsonb - 'log_retention_days' - 'content_retention_days')::text
  WHERE "key" = 'enterprise'
    AND jsonb_typeof("value"::jsonb) = 'object'
    AND NOT EXISTS (SELECT 1 FROM "GatewayAuditLog" WHERE "action" = 'settings.logging')
    AND COALESCE("value"::jsonb -> 'log_retention_days', '0') = '0'
    AND COALESCE("value"::jsonb -> 'content_retention_days', '0') = '0'
    AND COALESCE("value"::jsonb -> 'spend_retention_days', '0') = '0'
    AND COALESCE("value"::jsonb -> 'audit_retention_days', '0') = '0'
    AND COALESCE("value"::jsonb -> 'file_retention_days', '0') = '0'
    AND COALESCE("value"::jsonb -> 'object_retention_days', '30') = '30';
EXCEPTION
  WHEN invalid_text_representation THEN
    NULL;
END
$$;
