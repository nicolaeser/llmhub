# LLM Hub visual contract

Load this file for any UI, theme, layout, motion, or accessibility work. It is the sole active design contract.

The UI is HeroUI v3 (`@heroui/react` / `@heroui/styles`) plus Tailwind CSS 4 layout utilities. There is one stylesheet, `src/styles/globals.css`: it imports `tailwindcss` and `@heroui/styles`, declares the `dark` custom variant, and overrides official HeroUI tokens (`--accent`, `--background`, `--surface`, `--border`, `--muted`, `--default`, `--field-*`, …) for `.light` and `.dark`. Nothing else. Must not add another stylesheet, custom classes, `@keyframes`, `@theme`, comments, or non-HeroUI custom properties to it. The root layout is the only module that imports it. Theme class on `<html>` (`.dark` / `.light`, next-themes). This is an authenticated LLM gateway console, not a marketing site.

Load HeroUI docs in this order:

1. Installed types and styles: `node_modules/@heroui/react/dist/components/{kebab}/*.d.ts` and `node_modules/@heroui/styles/dist/components/*.css`.
2. `https://heroui.com/react/llms-full.txt`.

Must not use remembered HeroUI v2, `HeroUIProvider`, `classNames` objects, `isLoading`, or `dark:` utilities.

## Principles

- HeroUI components carry the visual language. Reach for a component before writing a class string: panels are `Card` (`variant="secondary"` when nested), rules are `Separator`, pills are `Chip`, notices are `Alert`, loading is `Spinner` / `Skeleton`, tabular data is `Table`, field hints are `Description` inside the field.
- `className` is for layout (flex, grid, gap, spacing, width, alignment, responsive visibility) and semantic token text colors. Must not restyle HeroUI controls with color, border, radius, padding, or size classes; use their props (`variant`, `size`, `fullWidth`, `color`).
- Must not hand-roll bordered panels (`rounded-* border border-border bg-surface`). Must not keep class-string constants for fields or brand paint.
- Must write every utility so it works in both themes. Must not use `dark:` modifiers; HeroUI tokens flip in `src/styles/globals.css`.
- Must use HeroUI v3 compound controls for interactive UI. Must not use native `<button>`, `<select>`, `<textarea>`, or `<input>` (a file `<input>` is the only exception).
- Must not put comments in UI modules.
- Content must reflow. Must not use `overflow-hidden`, `overflow-x-hidden`, `overflow-y-hidden`, or `overflow-clip`. Scroll only with `overflow-y-auto` / `overflow-x-auto` on a dedicated pane.
- Must not put React `style={}` on application HTML. Next image routes (`icon`, `apple-icon`, `opengraph-image`) are the exception because `ImageResponse` requires it.

## Tokens

| Role | Must use |
| --- | --- |
| Page | `bg-background` |
| Panel | `Card` (fill comes from `--surface`) |
| Nested panel | `Card variant="secondary"` |
| Subtle fill / hover | `bg-default` or `bg-foreground/5` |
| Border on layout chrome | `border-border` |
| Primary text | `text-foreground` |
| Secondary text | `text-muted` |
| Status | `text-success` / `text-warning` / `text-danger` / `text-accent` |
| Charts | `var(--accent)`, `var(--danger)`, `var(--warning)`, `var(--success)`, `var(--muted)`, `var(--border)` |

There is no `default-N` scale. Must not use raw Tailwind palette colors (`text-zinc-500`, `bg-indigo-600`, …), `text-white`, `text-black`, or gradients. The brand mark (`src/components/brand/brand-mark.tsx`, hub-and-nodes glyph) uses `bg-accent text-accent-foreground`; `src/app/icon.svg`, `src/app/apple-icon.tsx`, `src/app/favicon.ico`, and the usage PDF header in `src/lib/http/usage-pdf.ts` carry the same glyph and must change with it. They cannot read CSS variables: `src/app/icon.svg` and `src/app/apple-icon.tsx` hardcode the light `--accent` (`oklch(0.585 0.2 277)`) as `#6367ef`, and `COLORS` in `src/lib/http/usage-pdf.ts` holds sRGB copies of the light tokens (`accent` is `[99, 103, 239]`). Update them in the same change as `src/styles/globals.css`. Primary actions use the default `Button` variant.

## Typography and document outline

- Use Geist via `--font-geist-sans` / `--font-geist-mono` from `src/app/layout.tsx`.
- Use the Tailwind type scale `text-xs` through `text-xl` in the console. Must not write `text-[Npx]` or `text-[Nrem]`.
- Exactly one `h1` per route. Console page titles are `text-xl font-semibold tracking-tight`; account screens use `text-3xl sm:text-4xl`. Panel headings are `Card.Title`.
- Account routes emit `main` from `account-shell`. Console routes use the `(app)` layout `main`. Must not nest `<main>` in `<main>`.
- Do not use marketing em-dashes in product UI copy.

## Spacing and sizing

HeroUI `size` maps control height. Must not mix `size` with a competing height class. Default control size is `md`; compact chrome (sidebar, toolbars, table actions) may use `sm`.

| Need | Must use |
| --- | --- |
| Stack gap | `gap-4` / `gap-5` or `space-y-5` |
| Panel inner spacing | `Card` defaults |
| Console page padding | `(app)/layout.tsx` already pads `main` |
| Account padding | `px-4 py-16` on AccountShell |
| Icon | Lucide `size={14}` or `size={16}` |
| Full-width field | `fullWidth` on `TextField` / `Select` / `Button` |

The collapsed rail widths (`w-16` / `w-64`), meter fills, and table `min-w-*` locks are allowed. Below `md`, the rail is hidden and navigation opens in a HeroUI `Drawer` (`placement="left"`, `Backdrop variant="blur"`). Expanded navigation groups sections in a `DisclosureGroup`; the collapsed rail shows icons only.

## HeroUI composition

| Need | Use |
| --- | --- |
| Button | `onPress`, `isPending` with render-prop `Spinner size="sm" color="current"` when pending UI is shown. Must not use `onClick` or `isLoading` |
| Primary CTA | `Button` default variant. One per region |
| Destructive | `variant="danger"` or `variant="danger-soft"` |
| Icon-only | `Button isIconOnly` + `aria-label` |
| Panel | `Card` + `Card.Header` / `Card.Title` / `Card.Description` / `Card.Content` / `Card.Footer` |
| Menu | `Dropdown.Trigger` + `Dropdown.Popover` + `Dropdown.Menu` |
| Tabs | `Tabs`; `List` needs `aria-label` |
| Fields | `TextField` + `Label` + `Input` + `Description` + `FieldError` |
| Overlay | `Modal` with `Modal.Backdrop`; `useOverlayState` |
| Confirm | `AlertDialog` (`src/components/console/confirm-dialog.tsx`) |
| Table | `Table.ScrollContainer` > `Table.Content` |
| Status pill | `Chip` for real state only |
| Notice | `Alert` with `status` |
| Divider | `Separator` |
| Collapsible section | `Disclosure` + `Disclosure.Heading` / `Disclosure.Trigger` / `Disclosure.Indicator` / `Disclosure.Content` / `Disclosure.Body`; several in `DisclosureGroup` |
| Toast | `toast()` after `Toast.Provider` in AppProviders |

## Overflow and motion

Must not clip with `overflow-hidden`. Chat transcripts and nav lists scroll with `overflow-y-auto` on the pane.

Motion comes from HeroUI components (overlays, skeleton shimmer, spinners) and respects `prefers-reduced-motion`. Must not add page-level animations, custom keyframes, or an animation library.

## Verification

Run `npm run styles:check` and `npm run heroui:check` for UI changes, plus `npm run i18n:check` when copy changes. `styles:check` enforces the single stylesheet, HeroUI-only tokens, and the bans above; `heroui:check` enforces compound APIs, `onPress`, and no native controls. Inspect desktop and a narrow mobile width, both themes when chrome or color changes, and both locales when copy can reflow.
