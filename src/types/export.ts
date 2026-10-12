import type { canvas } from "@/lib/export/pdf";
import type { SliceRow, UsageSummary } from "@/types/usage";

export type PdfColor = readonly [number, number, number];

export type PdfFont = "regular" | "bold" | "italic" | "boldItalic" | "mono";

export type PdfTextStyle = {
  size: number;
  font?: PdfFont;
  color?: PdfColor;
  align?: "left" | "right" | "center";
  maxWidth?: number;
  shrink?: boolean;
  tracking?: number;
};

export type PdfCanvas = ReturnType<typeof canvas>;

export type UsagePdfStats = UsageSummary & {
  p95Latency: number;
  byModel: SliceRow[];
  chargeback: SliceRow[];
};

export type UsagePdfInput = {
  brand: string;
  title: string;
  period: string;
  filter?: string;
  generated: string;
  kpis: { label: string; value: string }[];
  daily: {
    heading: string;
    days: { label: string; value: number }[];
    formatTick: (value: number) => string;
    empty: string;
  };
  byModel: {
    heading: string;
    columns: { model: string; share: string; spend: string; prompt: string; completion: string };
    rows: {
      name: string;
      share: number;
      shareLabel: string;
      spend: string;
      prompt: string;
      completion: string;
    }[];
    total: { name: string; spend: string; prompt: string; completion: string };
    empty: string;
  };
};
