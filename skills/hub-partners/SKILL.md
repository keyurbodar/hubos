---
name: hub-partners
description: Manage sponsor deliverables and partner briefs separately from organic Hub Block editorial coverage.
---

# hub-partners

Keep paid and partner deliverables isolated from organic news so sponsor obligations never slip and never bleed into organic recaps.

## Workflow

1. Call `hub_partners(action="list", page_id=...)` at the start of every shift.
2. Check due dates and deliverable types for the current week.
3. To add or update a partner deliverable from chat or a synced tracker, call `hub_partners(action="upsert", partner={...})`.
4. Draft partner posts directly from the partner brief URL and verified partner posts, then run `hub_draft_save` with `series="partner"`.
5. Wait for explicit approval in chat before marking any partner deliverable published or updating Notion.

## Isolation rules

- Organic `picker_rank` never pulls from the `partners` table.
- Organic daily recaps never include a partner item unless the user explicitly asks to fold it in.
- Keep brief URLs and deliverable notes inside `partners` and never expose private tracker URLs in public post text.
