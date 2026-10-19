---
type: instruction
description: Load for Next.js routing, layouts, components, proxy, or frontend configuration work.
scope: repository
---

# Frontend

Load before changing `src/app/`, `src/proxy.ts`, `src/i18n/` navigation, or Next.js/Tailwind/HeroUI configuration. Also load [STYLE.md](../STYLE.md) for visible work and [content-localization.md](content-localization.md) for copy.

## Mandatory rules

- This is Next.js 16 (exact version pinned in `package.json`). Before writing Next.js code, read the relevant guide under `node_modules/next/dist/docs/` completely. Do not edit the Next.js-owned block in root `AGENTS.md`.
- Request interception lives in `src/proxy.ts` (not `middleware.ts`).
- Keep the routing kernel on the route: `page`, `layout`, `loading`, `error`, `not-found`, `route`, `_action`. Route-only UI lives in that route's `_components/` folder (kebab-case). `src/components/<domain>/` is shared UI only after a second route imports it. Domain folders are lowercase.
- `page.tsx` stays a real page: auth, data loading, composition. Must not extract the whole page into a stub that only returns `<View />`.
- After a server action, update client `useState`. Must not use `revalidatePath` or `router.refresh`.
- Preserve `localePrefix: "never"` from `src/i18n/routing.ts`. Default locale is English; German overlays `lang/de`.
- HeroUI v3 compound components, `onPress`, and no `HeroUIProvider` are mandatory; see [STYLE.md](../STYLE.md).
- In-app navigation uses `Link` / `useRouter` from `@/i18n/routing`. File downloads use `<a href>`.
- Pages are `"use client"` and load data with their server actions through `useActionData` (`src/lib/hooks/use-action-data.ts`), which exposes `data`, `error`, `pending`, `reload`, `reloadWith`, and `setData` without setting state synchronously in an effect. Mutations return the new payload and the client replaces its state with `setData`. Must not use `router.refresh`, `revalidatePath`, or `revalidateTag`. The console's only server page is `src/app/(app)/page.tsx`, which redirects `/` to the user's console home.
- Must not create pass-through components that only return another component. A page composes its own markup; `_components/` hold parts with their own state or logic.
- Must not wrap pages in `Suspense` for search params. Read them with `useSearchParam` (`src/lib/hooks/use-search-param.ts`, `useSyncExternalStore`). Do not call `setState` synchronously inside `useEffect` (`react-hooks/set-state-in-effect`).
- Loading and pending states use HeroUI: `Skeleton` or `Spinner` while loading, `isPending` with a render-prop `Spinner` on every async `Button`, and one transition per independent action. Before data arrives a page returns `PageStatus` (`src/components/console/page-status.tsx`: the shared spinner, or its title with a translated error `Alert` and Retry); `LoadError` shows a failed refresh above loaded data. Empty lists and searches without matches use `EmptyState`. Failed actions toast through `useErrorToast`.
- Form dialogs use `FormDialog` (`src/components/console/form-dialog.tsx`: HeroUI `Modal` around a `Form`, Enter submits, standard Cancel and pending submit footer, sizes `sm`/`md`/`lg`/`xl`). Confirmations use `ConfirmDialog`, either with a trigger child or with an overlay `state` from a menu action. Clipboard writes go through `CopyButton`; All console settings are one `/settings` page with `Tabs` (`?tab=general|sign-in|storage|logging|cache|catalog`); each tab in `settings/_components/` loads and saves its own slice through `settings/_action.ts` and composes `SettingSection`, `SettingSwitch`, and `SettingText` from `settings/_components/setting-fields.tsx`.
- Shared security UI lives in `src/components/security/` (step-up dialog, second-factor input, TOTP enrollment, recovery codes, WebAuthn helpers).
- Console navigation is `NAV` in `src/app/(app)/_components/nav-data.ts`: five sections (Organization, Models & providers, Policies, Insights, Platform) of at most a dozen items. An item's `permission` may be a list; `canSee` shows it when the user holds any of them. Related screens are tabs of one page (`?tab=` through `useSearchParam`), not separate nav items: `/providers` (API providers, subscriptions, health), `/models` (catalog, groups), `/keys` (keys, model templates), `/users` (users, roles), `/usage` (overview, markups), `/settings`, `/developer` (playground, API reference). A new console screen becomes a tab of the matching page before it becomes a nav item. `/` redirects to the first NAV item the user's permissions show (`homePath`, falling back to `/account`), and retired console paths redirect through `redirects()` in `next.config.ts` to their tab (the removed `/assistant` and `/what-if` to `/`); must not recreate pages at those paths.
- Related screens share one route as tabs: `/models` (`catalog`, `groups`), `/keys` (`keys`, `templates`), `/users` (`users`, `roles`), `/usage` (`overview`, `markups`), and `/developer` (`playground`, `api`). The page renders `PageHeader` with its nav icon and `PageTabs` (`src/components/console/page-tabs.tsx`); the active tab lives in `?tab=` through `useTabParam` and other in-page params go through `setSearchParams` (`src/lib/hooks/use-search-param.ts`). A tab whose permission differs from the page's is hidden through `grantedPermissions` (`src/lib/auth/guards.ts`) in the page's `_action.ts`; a single visible tab renders without the tab list. Each tab body is a `_components/<name>-tab.tsx` that loads its own data and returns `PageStatus` without a title while loading. Old paths (`/model-catalog`, `/model-templates`, `/roles`, `/markups`, `/playground`, `/api-ref`) are redirects, not pages.
- Build status lives in `BuildStatusProvider` (`src/app/(app)/_components/build-status.tsx`), mounted by the `(app)` layout with the server's `currentBuild()`. It is the console's only live connection: an `EventSource` on `/internal-api/live` (see [api.md](api.md)). A stream without events for `LIVE_STALE_MS` (35 s) counts as lost; while lost it reconnects (every 5 s, later every 30 s) and probes `/internal-api/version` to tell Reconnecting from Offline. Only browsers without `EventSource` poll `/internal-api/version` every 30 s instead (constants in `src/lib/updates/build-change.ts`). It feeds the top bar badge (`live-badge.tsx`: Live, Updating, Reconnecting, Offline), whose popover shows version, uptime, and the updater (`updater-panel.tsx`, actions in `updater-controls.tsx`). When the served build differs from the loaded one (never for `development`), it shows a persistent toast with Reload and the sidebar footer keeps a Reload button; the footer also shows the current version, the Update available link from `loadUpdateStatusAction`, and Install (`install-update.tsx`, with a confirm dialog) when a connected updater has a new image. `auto-update-notice.tsx` offers to turn on automatic updates while an updater is connected and they are off; Not now is remembered in `localStorage`. Settings → General has an Automatic updates section whose switch applies immediately instead of through the Save bar, because the popover and the notice change the same setting. Reload calls `window.location.reload()`: only a full document load picks up the new client bundle and server action ids, so it is not a `router.refresh` substitute and must not be used after mutations.
- Model output in request log transcripts renders through `Markdown` (`src/app/(app)/logs/_components/markdown.tsx`: `react-markdown` + `remark-gfm`) without raw HTML, and links pass `safeHref` (in-app paths or `http(s)` only).

## Architecture

- `src/app/(app)/` authenticated console.
- `src/app/account/` public account screens.
- `src/app/internal-api/` private HTTP plus the first-operator page `setup/`.
- `src/app/api/v1/` and `src/app/api/subscription/` gateway; `src/app/api/mgmt/` management-key API; see [api.md](api.md).
- Colocated walk policy: `src/tests/route-view-policy.ts`.

## Prohibited patterns

- Do not add `src/middleware.ts`, `HeroUIProvider`, v2 flat subcomponents, `dark:` utilities, or overflow clipping.
- Do not put test-only walkers in `src/lib`.
- Do not add mapping-only wrappers.

## Commands

- `npm run dev`
- `npm run styles:check && npm run heroui:check && npm run i18n:check`
- `npx tsc --noEmit`

## Validation

For UI, inspect mobile and desktop, both themes when chrome changes, and both locales when copy reflows.
