"use client";

import { useState, useTransition } from "react";
import { Button, Card, Chip, Spinner, toast } from "@heroui/react";
import { LogOut, Monitor } from "lucide-react";
import { useFormatter, useNow, useTranslations } from "next-intl";
import { isActionFail } from "@/lib/http/action-result";
import { describeUserAgent } from "@/lib/utils/user-agent";
import { useSecurityError } from "@/components/security/use-security-error";
import type { SecurityOverview, SessionView } from "@/types/security";
import { revokeOtherSessionsAction, revokeSessionAction } from "../_action";

export default function SessionsCard({
  sessions,
  onChange,
}: {
  sessions: SessionView[];
  onChange: (overview: SecurityOverview) => void;
}) {
  const t = useTranslations("Account.sessions");
  const format = useFormatter();
  const now = useNow({ updateInterval: 30_000 });
  const errorText = useSecurityError();
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [revokingOthers, startOthers] = useTransition();
  const [, startRevoke] = useTransition();
  const others = sessions.filter((session) => !session.current).length;

  return (
    <Card className="gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <Card.Header className="min-w-0">
          <Card.Title>{t("title")}</Card.Title>
          <Card.Description>{t("description")}</Card.Description>
        </Card.Header>
        <Button
          size="sm"
          variant="secondary"
          isPending={revokingOthers}
          isDisabled={others === 0 || revokingId !== null}
          onPress={() =>
            startOthers(async () => {
              const result = await revokeOtherSessionsAction();
              if (isActionFail(result)) {
                toast.danger(errorText(result.error));
                return;
              }
              onChange(result);
              toast(t("othersRevoked", { count: others }), { variant: "success" });
            })
          }
        >
          {({ isPending }) => (
            <>
              {isPending ? <Spinner color="current" size="sm" /> : <LogOut size={14} aria-hidden />}
              {t("revokeOthers")}
            </>
          )}
        </Button>
      </div>
      <ul className="divide-y divide-border">
        {sessions.map((session) => {
          const device = describeUserAgent(session.userAgent);
          return (
            <li key={session.id} className="flex flex-wrap items-center gap-3 py-3">
              <Monitor size={16} aria-hidden className="text-muted" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium break-words">
                  {t("device", {
                    browser: device.browser ?? "unknown",
                    system: device.system ?? "unknown",
                  })}
                </p>
                <p className="text-xs text-muted break-words">
                  {t("meta", {
                    ip: session.ipAddress ?? "unknown",
                    when: format.relativeTime(new Date(session.lastActive), now),
                  })}
                </p>
              </div>
              {session.current ? (
                <Chip size="sm" variant="soft" color="success">
                  {t("current")}
                </Chip>
              ) : null}
              <Chip size="sm" variant="soft">
                {t("factor", { factor: session.secondFactor ?? "other" })}
              </Chip>
              {session.current ? null : (
                <Button
                  size="sm"
                  variant="ghost"
                  isPending={revokingId === session.id}
                  isDisabled={revokingOthers || (revokingId !== null && revokingId !== session.id)}
                  onPress={() => {
                    setRevokingId(session.id);
                    startRevoke(async () => {
                      const result = await revokeSessionAction({ id: session.id });
                      setRevokingId(null);
                      if (isActionFail(result)) {
                        toast.danger(errorText(result.error));
                        return;
                      }
                      onChange(result);
                      toast(t("revoked"), { variant: "success" });
                    });
                  }}
                >
                  {({ isPending }) => (
                    <>
                      {isPending ? <Spinner color="current" size="sm" /> : null}
                      {t("revoke")}
                    </>
                  )}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
