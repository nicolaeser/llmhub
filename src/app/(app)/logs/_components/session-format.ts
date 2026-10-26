import { useFormatter, useTranslations } from "next-intl";

function clock(ms: number) {
  const total = Math.max(0, Math.round(ms / 1000));
  return { hours: Math.floor(total / 3600), minutes: Math.floor((total % 3600) / 60), seconds: total % 60 };
}

export function useSessionFormat() {
  const t = useTranslations("Logs.sessions");
  const format = useFormatter();
  const pad = (value: number) => format.number(value, { minimumIntegerDigits: 2, useGrouping: false });
  return {
    title: (agent: string) => t("title", { agent: agent || "none" }),
    duration(ms: number) {
      const { hours, minutes, seconds } = clock(ms);
      return t("duration", { unit: hours ? "hours" : minutes ? "minutes" : "seconds", hours, minutes, seconds });
    },
    offset(ms: number) {
      const { hours, minutes, seconds } = clock(ms);
      return t("offset", { unit: hours ? "hours" : "minutes", hours, minutes, mm: pad(minutes), ss: pad(seconds) });
    },
  };
}
