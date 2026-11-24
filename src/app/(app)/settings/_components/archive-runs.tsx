"use client";

import { useState } from "react";
import { Chip, Table } from "@heroui/react";
import { useFormatter, useTranslations } from "next-intl";
import RowCard, { RowCards, TABLE_FROM_LG } from "@/components/console/row-cards";
import { columnSort, descriptorOf, sortByColumn, type ColumnSort } from "@/components/console/table-sort";
import { formats } from "@/i18n/formats";
import { formatBytes } from "@/lib/utils/bytes";
import type { ArchiveRunStatus, ArchiveRunView } from "@/types/archive";

const STATUS_COLOR: Record<ArchiveRunStatus, "success" | "warning" | "danger" | "accent" | "default"> = {
  pending: "default",
  running: "accent",
  done: "success",
  failed: "danger",
  expired: "default",
};

function dayDate(day: string): Date {
  return new Date(`${day}T00:00:00Z`);
}

function runSortValue(run: ArchiveRunView, column: string) {
  if (column === "day") {
    const ms = run.day ? dayDate(run.day).getTime() : Number.NaN;
    return Number.isNaN(ms) ? null : ms;
  }
  if (column === "dataset") return run.dataset;
  if (column === "status") return run.status;
  if (column === "records") return run.rows;
  if (column === "size") return run.bytes;
  if (column === "object") return run.objectKey || null;
  return null;
}

export default function ArchiveRuns({ runs }: { runs: ArchiveRunView[] }) {
  const t = useTranslations("Settings.archive.runs");
  const tArchive = useTranslations("Settings.archive");
  const format = useFormatter();
  const [sort, setSort] = useState<ColumnSort | null>(null);
  const shown = sortByColumn(runs, sort, runSortValue);

  if (!runs.length) return <p className="text-sm text-muted">{t("empty")}</p>;

  const statusChip = (run: ArchiveRunView) => (
    <Chip size="sm" variant="soft" color={STATUS_COLOR[run.status]}>
      {t("status", { status: run.status })}
    </Chip>
  );
  const day = (run: ArchiveRunView) => format.dateTime(dayDate(run.day), formats.dateTime.utcDate);
  const records = (run: ArchiveRunView) => format.number(run.rows, formats.number.integer);
  const size = (run: ArchiveRunView) => (run.bytes ? formatBytes(format, run.bytes) : t("none"));
  const outcome = (run: ArchiveRunView) => {
    if (run.status === "failed") {
      return (
        <span className="text-sm text-danger">
          {t("error", { code: run.error || "FAILED" })}{" "}
          {run.nextAttemptAt ? t("retry", { at: new Date(run.nextAttemptAt), attempts: run.attempts }) : null}
        </span>
      );
    }
    if (run.objectKey) return <code className="font-mono text-xs break-words">{run.objectKey.split("/").pop()}</code>;
    return <span className="text-sm text-muted">{t("noObject", { status: run.status })}</span>;
  };

  return (
    <>
      <RowCards label={t("title")}>
        {shown.map((run) => (
          <RowCard
            key={run.id}
            variant="secondary"
            title={day(run)}
            description={tArchive("dataset", { dataset: run.dataset })}
            aside={statusChip(run)}
            details={[
              { label: t("columns.records"), value: records(run) },
              { label: t("columns.size"), value: size(run) },
              { label: t("columns.object"), value: outcome(run), wide: true },
            ]}
          />
        ))}
      </RowCards>
      <Table className={TABLE_FROM_LG}>
        <Table.ScrollContainer>
          <Table.Content
            aria-label={t("title")}
            sortDescriptor={sort ? descriptorOf(sort) : undefined}
            onSortChange={(descriptor) => setSort(columnSort(descriptor, sort))}
          >
            <Table.Header>
              <Table.Column isRowHeader allowsSorting id="day">
                {({ sortDirection }) => (
                  <Table.SortableColumnHeader sortDirection={sortDirection}>{t("columns.day")}</Table.SortableColumnHeader>
                )}
              </Table.Column>
              <Table.Column allowsSorting id="dataset">
                {({ sortDirection }) => (
                  <Table.SortableColumnHeader sortDirection={sortDirection}>
                    {t("columns.dataset")}
                  </Table.SortableColumnHeader>
                )}
              </Table.Column>
              <Table.Column allowsSorting id="status">
                {({ sortDirection }) => (
                  <Table.SortableColumnHeader sortDirection={sortDirection}>
                    {t("columns.status")}
                  </Table.SortableColumnHeader>
                )}
              </Table.Column>
              <Table.Column allowsSorting id="records">
                {({ sortDirection }) => (
                  <Table.SortableColumnHeader sortDirection={sortDirection}>
                    {t("columns.records")}
                  </Table.SortableColumnHeader>
                )}
              </Table.Column>
              <Table.Column allowsSorting id="size">
                {({ sortDirection }) => (
                  <Table.SortableColumnHeader sortDirection={sortDirection}>{t("columns.size")}</Table.SortableColumnHeader>
                )}
              </Table.Column>
              <Table.Column allowsSorting id="object">
                {({ sortDirection }) => (
                  <Table.SortableColumnHeader sortDirection={sortDirection}>
                    {t("columns.object")}
                  </Table.SortableColumnHeader>
                )}
              </Table.Column>
            </Table.Header>
            <Table.Body>
              {shown.map((run) => (
                <Table.Row key={run.id} id={run.id}>
                  <Table.Cell>
                    <span className="whitespace-nowrap">{day(run)}</span>
                  </Table.Cell>
                  <Table.Cell>{tArchive("dataset", { dataset: run.dataset })}</Table.Cell>
                  <Table.Cell>{statusChip(run)}</Table.Cell>
                  <Table.Cell>
                    <span className="tabular-nums">{records(run)}</span>
                  </Table.Cell>
                  <Table.Cell>
                    <span className="whitespace-nowrap tabular-nums">{size(run)}</span>
                  </Table.Cell>
                  <Table.Cell>{outcome(run)}</Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Content>
        </Table.ScrollContainer>
      </Table>
    </>
  );
}
