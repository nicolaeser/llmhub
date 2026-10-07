import type { Formats } from "next-intl";

export const formats = {
  dateTime: {
    short: { day: "numeric", month: "short", year: "numeric" },
    chart: { day: "numeric", month: "short" },
    long: { day: "numeric", month: "long", year: "numeric" },
    full: { dateStyle: "full", timeStyle: "short" },
    time: { timeStyle: "medium" },
    dateTime: { dateStyle: "medium", timeStyle: "medium" },
    stamp: { dateStyle: "medium", timeStyle: "short" },
    zoned: {
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      timeZoneName: "short",
    },
  },
  number: {
    integer: { maximumFractionDigits: 0 },
    percent: { style: "percent", maximumFractionDigits: 1 },
    percentPoints: { style: "unit", unit: "percent", maximumFractionDigits: 0 },
    axis: { notation: "compact", maximumSignificantDigits: 3 },
    currency: {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    },
    currencyWhole: {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    },
    money: {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 4,
      maximumFractionDigits: 4,
    },
    price: {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 8,
    },
  },
  list: {
    enumeration: { type: "conjunction", style: "long" },
    alternatives: { type: "disjunction", style: "long" },
  },
} satisfies Formats;
