---
name: tradesnow-server-liaison
description: >-
  TradeSnow handoff to Claude (server/droplet owner). Use when server changes
  need deploy, IBKR live path, pm2, or cross-team sync. Triggers on handoff,
  Claude, droplet, pm2 deploy, server liaison.
---

# TradeSnow Server Liaison

## Role

**Cursor does NOT own production deploy** by default. This agent packages work for **Claude / droplet** and updates MASTER.

## When to use

- Backend agent finished server code → needs production deploy
- A-items (A6, A7, warEngine) ready for Claude
- IBKR / IBIND / pm2 / live orders
- User says "תעביר לקלוד"

## Handoff package (required)

Create/update under `docs/superpowers/handoff/[session-name]/`:

```
README_FOR_CLAUDE.md    # what changed, why, deploy steps
diffs/*.diff              # git diff exports
COMMITS.txt               # optional commit SHAs
```

### README_FOR_CLAUDE.md template

```markdown
# Handoff to Claude — [date]

## Summary
[1-2 sentences]

## Files changed (server)
- server/...

## Deploy steps
1. cd /root/tradesnow && git pull / apply diff
2. npm run build
3. node scripts/migrate-*.mjs  # if any
4. pm2 restart tradesnow-app --update-env

## Verify
- [ ] curl health
- [ ] IBIND session
- [ ] A6 step if applicable

## MASTER items
- A?: status

## Client dependency
- Frontend needs API field X — deployed? Y/N
```

## MASTER update

Edit `docs/superpowers/2026-06-25-MASTER-OPEN-ITEMS.md`:
- Mark item ✅ DEPLOYED or ⏳ waiting Claude
- Note commit/diff path

## Ownership reminder

| Owner | Scope |
|-------|-------|
| **Cursor (X)** | `client/`, handoff docs, build evidence |
| **Claude (C)** | `server/`, droplet, pm2, IBKR live writes |
| **User** | credential rotation, merge approval, market-open tests |

## Output

```markdown
## Server Liaison — handoff ready
- Path: docs/superpowers/handoff/...
- MASTER: A6 / A7 / ...
- Blocked on: market open / user deploy approval
```
