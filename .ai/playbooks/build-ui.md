---
type: playbook
description: Ordered procedure for console, account, or setup UI changes.
---

# Build UI

## Use when

Creating or materially changing a visible screen, form, chrome, or theme-dependent layout.

## Required context

[STYLE.md](../STYLE.md), [frontend.md](../instructions/frontend.md), [content-localization.md](../instructions/content-localization.md) when copy changes.

## Prerequisites

Inspect the existing page, colocated `_action.ts`, and chrome (`(app)/_components` or `account/_components`) before adding files.

## Procedure

1. Confirm the route group (console, account, setup). A new console page also needs a `NAV` entry with its permission in `src/app/(app)/_components/nav-data.ts` and a `Sidebar.items` label in both locales.
2. Read installed HeroUI v3 types (`node_modules/@heroui/react/dist/components/`) for any component you add.
3. Compose HeroUI components first (`Card`, `Separator`, `Chip`, `Alert`, `Table`, fields with `Description`), with `onPress` and their own props. Keep `className` to layout and token text colors. No `dark:`, no overflow clip, no new CSS.
4. Put route-only UI in `_components/` (kebab-case). Keep orchestration on `page.tsx`.
5. Keep mutations in `_action.ts`. Client state holds the result.
6. Add or update `lang/en` and `lang/de` keys together.

## Change-impact analysis

List every route that shares the component, action, or message namespace.

## Validation

- `npm run styles:check`
- `npm run heroui:check`
- `npm run i18n:check` if copy changed
- Inspect mobile and desktop; both themes if chrome/color changed; both locales if text reflows

## Rollback

Revert the UI files and locale JSON together so parity remains.

## Definition of done

Checks pass, no prohibited utilities, no stylesheet besides `src/styles/globals.css`, both locales aligned, and pending/empty/error states are visible.
