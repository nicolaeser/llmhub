---
type: instruction
description: Load for copy, locale files, ICU messages, or next-intl formatter work.
scope: repository
---

# Content and localization

Load when changing `lang/`, `src/i18n/`, or user-visible strings. Load [next-intl-icu.md](../knowledge/next-intl-icu.md) with this Instruction. Canonical API: https://next-intl.dev/docs/usage/translations

## Mandatory rules

- Supported locales are `en` and `de`. Add or rename a key in both `lang/en/` and `lang/de/` in the same change.
- Namespace JSON files map to dotted message paths through `src/i18n/messages.ts`.
- Must keep language state in ICU messages (`plural`, `selectordinal`, `select`, interpolation) instead of `if`/`switch` that only pick words.
- Must format numbers, dates, relative times, lists, and display names with `useFormatter`/`getFormatter` or ICU `{value, number}` / `{orderDate, date, medium}`.
- Must not call `toLocaleString`, `toLocaleDateString`, `toLocaleTimeString`, or construct `Intl.NumberFormat` / `Intl.DateTimeFormat` / `Intl.ListFormat` / `Intl.RelativeTimeFormat` / `Intl.DisplayNames` in UI or request-scoped server rendering.
- Must map finite message lists to explicit keys in the component. Do not use `t.raw()` arrays for copy that needs ICU.
- Must use `t.rich` for inline React markup, `t.markup` only for string HTML, and `t.raw` only for unparsed JSON.
- Must keep ICU argument names, plural/select branches, and rich tags identical across locales.
- Must keep `if` only for control flow (empty vs populated UI, auth, business rules), not for choosing a label.
- Named formats live in `src/i18n/formats.ts` and must be returned from `getRequestConfig`.

## Validation

`npm run i18n:check`. Compare English and German key trees and exercise changed surfaces in both locales.
