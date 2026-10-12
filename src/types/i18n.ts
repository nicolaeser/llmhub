import type { createFormatter, TranslationValues } from "next-intl";

export type Messages = Record<string, unknown>;

export type Translate = (key: string, values?: TranslationValues) => string;

export type Formatter = ReturnType<typeof createFormatter>;
