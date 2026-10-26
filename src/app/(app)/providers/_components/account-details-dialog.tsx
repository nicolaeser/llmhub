"use client";

import { Button, Chip, Modal, Separator, Skeleton, Spinner, type useOverlayState } from "@heroui/react";
import {
  CircleCheck,
  CirclePause,
  CloudOff,
  Gauge,
  KeyRound,
  Link2,
  LoaderCircle,
  LogIn,
  RefreshCw,
  Users,
  type LucideIcon,
} from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import IconTile from "@/components/console/icon-tile";
import { PlanBadge } from "@/components/console/subscription-badge";
import { limitsUpdatedAt, updatedFromTraffic } from "@/lib/gateway/upstreams/observed-limits";
import type { AccountState, LimitSnapshot, ProviderView } from "@/types/providers";
import type { Tone } from "@/types/console";
import { accountRow } from "./account-rows";
import { ACCOUNT_STATE_COLOR } from "./account-status";
import BankedResets from "./banked-resets";
import LimitMeter from "./limit-meter";
import PolicyChips from "./policy-chips";
import { useResetTime } from "./use-reset-time";

const STATE_ICON: Record<AccountState, LucideIcon> = {
  available: CircleCheck,
  connected: CircleCheck,
  limited: Gauge,
  expired: KeyRound,
  unavailable: CloudOff,
  checking: LoaderCircle,
  paused: CirclePause,
};

const STATE_TONE: Record<AccountState, Tone> = {
  available: "success",
  connected: "success",
  limited: "warning",
  expired: "danger",
  unavailable: "warning",
  checking: "neutral",
  paused: "neutral",
};

export default function AccountDetailsDialog({
  state,
  row,
  entry,
  reports,
  timeZone,
  canManage,
  refreshing,
  onRefresh,
  onItem,
  onSignIn,
}: {
  state: ReturnType<typeof useOverlayState>;
  row: ProviderView | null;
  entry: LimitSnapshot | undefined;
  reports: boolean;
  timeZone: string;
  canManage: boolean;
  refreshing: boolean;
  onRefresh: (id: string) => void;
  onItem: (item: LimitSnapshot | null) => void;
  onSignIn: (row: ProviderView) => void;
}) {
  const t = useTranslations("Subscriptions");
  const tProviders = useTranslations("Providers");
  const tError = useTranslations("Error");
  const tCommon = useTranslations("Common");
  const format = useFormatter();
  const reset = useResetTime(timeZone);
  const { now } = reset;

  return (
    <Modal state={state}>
      <Modal.Backdrop>
        <Modal.Container scroll="inside">
          <Modal.Dialog className="max-w-2xl">
            {({ close }) => {
              if (!row) return null;
              const account = accountRow(row, entry, reports, now.getTime());
              const { limits } = account;
              return (
                <>
                  <Modal.Header className="flex-row items-start gap-3">
                    <IconTile icon={STATE_ICON[account.state]} tone={STATE_TONE[account.state]} />
                    <div className="min-w-0 flex-1 space-y-2">
                      <div>
                        <Modal.Heading className="break-words">{t("details.title", { name: account.title })}</Modal.Heading>
                        <p className="text-sm break-words text-muted">{account.subtitle ?? t("noAccount")}</p>
                      </div>
                      <div className="flex flex-wrap gap-1">
                        <PlanBadge plan={account.plan} />
                        <Chip size="sm" variant="soft" color={ACCOUNT_STATE_COLOR[account.state]} className="whitespace-nowrap">
                          {t("status", { status: account.state })}
                        </Chip>
                        {account.partial ? (
                          <Chip size="sm" variant="soft" color="warning" className="whitespace-nowrap">
                            {t("limits.partial", { reached: account.partial.reached, total: account.partial.total })}
                          </Chip>
                        ) : null}
                        {account.sharedVia !== null ? (
                          <Chip size="sm" variant="soft" color="accent" className="whitespace-nowrap">
                            <Link2 size={12} aria-hidden />
                            {t("sharedVia", { named: String(account.sharedVia !== ""), label: account.sharedVia })}
                          </Chip>
                        ) : null}
                        {account.manageOff ? (
                          <Chip size="sm" variant="soft" className="whitespace-nowrap">
                            {t("manageOff")}
                          </Chip>
                        ) : null}
                      </div>
                    </div>
                  </Modal.Header>
                  <Modal.Body className="space-y-5">
                    {account.state === "limited" ? (
                      <p className="text-sm text-warning">
                        {account.recovery
                          ? t("backIn", {
                              when: reset.countdown(account.recovery),
                              date: reset.date(account.recovery, true),
                            })
                          : t("backInUnknown")}
                      </p>
                    ) : null}
                    {account.needsSignIn ? <p className="text-sm text-danger">{t("expiredHint")}</p> : null}
                    {account.state === "paused" ? <p className="text-sm text-muted">{t("pausedHint")}</p> : null}
                    {account.failure ? (
                      <div className="space-y-1">
                        <p className="text-sm text-warning">{tError("code", { code: account.failure })}</p>
                        {account.nextCheck ? (
                          <p className="text-xs text-muted">
                            {t("limits.nextCheck", { when: format.relativeTime(new Date(account.nextCheck), now) })}
                          </p>
                        ) : null}
                      </div>
                    ) : null}

                    <section className="space-y-3" aria-label={t("details.limits")}>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <h3 className="text-sm font-semibold">{t("details.limits")}</h3>
                        <div className="flex min-w-0 items-center gap-1">
                          {account.refreshable && limits ? (
                            <span className="text-xs text-muted">
                              {t("limits.updated", {
                                source: updatedFromTraffic(limits) ? "traffic" : "poll",
                                when: format.relativeTime(
                                  new Date(Math.min(limitsUpdatedAt(limits), now.getTime())),
                                  now,
                                ),
                              })}
                            </span>
                          ) : null}
                          {account.refreshable ? (
                            <Button
                              isIconOnly
                              size="sm"
                              variant="ghost"
                              aria-label={t("limits.refresh")}
                              isPending={refreshing}
                              isDisabled={account.held}
                              onPress={() => onRefresh(row.id)}
                            >
                              {({ isPending }) =>
                                isPending ? <Spinner color="current" size="sm" /> : <RefreshCw size={14} aria-hidden />
                              }
                            </Button>
                          ) : null}
                        </div>
                      </div>
                      {!reports ? <p className="text-sm text-muted">{t("noLimits")}</p> : null}
                      {reports && account.state === "checking" ? (
                        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2" aria-hidden>
                          {[0, 1].map((item) => (
                            <div key={item} className="space-y-2">
                              <Skeleton className="h-3 w-1/2 rounded-lg" />
                              <Skeleton className="h-2 w-full rounded-lg" />
                              <Skeleton className="h-3 w-2/3 rounded-lg" />
                            </div>
                          ))}
                        </div>
                      ) : null}
                      {limits && account.groups.length === 0 ? (
                        <p className="text-sm text-muted">{t("limits.none")}</p>
                      ) : null}
                      {account.groups.length > 0 ? (
                        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                          {account.groups.map((group) => (
                            <LimitMeter key={group.id} group={group} timeZone={timeZone} />
                          ))}
                        </div>
                      ) : null}
                      {limits?.extraUsage || limits?.credits ? (
                        <ul className="space-y-1 text-sm text-muted">
                          {limits.extraUsage ? (
                            <li>
                              {t("limits.extraUsage", {
                                used: format.number(limits.extraUsage.usedCents / 100, {
                                  style: "currency",
                                  currency: "USD",
                                }),
                                limit: format.number(limits.extraUsage.limitCents / 100, {
                                  style: "currency",
                                  currency: "USD",
                                }),
                              })}
                            </li>
                          ) : null}
                          {limits.credits ? (
                            <li>
                              {t("limits.credits", {
                                unlimited: limits.credits.unlimited ? "true" : "false",
                                balance: limits.credits.balance,
                              })}
                            </li>
                          ) : null}
                        </ul>
                      ) : null}
                    </section>

                    {limits?.resetCredits ? (
                      <>
                        <Separator />
                        <BankedResets
                          row={row}
                          credits={limits.resetCredits}
                          timeZone={timeZone}
                          canManage={canManage}
                          onItem={onItem}
                        />
                      </>
                    ) : null}

                    <Separator />
                    <dl className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
                      <div className="min-w-0 space-y-1">
                        <dt className="text-xs text-muted">{tProviders("dataHandling.title")}</dt>
                        <dd>
                          <PolicyChips
                            policy={row.policy}
                            fallback={<span className="text-sm text-foreground">{tCommon("none")}</span>}
                          />
                        </dd>
                      </div>
                      <div className="min-w-0 space-y-1">
                        <dt className="text-xs text-muted">{t("columns.access")}</dt>
                        <dd className="flex min-w-0 items-center gap-1.5 text-sm text-foreground">
                          <Users
                            size={14}
                            aria-hidden
                            className={account.restricted ? "shrink-0 text-warning" : "shrink-0 text-muted"}
                          />
                          {t("access.summary", { restricted: String(account.restricted), count: account.assignments })}
                        </dd>
                      </div>
                    </dl>
                  </Modal.Body>
                  <Modal.Footer>
                    <Button variant="secondary" onPress={close}>
                      {tCommon("done")}
                    </Button>
                    {canManage && account.needsSignIn ? (
                      <Button
                        onPress={() => {
                          close();
                          onSignIn(row);
                        }}
                      >
                        <LogIn size={16} aria-hidden />
                        {t("menu.signIn")}
                      </Button>
                    ) : null}
                  </Modal.Footer>
                </>
              );
            }}
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
