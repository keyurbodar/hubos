---
name: hub-partners
description: Manage partner deliverables and partner briefs, and include active partners in normal Hub Block coverage.
---

# hub-partners

Track partner deliverables so obligations never slip. Active partners are covered like any other project in recaps, lists, series and other content.

## Workflow

1. Call `hub_partners(action="list", page_id=...)` at the start of every shift.
2. Check due dates and deliverable types for the current week.
3. To add or update a partner deliverable from chat or a synced tracker, call `hub_partners(action="upsert", partner={...})`.
4. Make partner-specific content (builder spotlight, dedicated posts) ONLY when the user requests it or a Notion task is assigned. Draft from the partner brief URL and verified partner posts, then run `hub_draft_save` with `series="partner"`.
5. Share the draft in chat and wait for explicit approval before updating Notion or marking anything published.

## Coverage rules

- Active partners stay in recaps, tier lists, series and any other content, same as before. `picker_rank` may include them.
- Inactive or blacklisted partners are banned from all content.
- No partner-specific posts unless requested or assigned.
- Keep brief URLs and deliverable notes inside `partners` and never expose private tracker URLs in public post text.
