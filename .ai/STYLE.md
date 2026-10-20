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

There is no `default-N` scale. Must not use raw Tailwind palette colors (`text-zinc-500`, `bg-indigo-600`, …), `text-white`, `text-black`, or gradients. The brand mark (`src/components/brand/brand-mark.tsx`, hub-and-nodes glyph) uses `bg-accent text-accent-foreground`; `src/app/icon.svg`, `src/app/apple-icon.tsx`, `src/app/favicon.ico`, and the usage PDF header in `src/lib/export/usage-pdf.ts` carry the same glyph and must change with it. They cannot read CSS variables: `src/app/icon.svg` and `src/app/apple-icon.tsx` hardcode the light `--accent` (`oklch(0.585 0.2 277)`) as `#6367ef`, and `COLORS` in `src/lib/export/usage-pdf.ts` holds sRGB copies of the light tokens (`accent` is `[99, 103, 239]`). Update them in the same change as `src/styles/globals.css`. Primary actions use the default `Button` variant.

## Color

The console is calm but not grey. Color comes from the HeroUI status tokens at low opacity, never from new hues.

- Every console page passes its nav icon to `PageHeader` (`icon`), which renders an accent `IconTile` next to the `h1`.
- `IconTile` (`src/components/console/icon-tile.tsx`) is the only tinted icon box: tones `accent`, `success`, `warning`, `danger`, `neutral`, sizes `sm` / `md` / `lg`. Must not hand-roll `bg-*/N` icon boxes.
- `StatCard` takes an `icon` and a `tone` that matches the meaning of the number (`success` for healthy or available, `warning` for limited or nearing a cap, `danger` for failures, `accent` for neutral totals).
- Real state uses colored `Chip`s (`color="success" | "warning" | "danger" | "accent"`, `variant="soft"`); counts and labels stay `variant="soft"` without color.
- Selected options in choice cards use `bg-accent/8` with `border-accent`; unselected ones stay on `Card variant="secondary"`.
- Token fills with an opacity modifier (`bg-accent/8` to `bg-accent/14`, same for `success`, `warning`, `danger`) are allowed for tiles, selected states, and highlighted rows only. One tinted emphasis per card.

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

The rail widths (`w-16` / `w-64`), meter fills, and table `min-w-*` locks are allowed. Below `md`, the rail is hidden and navigation opens in a HeroUI `Drawer` (`placement="left"`, `Backdrop variant="blur"`) with the scope switcher on top, the navigation, and the user menu row; it repeats no footer controls. Expanded navigation groups sections in a `DisclosureGroup`. The collapsed rail keeps one centre line: centred brand, `size-10` square links with `justify-center` and a `Tooltip` (`placement="right"`) on every item, a `Separator` between sections and above the pinned items, and a one-column footer (user menu, then the collapse toggle). A rail link is the `Tooltip.Trigger` itself (`render` returns the `Link`), and a rail menu is an icon-only `Button` inside the `Tooltip`; must not nest a link or button inside a trigger. Must not centre rail items with padding alone or spread footer controls with `justify-between`.

## Responsive layout

Every console screen must work at 390 px wide without horizontal page scroll.

- Below `sm` the `(app)` layout pads `main` with `p-4`. Below `md` the top bar shows the menu button, brand and page title (truncated), a scope button that opens the drawer, the health dot (its label stays visible when the status is down), and the Avatar user menu that holds the connection check and sign-out.
- `PageHeader` actions wrap under the title when they do not fit beside it. Must not force them onto the title row.
- `StatCard` stacks the icon above the value through a container query when the card is narrow. Four-up stat grids must not start before `lg`, because the rail narrows the pane at `md`.
- A list `Table` must have a card twin: `RowCards` with one `RowCard` per row (`src/components/console/row-cards.tsx`) below `lg`, and `className={TABLE_FROM_LG}` on the `Table`. Tables in a narrow column (the company detail pane) use `until="xl"` with `TABLE_FROM_XL`. Inside a `Card` the twin uses `variant="secondary"`, inside a secondary card `variant="tertiary"`. Row chips and actions live in one helper that the table cell and the card both call, so the two never drift. Markdown tables inside transcripts may scroll instead.
- Long filter forms collapse below `md` into a `Disclosure` whose trigger counts active filters; the desktop form stays expanded. Breakpoint-dependent rendering reads `useMediaQuery` with `BELOW_MD` / `BELOW_LG` from `src/lib/hooks/use-media-query.ts`. Must not add resize listeners or set state in an effect for this.
- Long values (emails, model ids, paths) wrap with `break-words`. Use `break-all` only where the table cell already did.

## HeroUI composition

| Need | Use |
| --- | --- |
| Button | `onPress`, `isPending` with render-prop `Spinner size="sm" color="current"` when pending UI is shown. Must not use `onClick` or `isLoading` |
| Primary CTA | `Button` default variant. One per region |
| Destructive | `variant="danger"` or `variant="danger-soft"` |
| Icon-only | `Button isIconOnly` + `aria-label` |
| Panel | `Card` + `Card.Header` / `Card.Title` / `Card.Description` / `Card.Content` / `Card.Footer` |
| Menu | `Dropdown` with a `Button` child + `Dropdown.Popover` + `Dropdown.Menu`; `Dropdown.Trigger` only for a custom non-button trigger, never wrapping a `Button` |
| Tabs | `Tabs`; `List` needs `aria-label` |
| Fields | `TextField` + `Label` + `Input` + `Description` + `FieldError` |
| Overlay | `Modal` with `Modal.Backdrop`; `useOverlayState` |
| Confirm | `AlertDialog` (`src/components/console/confirm-dialog.tsx`) |
| Table | `Table.ScrollContainer` > `Table.Content`, with a `RowCards` twin below `lg` (see Responsive layout) |
| Status pill | `Chip` for real state only |
| Notice | `Alert` with `status` |
| Divider | `Separator` |
| Collapsible section | `Disclosure` + `Disclosure.Heading` / `Disclosure.Trigger` / `Disclosure.Indicator` / `Disclosure.Content` / `Disclosure.Body`; several in `DisclosureGroup` |
| Toast | `toast()` after `Toast.Provider` in AppProviders |

## Overflow and motion

Must not clip with `overflow-hidden`. Chat transcripts and nav lists scroll with `overflow-y-auto` on the pane.

Motion comes from HeroUI components (overlays, skeleton shimmer, spinners) and respects `prefers-reduced-motion`. Must not add page-level animations, custom keyframes, or an animation library.

## Verification

Run `npm run styles:check` and `npm run heroui:check` for UI changes, plus `npm run i18n:check` when copy changes. `styles:check` enforces the single stylesheet, HeroUI-only tokens, and the bans above; `heroui:check` enforces compound APIs, `onPress`, and no native controls. Inspect desktop, a tablet width with the rail (768 px), and a 390 px mobile width, both themes when chrome or color changes, and both locales when copy can reflow.
