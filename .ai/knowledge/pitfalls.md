# Pitfalls

Load when debugging surprises, adapter errors, or conflicting docs.

- Prisma pg adapter cannot deserialize void from `SELECT pg_advisory_xact_lock(...)`. Exclusive first-row writes must use `prisma.$transaction(..., { isolationLevel: "Serializable" })`, not `$queryRaw` / `$executeRaw`.
- `localePrefix: "never"` must not rewrite paths to `/en/...`. The app has no `[locale]` segment. `src/proxy.ts` copies intl cookies and continues.
- `/internal-api/setup` is public on purpose. Must not redirect `/`, login, or register there when the user table is empty.
- `cookies().delete()` omits `Secure`, so browsers ignore it for `__Host-` cookies. Clear them with `set` and the full cookie options.
- A signed but revoked session cookie would loop between the console layout and the proxy. `requireAuth` sends stale cookies to `/internal-api/account/expired`, which clears the cookie.
- Passkeys need `NEXT_PUBLIC_APP_URL` with HTTPS and a domain, or `localhost`. IP-address hosts cannot be WebAuthn relying parties.
- Login after `Set-Cookie` must navigate with the App Router (`useRouter().replace`). Do not use `window.location` for in-app HTML routes; file downloads may use `<a href>`.
- HeroUI v3 Select items are `ListBox.Item`. Modal open state lives on the Modal root via `useOverlayState`.
- `z.email()` rejects `admin@localhost`. Account schemas use `includes("@")`.
- `docker-compose.dev.yml` publishes Postgres on **127.0.0.1:5433**. `5432` is often already taken on developer machines. `docker-compose.yml` publishes no database or Redis ports.
- `next build` imports route modules and `src/lib/db/prisma.ts` validates env on import. Without `DATABASE_URL` and `APP_SECRET` the build fails while collecting page data.
- Redis is optional. Awaiting Redis or BullMQ in `src/instrumentation.ts` blocks Next from binding. Without `REDIS_URL` the in-process timer is the worker.
- Prisma does not type-check keys inside nested `select` or `data` objects passed through generic helpers. A removed column compiles and fails at runtime. After dropping a field, grep for it across `src/`.
- Role templates are seeded once (`role_templates_seeded` in `src/lib/bootstrap/system-catalog.ts`). A permission added to the catalog reaches only the owner automatically; stored roles, including `admin`, get it only through "Reset to template" or a manual edit.
- `isOpaqueText` (`src/lib/gateway/pii.ts`) marks strings as binary, and binary strings are never PII-scanned and are elided from stored log content. Its character class must not include spaces, or long prose without punctuation escapes redaction.
- Streaming chat must end with exactly one `data: [DONE]`. Upstreams send their own; the stream mapper in `src/lib/gateway/chat.ts` emits one and drops the rest.
- Four migrations share the `20261006120000_` timestamp and Prisma applies them in lexical folder order. A new migration with an equal or earlier timestamp sorts into the middle of history; always use a later one.
- A key with model templates allows only its explicit models plus template matches. A template whose rules match nothing leaves the key with no models. Model groups that route to a deployment without a provider connection never match provider, ZDR, no-training, retention, or region rules (`modelPolicies` in `src/lib/gateway/model-policy.ts`).
- The usage PDF (`src/lib/http/usage-pdf.ts`) uses the standard Helvetica fonts with `WinAnsiEncoding`. Characters outside Latin-1 and the mapped WinAnsi extras print as `?`, so model names and copy in other scripts degrade there.
- `fireAlert` swallows errors and returns when no webhook subscribes to the event. A missing alert usually means an unsubscribed event, not a failed send; failed sends write `alert_failed` audit rows.
