# LLM Hub visual contract

Load this file for any UI, theme, layout, motion, or accessibility work. It is the sole active design contract.

The UI is HeroUI v3 (`@heroui/react` / `@heroui/styles`) plus Tailwind CSS 4 layout utilities. There is one stylesheet, `src/styles/globals.css`: it imports `tailwindcss` and `@heroui/styles`, declares the `dark` custom variant, and overrides official HeroUI tokens (`--accent`, `--foreground`, `--background`, `--surface*`, `--overlay`, `--default`, `--segment`, `--muted`, `--success` / `--warning` / `--danger` and their `-foreground`, `--border`, `--separator`, `--field-*`, `--backdrop`, `--surface-shadow`, `--overlay-shadow`, `--field-shadow`, …) for `.light` and `.dark`, plus `--skeleton-animation: none` under `prefers-reduced-motion: reduce`. Nothing else. Must not add another stylesheet, custom classes, `@keyframes`, `@theme`, comments, or non-HeroUI custom properties to it. The root layout is the only module that imports it. Theme class on `<html>` (`.dark` / `.light`, next-themes). This is an authenticated LLM gateway console, not a marketing site.

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
| Panel | `Card` (fill comes from `--surface`, edge and depth from `--surface-shadow`) |
| Nested panel | `Card variant="secondary"` |
| Raised panel | `shadow-overlay` on the account card, the chart tooltip, and the large `BrandMark` only |
| Subtle fill / hover | `bg-default` or `bg-foreground/5` |
| Border on layout chrome | `border-border` |
| Primary text | `text-foreground` |
| Secondary text | `text-muted` |
| Status | `text-success` / `text-warning` / `text-danger` / `text-accent` |
| Charts | See Charts below |

There is no `default-N` scale. Must not use raw Tailwind palette colors (`text-zinc-500`, `bg-indigo-600`, …), `text-white`, `text-black`, or gradients. The brand mark (`src/components/brand/brand-mark.tsx`, hub-and-nodes glyph) uses `bg-accent text-accent-foreground`; `src/app/icon.svg`, `src/app/apple-icon.tsx`, `src/app/favicon.ico`, and the usage PDF header in `src/lib/export/usage-pdf.ts` carry the same glyph and must change with it. They cannot read CSS variables: `src/app/icon.svg`, `src/app/apple-icon.tsx`, and the three PNG frames in `src/app/favicon.ico` hardcode the light `--accent` (`oklch(0.535 0.22 276)`) as `#5252e8`, and `COLORS` in `src/lib/export/pdf.ts` holds sRGB copies of the light tokens (`accent` is `[82, 82, 232]`, `ink` is `--foreground`, `muted` is `--muted`). Update them in the same change as `src/styles/globals.css`. Primary actions use the default `Button` variant.

## Color

The console is confident and calm: one indigo accent (hue 276 in light, 274 in dark) on near-neutral greys (chroma 0.002 to 0.008 at hue 277) in both themes, so canvas, panels, borders, and shadows read as one quiet family and the accent carries the color. Must not add hues beyond the accent and the three status tokens, and must not tint neutrals further toward the accent.

- Light theme: a near-white canvas (`--background`), white panels (`--surface`) lifted by a hairline `--surface-shadow`, faintly tinted nested panels and fills (`--surface-secondary`, `--surface-tertiary`, `--default`), and translucent ink borders.
- Dark theme: a near-black canvas with three clearly separated surface steps and white-alpha borders; `--surface-shadow` is a hairline ring. Must not fall back to flat mid-grey surfaces.
- Shape: `--radius: 0.25rem` and `--field-radius: 0.5rem` make buttons and cards rounded rectangles (about 12 px), chips and menu items about 8 px, and fields 8 px. Must not bring back pill shapes with radius classes on HeroUI controls.
- Status tokens are tuned per theme so `text-success`, `text-warning`, `text-danger`, `text-accent`, and `text-muted` reach WCAG AA (4.5:1) on `--background`, `--surface`, `--surface-secondary`, `--surface-tertiary`, `--default`, `--overlay`, and the field background. Solid fills carry their `-foreground` token: white in light, deep ink in dark for `--accent`, `--success`, `--warning`, and `--danger`. Re-check these ratios with computed colors whenever a token moves.
- Every console page passes its nav icon to `PageHeader` (`icon`), which renders an accent `IconTile` next to the `h1`.
- `IconTile` (`src/components/console/icon-tile.tsx`) is the only tinted icon box: a token fill at low opacity with an inset ring of the same tone; tones `accent`, `success`, `warning`, `danger`, `neutral`, sizes `sm` / `md` / `lg` / `xl` (`xl` is for `EmptyState`). Must not hand-roll `bg-*/N` icon boxes.
- `StatCard` takes an `icon` and a `tone` that matches the meaning of the number (`success` for healthy or available, `warning` for limited or nearing a cap, `danger` for failures, `accent` for neutral totals, `neutral` for a zero or a timing). The label sits top left, the tile top right, and the value below it in `tabular-nums`.
- `EmptyState` shows an `xl` accent tile, a title, a description that says what will appear here, and the page's next action when it has one.
- Real state uses colored `Chip`s (`color="success" | "warning" | "danger" | "accent"`, `variant="soft"`); counts and labels stay `variant="soft"` without color.
- Selected options in choice cards use `bg-accent/8` with `border-accent`; unselected ones stay on `Card variant="secondary"`.
- Token fills with an opacity modifier (`bg-accent/8` to `bg-accent/14`, same for `success`, `warning`, `danger`) are allowed for tiles, selected states, and highlighted rows only. One tinted emphasis per card.

## Charts

Charts use Recharts with token colors only (`src/app/(app)/usage/_components/usage-charts.tsx`; its tooltip is `src/app/(app)/usage/_components/chart-tooltip.tsx`). The per-key subscription bars (`src/app/(app)/providers/_components/key-usage-bar.tsx`) stack one accent hue at falling `fillOpacity` per key rank, `var(--muted)` for grouped or unattributed usage, and `var(--default)` for the free remainder, without animation because live data redraws them; a HeroUI `Tooltip` (portal, so table clipping cannot cut it) lists every part, and `KeyUsageLegend` names the top keys under the bar for touch users.

| Role | Must use |
| --- | --- |
| Spend, volume, one-hue comparisons | `var(--accent)`; area fills fade the accent from 34 % to 2 % |
| OK outcomes | `var(--success)` |
| Errors | `var(--danger)` |
| Rate limits (429) | `var(--warning)` |
| Grid | `var(--separator)`, dashed `3 4`, horizontal only for time series |
| Axis ticks | `var(--muted)`, 12 px |
| Hover band | `var(--accent)` at 6 % opacity |
| Mark gaps and rings | `var(--surface)` stroke, 2 px, between stacked segments and around active dots and donut slices |

Status colors keep their meaning and are never reused as a categorical series; a chart that compares entities (models, companies, people) uses one hue. Data ends are rounded (4 px vertical, 6 px horizontal bars), lines are 2.5 px, and every multi-series chart has a legend with a dot per series. Tooltips are `Card` with `shadow-overlay`, text in `text-muted` and `text-foreground`.

## Typography and document outline

- Use Geist via `--font-geist-sans` / `--font-geist-mono` from `src/app/layout.tsx`.
- Use the Tailwind type scale `text-xs` through `text-2xl` in the console. Must not write `text-[Npx]` or `text-[Nrem]`.
- Exactly one `h1` per route. Console page titles come from `PageHeader` (`text-xl font-semibold tracking-tight` next to an `md` `IconTile`); stat values are `text-xl` that grows to `text-2xl` from a 13rem card; account screens use `text-2xl`, and the `<accent>` chunk of an account heading is `text-muted`. Panel headings are `Card.Title`.
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

The rail widths (`w-16` / `w-60`), meter fills, and table `min-w-*` locks are allowed. The sidebar sits on the canvas color (`bg-background`) with a vertical `Separator` to the content. Below `md`, the rail is hidden and navigation opens in a HeroUI `Drawer` (`placement="left"`, `Backdrop variant="blur"`) with the scope switcher on top, the navigation, and the user menu row; it repeats no footer controls. Expanded navigation shows each section under a small plain `text-xs text-muted` label (no `DisclosureGroup`, no chevrons); the first section (`untitled`, Overview) has no label. The collapsed rail keeps one centre line: centred brand, `size-9` square links with `justify-center` and a `Tooltip` (`placement="right"`) on every item, a `Separator` between sections, and a one-column footer (the build notice when there is one, then the user menu). The collapse toggle lives in the top bar before the breadcrumbs, not in the sidebar. A rail link is the `Tooltip.Trigger` itself (`render` returns the `Link`), and a rail menu is an icon-only `Button` inside the `Tooltip`; must not nest a link or button inside a trigger. Must not centre rail items with padding alone or spread footer controls with `justify-between`. Navigation rows (links, scope switcher, user menu) are `rounded-xl`; the active link is `bg-foreground/8` with `font-medium` foreground text and an accent icon, idle rows are `text-muted` and hover with `bg-foreground/5`, and their color change uses `motion-safe:transition-colors`.

## Responsive layout

Every console screen must work at 390 px wide without horizontal page scroll.

- Below `sm` the `(app)` layout pads `main` with `p-4`. Below `md` the top bar shows the menu button, brand and page title (truncated), a scope button that opens the drawer, the health dot (its label stays visible when the status is down), and the Avatar user menu that holds the connection check and sign-out.
- `PageHeader` actions wrap under the title when they do not fit beside it. Must not force them onto the title row.
- `StatCard` keeps label and tile on one row and sizes the value with a container query, so it never needs to stack. Four-up stat grids must not start before `lg`, because the rail narrows the pane at `md`.
- A list `Table` must have a card twin: `RowCards` with one `RowCard` per row (`src/components/console/row-cards.tsx`) below `lg`, and `className={TABLE_FROM_LG}` on the `Table`. Inside a `Card` the twin uses `variant="secondary"`, inside a secondary card `variant="tertiary"`. Row chips and actions live in one helper that the table cell and the card both call, so the two never drift. Markdown tables inside transcripts may scroll instead.
- Long filter forms collapse below `md` into a `Disclosure` whose trigger counts active filters; the desktop form stays expanded. Breakpoint-dependent rendering reads `useMediaQuery` with `BELOW_MD` / `BELOW_LG` from `src/lib/hooks/use-media-query.ts`. Must not add resize listeners or set state in an effect for this.
- Long values (emails, model ids, paths) wrap with `break-words`. Use `break-all` only where the table cell already did.

## Page structure and rule lists

The console must be understandable without documentation.

- Every page answers what this is, what the state is, and what to do next: `PageHeader` with the nav icon, the title, one plain sentence, and at most one primary action; secondary actions are `variant="secondary"` or sit in a `Dropdown`.
- No page inside a page. Nesting stops at page, `Card`, `Card variant="secondary"`. An entity detail is its own route with tabs (see [instructions/frontend.md](instructions/frontend.md)) or at most one `Modal` / `Drawer`; a stack of six or more cards becomes tabs.
- List toolbars put the `SearchField` left, filters next to it, and the primary action right or in the page header. A list shows its `SearchField` from 6 rows (`SEARCH_FROM = 6`).
- Lists that grow with use (guardrail rules and overrides, markups, model groups and presets, MCP access rules) are a `Table` with its `RowCards` twin and a one-line plain summary per row from a pure helper (`src/app/(app)/guardrails/_components/rule-summary.ts`, `src/lib/pricing/markup-view.ts`, `src/app/(app)/models/_components/group-summary.ts`, `src/app/(app)/mcp/_components/access-view.ts`). Each rule is added and edited in its own dialog. Rules inside a dialog switch in place between the list and a single-rule view; must not open a dialog on top of a dialog or edit a growing list inline in one large form.
- Inheritance is visible where it applies: each part says "Inherited from …" or "Set here", and override rows show what changes (from → to).
- Concepts are explained in one short sentence where they appear (`Description`, `Card.Description`, `EmptyState`), without walls of text.

## HeroUI composition

| Need | Use |
| --- | --- |
| Button | `onPress`, `isPending` with render-prop `Spinner size="sm" color="current"` when pending UI is shown. Must not use `onClick` or `isLoading` |
| Primary CTA | `Button` default variant. One per region |
| Destructive | `variant="danger"` or `variant="danger-soft"` |
| Icon-only | `Button isIconOnly` + `aria-label` |
| Panel | `Card` + `Card.Header` / `Card.Title` / `Card.Description` / `Card.Content` / `Card.Footer` |
| Menu | `Dropdown` with a `Button` child + `Dropdown.Popover` + `Dropdown.Menu`; `Dropdown.Trigger` only for a custom non-button trigger, never wrapping a `Button` |
| Tabs | `Tabs`; `List` needs `aria-label`. Page-level tabs are `PageTabs` (underline style, `variant="secondary"`, the list scrolls horizontally on narrow screens) |
| Fields | `TextField` + `Label` + `Input` + `Description` + `FieldError` |
| Overlay | `Modal` with `Modal.Backdrop`; `useOverlayState`. A dialog opened from state (not from a trigger child) passes `isOpen` / `onOpenChange` to `Modal.Backdrop` (or `AlertDialog.Backdrop`) instead of `state` on the root, which otherwise logs a React Aria "PressResponder rendered without a pressable child" warning |
| Form with more than about six fields | `StepDialog` (`src/components/console/step-dialog.tsx`): steps with `title`, `description`, `optional`, `isValid`, `content`; trailing optional steps let the user finish early. Shorter forms are a `FormDialog`, optionally with an Advanced `Disclosure` |
| Choice between a few options that need explaining | Choice cards: a radio group of option cards with a one-line hint each (`src/components/console/choice-cards.tsx`) |
| Confirm | `AlertDialog` (`src/components/console/confirm-dialog.tsx`) |
| Table | `Table.ScrollContainer` > `Table.Content`, with a `RowCards` twin below `lg` (see Responsive layout) |
| Status pill | `Chip` for real state only |
| Notice | `Alert` with `status` |
| Divider | `Separator` |
| Collapsible section | `Disclosure` + `Disclosure.Heading` / `Disclosure.Trigger` / `Disclosure.Indicator` / `Disclosure.Content` / `Disclosure.Body`; several in `DisclosureGroup` |
| Toast | `toast()` after `Toast.Provider` in AppProviders |

## Overflow and motion

Must not clip with `overflow-hidden`. Chat transcripts and nav lists scroll with `overflow-y-auto` on the pane.

Motion comes from HeroUI components (overlays, skeleton shimmer, spinners) and respects `prefers-reduced-motion`. `FormDialog` and `ConfirmDialog` use the `blur` backdrop; `Skeleton` reads the `--skeleton-animation` token, so the shimmer stops for reduced motion without per-call props. Must not add page-level animations, custom keyframes, or an animation library.

## Verification

Run `npm run styles:check` and `npm run heroui:check` for UI changes, plus `npm run i18n:check` when copy changes. `styles:check` enforces the single stylesheet, HeroUI-only tokens, and the bans above; `heroui:check` enforces compound APIs, `onPress`, and no native controls. Inspect desktop, a tablet width with the rail (768 px), and a 390 px mobile width, both themes when chrome or color changes, and both locales when copy can reflow.
