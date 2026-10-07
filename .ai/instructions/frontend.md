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
- Pages are `"use client"` and load data with server actions in `useEffect` into `useState`. Mutations return the new payload and the client replaces its state. Must not use `router.refresh`, `revalidatePath`, or `revalidateTag`.
- Must not create pass-through components that only return another component. A page composes its own markup; `_components/` hold parts with their own state or logic.
- Must not wrap pages in `Suspense` for search params. Read them with `useSearchParam` (`src/lib/hooks/use-search-param.ts`, `useSyncExternalStore`). Do not call `setState` synchronously inside `useEffect` (`react-hooks/set-state-in-effect`).
- Loading and pending states use HeroUI: `Skeleton` or `Spinner` while loading, `isPending` with a render-prop `Spinner` on every async `Button`, and one transition per independent action.
- Shared security UI lives in `src/components/security/` (step-up dialog, second-factor input, TOTP enrollment, recovery codes, WebAuthn helpers).
- Console navigation is `NAV` in `src/app/(app)/_components/nav-data.ts`: sections of items, each with the permission that shows it. A new console page must be added there. `/` redirects to `/keys`, and retired console paths (`/structure`, `/organizations`, `/teams`, `/projects`, `/budgets`) redirect to `/companies` through `redirects()` in `next.config.ts`; must not recreate pages at those paths.
- The console assistant is the `/assistant` page. Its transcript, model choice, and write switch live in the `AssistantProvider` context (`src/app/(app)/_components/assistant-session.tsx`) mounted by the `(app)` layout, so a conversation survives navigation; the top bar only links to the page. Model output renders through `react-markdown` + `remark-gfm` without raw HTML, and links pass `safeHref` (in-app paths or `http(s)` only).

## Architecture

- `src/app/(app)/` authenticated console.
- `src/app/account/` public account screens.
- `src/app/internal-api/` private HTTP plus the first-operator page `setup/`.
- `src/app/v1/` gateway.
- `src/app/api/` management-key API; see [api.md](api.md).
- Colocated walk policy: `test/route-view-policy.ts`.

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
