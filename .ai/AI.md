# `.ai/` governance

Load this file only when creating, changing, reviewing, or removing context documents.

## Purpose

This directory is the assisted-development contract for LLM Hub. It is not application source. It must stay concise, evidence-backed, and routable from [BASE.md](BASE.md) and [SUMMARY.md](SUMMARY.md).

## Authority by category

| File | Role |
| --- | --- |
| [BASE.md](BASE.md) | Always-loaded conduct, safety, precedence, compact routing |
| [AI.md](AI.md) | This governance manual |
| [STYLE.md](STYLE.md) | Sole visual, theme, layout, component, motion, and accessibility contract |
| [SUMMARY.md](SUMMARY.md) | Exhaustive index of every other active `.ai/` Markdown file |
| `knowledge/` | Verified facts, terminology, decisions, traps |
| `instructions/` | Persistent rules for a broad engineering domain |
| `playbooks/` | Ordered repository-specific procedures |
| `personas/` | Specialist review method and expected output |

## Mandatory core

Every checkout that uses this system must have `BASE.md`, `AI.md`, `STYLE.md`, and `SUMMARY.md`. Optional category directories exist only when they contain at least one document that passed the evidence gate.

## Evidence gate

Create or keep an optional document only when all of these hold:

1. Distinct activation condition that future work is likely to hit.
2. Content supported by one enforced source or multiple consistent current sources.
3. Material improvement to implementation, review, debugging, or operations.
4. Facts, rules, or procedure are not already adequate in another active document (for Personas, apply this only to the review method and output).
5. Content stays concise and repository-specific.

When two proposed documents would load together and overlap, merge them. Split only when activation conditions differ. No category or file count is a quality target.

When `.ai/` already exists, a maintenance pass must re-read every active document, classify keep/update/merge/split/remove against current evidence, and close gaps. Do not preserve a weak tree because it already exists.

## Naming and language

- English, RFC terms: **must**, **must not**, **should**, **may**.
- Filenames: lowercase kebab-case.
- Instructions use stable domains (`frontend`, `api`), never a page, route, endpoint, or component name.
- Inside `.ai/`, use relative Markdown links plus an activation phrase.
- Cite implementation with repository-root paths in backticks.
- Do not store secrets, personal data, or private machine paths.

## Create, link, merge, split, remove

1. Classify the need against the evidence gate.
2. Prefer updating an existing document whose activation still fits.
3. Add a file only for a new activation condition.
4. Give every document except `SUMMARY.md` exactly one catalog sentence in `SUMMARY.md` and a route from `BASE.md` or that catalog.
5. When moving, merging, splitting, or deleting, update every inbound and outbound link in the same change.
6. Remove a document only after still-valid content has a new home.

## `SUMMARY.md` maintenance

Update `SUMMARY.md` in the same change whenever a document is created, moved, renamed, merged, split, or removed. Each entry is one sentence: purpose plus when to load it. Do not put rules, checklists, or evidence in the index.

## Tool-managed root blocks

Treat `<!-- BEGIN:… -->` … `<!-- END:… -->` as potentially owned by an external generator.

1. Snapshot the root file before changing it.
2. Identify the owner from repository evidence.
3. Verify whether the owner requires the original path and wording.
4. Migrate the meaning into the matching Instruction.
5. If the owner requires the root path, keep the block byte-for-byte after the adapter line.
6. If ownership or location cannot be verified, do not move or rewrite the block.

The Next.js block in root `AGENTS.md` (`BEGIN:nextjs-agent-rules`) is owned by Next.js: `next dev` writes and re-adds it (`node_modules/next/dist/server/lib/generate-agent-files.js`), and it points at `node_modules/next/dist/docs/`. It must stay at `AGENTS.md`. Intentional overlap with [instructions/frontend.md](instructions/frontend.md) is a documented compatibility exception.

## Drift

After a material architecture or workflow change, run [playbooks/update-ai-context.md](playbooks/update-ai-context.md). Re-read every active document, classify keep/update/merge/split/remove, and close gaps with the same evidence gate.
