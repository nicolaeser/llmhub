import type { REPORT_CADENCES, REPORT_FORMATS } from "@/lib/reports/period";

export type ReportCadence = (typeof REPORT_CADENCES)[number];

export type ReportFormat = (typeof REPORT_FORMATS)[number];

export type ReportPeriod = {
  cadence: ReportCadence;
  key: string;
  start: Date;
  end: Date;
  days: number;
};

export type UsageReportView = {
  id: string;
  orgId: string;
  teamId: string;
  cadence: ReportCadence;
  format: ReportFormat;
  locale: string;
  recipients: string[];
  enabled: boolean;
  lastSentAt: string | null;
  lastError: string;
  nextRunAt: string;
};

export type UsageReportInput = {
  id?: string;
  orgId: string;
  teamId: string;
  cadence: ReportCadence;
  format: ReportFormat;
  locale: string;
  recipients: string[];
  enabled: boolean;
};

export type UsageReportTarget = {
  id: string;
  orgId: string;
  teamId: string | null;
  format: string;
  locale: string;
  recipients: string[];
  org: { alias: string };
  team: { alias: string } | null;
};

export type UsageReportRow = {
  id: string;
  orgId: string;
  teamId: string | null;
  cadence: string;
  format: string;
  locale: string;
  recipients: string[];
  enabled: boolean;
  lastSentAt: Date | null;
  lastError: string;
};
