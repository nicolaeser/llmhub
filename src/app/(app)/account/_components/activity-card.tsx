"use client";

import { Card } from "@heroui/react";
import { useFormatter, useNow, useTranslations } from "next-intl";
import type { SecurityEventAction, SecurityEventView } from "@/types/security";

const EVENT_KEYS = {
  "2fa.enrolled": "twoFactorEnrolled",
  "2fa.replaced": "twoFactorReplaced",
  "2fa.recovery_regenerated": "recoveryRegenerated",
  "2fa.recovery_used": "recoveryUsed",
  "2fa.locked": "twoFactorLocked",
  "2fa.reset": "twoFactorReset",
  "password.changed": "passwordChanged",
  "password.reset": "passwordReset",
  "password.change_required": "passwordChangeRequired",
  "sessions.revoked": "sessionsRevoked",
  "passkey.added": "passkeyAdded",
  "passkey.removed": "passkeyRemoved",
  "role.changed": "roleChanged",
  "account.blocked": "accountBlocked",
  "account.unblocked": "accountUnblocked",
  "management_key.created": "managementKeyCreated",
  "management_key.revoked": "managementKeyRevoked",
} as const satisfies Record<SecurityEventAction, string>;

export default function ActivityCard({ events }: { events: SecurityEventView[] }) {
  const t = useTranslations("Account.activity");
  const format = useFormatter();
  const now = useNow({ updateInterval: 30_000 });

  return (
    <Card className="gap-4">
      <Card.Header>
        <Card.Title>{t("title")}</Card.Title>
        <Card.Description>{t("description")}</Card.Description>
      </Card.Header>
      {events.length ? (
        <ol className="space-y-3">
          {events.map((event) => (
            <li key={event.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <div className="min-w-0">
                <p className="text-sm">{t(`events.${EVENT_KEYS[event.action]}`)}</p>
                <p className="text-xs text-muted">
                  {t("actor", { actor: event.actor, name: event.actorName ?? "" })}
                </p>
              </div>
              <time dateTime={event.createdAt} className="text-xs text-muted">
                {format.relativeTime(new Date(event.createdAt), now)}
              </time>
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-sm text-muted">{t("empty")}</p>
      )}
    </Card>
  );
}
