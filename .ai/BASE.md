# LLM Hub agent base

Read [SUMMARY.md](SUMMARY.md) before starting work. Load only the documents that match the task.

## Conduct

- Must inspect current implementations before adding patterns, abstractions, libraries, or dependencies.
- Must prefer existing project conventions and the sources of truth listed in [SUMMARY.md](SUMMARY.md).
- Must preserve unrelated files and existing user changes.
- Must not add comments to source, tests, scripts, config, SQL, or CSS. Express intent through names and types, and record durable rationale in the matching `.ai/` document. Script shebangs are the only exception.
- Must not create commits unless the user explicitly asks for a commit.
- Must never claim or disclose that repository work was assisted or generated in commits, pull requests, changelogs, documentation, or code comments unless the user explicitly requests that disclosure.
- Must never add `Co-authored-by`, attribution, or generated-by trailers.
- Must verify work with this repository's real checks, in proportion to risk (`npm test`, `npm run lint`, `npm run i18n:check`, `npm run styles:check`, `npm run heroui:check`, `npx tsc --noEmit`).
- Must not extend `.ai/` during ordinary product work unless the user asked to maintain context. If a reusable gap remains, ask first. Read [AI.md](AI.md) only when modifying this context system.

## Safety

- Must not write exploits, malware, or attack any system.
- Must not put secrets, credentials, personal data, or private machine paths into the repository or into `.ai/` documents.
- Must treat `src/app/internal-api/`, `/api`, `/v1`, `/scim`, and `/sso` as gated surfaces. `src/app/api/` is only the management-key API; must not expose internal or session-cookie routes there.

## Precedence

1. This file.
2. Mandatory domain Instructions listed in [SUMMARY.md](SUMMARY.md).
3. [STYLE.md](STYLE.md) for any UI, theme, layout, motion, or accessibility work.
4. A Playbook, only when its procedure matches the task.
5. A Persona, only as extra scrutiny. Personas and Playbooks must not override this file or mandatory Instructions.

If two active documents conflict, stop and resolve from current enforced sources (`src/styles/globals.css`, `src/proxy.ts`, `prisma/schema/`, `prisma.config.ts`, `package.json` scripts, installed Next.js docs under `node_modules/next/dist/docs/`). Do not invent a third convention.

`AGENTS.md` keeps a Next.js-owned `<!-- BEGIN:nextjs-agent-rules -->` block after the adapter line. That block is a compatibility exception: `next dev` writes and re-adds it at the repository root. Its meaning is also routed through [instructions/frontend.md](instructions/frontend.md). Do not edit the block wording.

## Task routing

1. Classify the task (UI, auth, schema, API, i18n, gateway, deploy, context).
2. Open [SUMMARY.md](SUMMARY.md) and load matching Knowledge plus every mandatory Instruction for those domains.
3. Load a Playbook only when the procedure is this repository's, not generic engineering.
4. Apply a Persona when its review method would change the decision or catch a domain-specific miss.
5. Always load [STYLE.md](STYLE.md) for UI, design, responsive, interaction, motion, or accessibility work. Restyles also load [playbooks/build-ui.md](playbooks/build-ui.md) and [personas/style-enforcer.md](personas/style-enforcer.md). Fetch HeroUI from `node_modules/@heroui/react/dist/components/` or `https://heroui.com/react/llms-full.txt`.
6. Ask about extending `.ai/` if a reusable gap remains and context maintenance is not already the task.
7. Run the validation named in the loaded Instruction or Playbook before calling the work done.

## Completion

Server Components may read data for the first paint. Anything that changes after mount must live in client state. Must not call `router.refresh()`, `revalidatePath`, or `revalidateTag`. After a mutation, update local state from the returned payload.

This app is Next.js 16. Request interception lives in `src/proxy.ts`. Do not add `src/middleware.ts`. Read `node_modules/next/dist/docs/` before using an unfamiliar Next.js API.
