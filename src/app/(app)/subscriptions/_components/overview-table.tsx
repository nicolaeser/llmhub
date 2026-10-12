"use client";

import { Chip, Table } from "@heroui/react";
import { useTranslations } from "next-intl";
import ProviderToggle from "@/components/providers/provider-toggle";
import type { AccountLimits, LimitWindow, ProviderView } from "@/types/providers";
import { accountState, type AccountState } from "./account-status";
import LimitMeter from "./limit-meter";

const SHORT_MAX_SECONDS = 6 * 3_600;
const WEEKLY_MAX_SECONDS = 8 * 86_400;

const STATE_COLOR = {
  paused: "default",
  available: "success",
  limited: "danger",
  expired: "warning",
  unavailable: "warning",
  checking: "default",
  connected: "default",
} as const satisfies Record<AccountState, "success" | "danger" | "warning" | "default">;

function planWindow(entry: AccountLimits | undefined, matches: (seconds: number) => boolean): LimitWindow | null {
  return entry?.limits?.windows.find((window) => !window.scope && window.windowSeconds > 0 && matches(window.windowSeconds)) ?? null;
}

export default function OverviewTable({
  rows,
  limits,
  reports,
  onToggled,
}: {
  rows: ProviderView[];
  limits: Record<string, AccountLimits>;
  reports: (kind: string) => boolean;
  onToggled: (provider: ProviderView) => void;
}) {
  const t = useTranslations("Subscriptions");
  const tProviders = useTranslations("Providers");

  const cell = (window: LimitWindow | null) =>
    window ? <LimitMeter window={window} compact /> : <span className="text-muted">{t("overview.none")}</span>;

  return (
    <Table aria-label={t("overview.title")}>
      <Table.ScrollContainer>
        <Table.Content className="min-w-4xl">
          <Table.Header>
            <Table.Column isRowHeader>{t("overview.columns.account")}</Table.Column>
            <Table.Column>{t("overview.columns.provider")}</Table.Column>
            <Table.Column>{t("overview.columns.short")}</Table.Column>
            <Table.Column>{t("overview.columns.weekly")}</Table.Column>
            <Table.Column>{t("overview.columns.longer")}</Table.Column>
            <Table.Column>{t("overview.columns.state")}</Table.Column>
            <Table.Column>{t("overview.columns.active")}</Table.Column>
          </Table.Header>
          <Table.Body>
            {rows.map((row) => {
              const entry = limits[row.id];
              const state = accountState(row, entry, reports(row.kind));
              const plan = entry?.limits?.plan || row.signIn?.plan || "";
              return (
                <Table.Row key={row.id} id={row.id}>
                  <Table.Cell>
                    <div className="min-w-0">
                      <div className="truncate font-medium">{row.name}</div>
                      <div className="truncate text-xs text-muted">{row.signIn?.account ?? ""}</div>
                    </div>
                  </Table.Cell>
                  <Table.Cell>
                    <div className="flex flex-wrap items-center gap-1">
                      <span className="whitespace-nowrap">{tProviders("kindName", { kind: row.kind })}</span>
                      {plan ? (
                        <Chip size="sm" variant="soft" color="accent">
                          {tProviders("signIn.plan", { plan })}
                        </Chip>
                      ) : null}
                    </div>
                  </Table.Cell>
                  <Table.Cell>{cell(planWindow(entry, (s) => s <= SHORT_MAX_SECONDS))}</Table.Cell>
                  <Table.Cell>
                    {cell(planWindow(entry, (s) => s > SHORT_MAX_SECONDS && s <= WEEKLY_MAX_SECONDS))}
                  </Table.Cell>
                  <Table.Cell>{cell(planWindow(entry, (s) => s > WEEKLY_MAX_SECONDS))}</Table.Cell>
                  <Table.Cell>
                    <Chip size="sm" variant="soft" color={STATE_COLOR[state]} className="whitespace-nowrap">
                      {t("status", { status: state })}
                    </Chip>
                  </Table.Cell>
                  <Table.Cell>
                    <ProviderToggle row={row} onChanged={onToggled} showLabel={false} />
                  </Table.Cell>
                </Table.Row>
              );
            })}
          </Table.Body>
        </Table.Content>
      </Table.ScrollContainer>
    </Table>
  );
}
