---
type: playbook
description: Re-audit and update `.ai/` after a material repository change.
---

# Update AI context

## Use when

Architecture, commands, theme tokens, auth, or deploy gates changed, or the user asked to maintain `.ai/`.

## Required context

[../AI.md](../AI.md), [../BASE.md](../BASE.md).

## Prerequisites

Working tree available. Do not edit application source merely to match new wording.

## Procedure

1. Read every active `.ai/` Markdown file.
2. Classify each keep / update / merge / split / remove with repository evidence.
3. Close gaps with the evidence gate. Do not add files to hit a count.
4. Verify named tokens, paths, and commands still exist.
5. Update [../SUMMARY.md](../SUMMARY.md) in the same change.

## Validation

Every internal link resolves. `SUMMARY.md` lists every other active file exactly once.

## Rollback

Restore the previous `.ai/` files from git.

## Definition of done

Catalog, routing, and documents match the current tree. No generic filler added.
