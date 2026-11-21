# hubos

Agent-first editorial operating layer for Hub Block pages on Cloudflare Workers + D1, powered by Bun, Hono, Effect v4, `tsgo`, and Biome.

Pages included out of the box:
- `basehub` (BaseHub)
- `aionbase` (AIonBase)
- `robinhub` (RobinHub)
- `robinhood_hub` (Robinhood Hub)
- `elysium_hub` (Elysium Hub)

`hubos` stays cleanly separated from `xeffect`. `xeffect` is the general-purpose X MCP; `hubos` calls it over MCP for Hub-specific signal collection (`doomscroll`), deterministic project picking with learning history (`picker`), writing validation (`vibe-check`), partner isolation (`partners`), and post metrics + gold-edit memory (`metrics`).

## Modules

- `src/index.ts` - Hono Worker router (`GET /`, `GET /health`, `POST /mcp`) + Cron handler
- `src/doomscroll.ts` - Effect v4 client for `xeffect` MCP with typed errors, transient 5xx retry, ship-event scoring, and cross-mention tracking
- `src/picker.ts` - Deterministic 100-point project picker with cooldowns, sibling-page angle notes, selection history, and replay mode
- `src/vibe-check.ts` - Structural and anti-slop draft checker (em dashes, banned hype phrases, progressive-tense chains, chain-name echo, empty closers, repeated handles, missing sources)
- `src/partners.ts` - Isolated partner CSV sync and active brief lookup
- `src/metrics.ts` - Post performance recording and gold-example edit diff storage
- `src/mcp.ts` - Fail-closed Bearer-authenticated MCP server at `POST /mcp`

## Skills (Zero Slop, Zero Em Dashes)

- `skills/hub-shift/SKILL.md` - Daily shift loop and approval batching
- `skills/hub-voice/SKILL.md` - Fact-first writing rules and `vibe-check` workflow
- `skills/hub-formats/SKILL.md` - Compact formats for recaps, spotlights, tier lists, roundups, and landscapes
- `skills/hub-partners/SKILL.md` - Sponsor and partner isolation rules

## Fast Local Development (Bun + tsgo + Biome)

```bash
bun install
bun run check     # tsgo --noEmit
bun run lint      # biome check .
bun test          # bun:test + in-memory bun:sqlite
bun run dry-run   # wrangler deploy --dry-run
```

## Cloudflare D1 & Secrets Setup

1. Create the D1 database and set its ID in `wrangler.toml`:
   ```bash
   bunx wrangler d1 create hubos-db
   bunx wrangler d1 migrations apply hubos-db --remote
   ```
2. Set Worker secrets:
   ```bash
   bunx wrangler secret put HUB_MCP_TOKEN
   bunx wrangler secret put XEFFECT_TOKEN
   # Optional:
   bunx wrangler secret put PARTNER_SHEET_CSV_URL
   bunx wrangler secret put NOTION_TOKEN
   ```
3. Set `XEFFECT_URL` in `wrangler.toml` to your deployed `xeffect` Worker `/mcp` endpoint.
4. Deploy:
   ```bash
   bun run deploy
   ```
