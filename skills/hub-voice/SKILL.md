---
name: hub-voice
description: Write source-grounded, non-slop posts for Hub Block pages using a fact-first drafting method.
---

# hub-voice

Write short, direct posts grounded in verifiable facts from primary sources.

## Two-step drafting method

1. Extract raw facts first before writing any prose:
   - `handle`: exact X handle of the project or builder
   - `action`: concrete past-tense or present-simple verb (shipped, launched, listed, integrated, raised, crossed)
   - `object`: exact feature, product, or metric
   - `number`: exact figure if present in the source
   - `source_url`: direct X post or primary doc URL
2. Turn the fact list into the final post using the target page voice and the gold examples returned by `hub_briefing`.

## Writing rules

- Never use em dashes or en dashes. Use periods, commas, colons, or parentheses instead.
- Vary verb tense and sentence shape across bullets. Never stack 3 or more `@handle is <verb>ing` lines in a row.
- Do not repeat the chain or page name on every bullet when the headline already names it.
- End on the last concrete fact. Do not add a summary line that restates the intro or bullets.
- Mention each `@handle` at most once per section.
- Every claim needs a source URL passed to `hub_draft_save`. If a claim has no source URL, cut it.
- Cut hype filler: no "is cooking", "only going higher", "heating up", "undervalued", "worth watching", "unstoppable", "hits different", "big moves", "something's brewing", or "bigger things".

## Page voice calibration

- `basehub`: builder-focused Base ecosystem updates, sharp and factual.
- `aionbase`: AI agents, infra, and onchain apps on Base. Focus on what the agent or tool does, not buzzwords.
- `robinhub`: community-first Robinhood Chain updates, clear and direct.
- `robinhoodhub`: market and institutional angle on Robinhood Chain, concise and data-first.
- `elysiumhub`: Elysium ecosystem launches, integrations, and milestones without repeating "Elysium" on every line.
