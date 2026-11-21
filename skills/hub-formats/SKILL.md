---
name: hub-formats
description: Compact post templates for daily recaps, spotlights, tier lists, and landscapes across Hub Block pages.
---

# hub-formats

Match each series to its exact structure before running `vibe_check` and `hub_draft_save`.

## Daily recap

- Headline: `<Page Name> Daily Recap (<Month Day>)`
- Body: 4 to 7 bullets, one concrete update per bullet.
- Format per bullet: `- @handle <concrete verb> <what shipped or changed> (<metric if present>)`
- Vary verbs across bullets (launched, shipped, integrated, crossed, opened, listed, published).
- No closing summary sentence.

## Builder or project spotlight

- Hook: 1 sentence stating what `@handle` built and why it matters now, backed by a concrete metric or release.
- 3 to 4 short bullets covering what it does, traction or release details, and how it fits the ecosystem.
- Stop after the final bullet or a single direct link/handle line. No wrap-up sentence.

## Tier list or weekly roundup

- Run `picker_rank(page_id, series)` first and use the ranked candidates.
- Check `sibling_angle_note` when drafting for sibling pairs (`basehub` vs `aionbase`, `robinhub` vs `robinhoodhub`) so both pages do not ship the same angle.
- Group items clearly by tier or category with 1 short factual reason per project.

## Landscape map

- Group active projects by category (DeFi, Infra, AI, Consumer, Gaming).
- Keep descriptions to 3 to 6 words per project based on verified product facts.
- Verify every handle is active before including it.
