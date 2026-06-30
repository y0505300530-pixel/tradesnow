---
name: tradesnow-loops-build
description: >-
  TradeSnow LOOPS phase 2 — implement from approved spec with verification.
  Use after spec approval, LOOPS build, implement feature, or when user says
  build phase. Triggers on LOOPS build, implement, בנה, יישום.
---

# LOOPS — Build

Phase 2 of LOOPS. **Requires approved spec** (or explicit user waiver for tiny fixes).

Also apply: `verification-before-completion`, `executing-plans` (if plan exists).

## Preconditions

- Spec status APPROVED, **or** user explicitly waived spec for ≤1-file fix
- Know acceptance criteria from spec

## Build workflow

1. **Re-read spec** — AC list + constraints
2. **Minimal diff** — only files in scope; match project conventions
3. **Implement** — smallest change that satisfies AC
4. **Verify** — run gates below; capture output
5. **Handoff** — summarize files + evidence → ready for Review

## Verification gates (TradeSnow)

Run and paste results before claiming done:

```bash
cd /root/tradesnow
npm run build                    # must exit 0
npx vitest run <relevant tests>  # 0 failures on touched areas
```

| Area touched | Also run |
|--------------|----------|
| `server/engine/*`, `warEngine`, `liveOrderExecutor` | `npx vitest run server/adversarialQaV45.test.ts server/slCalculator.test.ts` |
| `tradeLedger`, `warReport` | `npx vitest run server/tradeLedger.test.ts` |
| `client/**` | `cd client && npm run build` |
| Live parity change | Re-read `tradesnow-live-parity` — owner ADR if parity shifts |

## Scope discipline

- No drive-by refactors
- No flip `elzaV45LiveEnabled` unless spec + owner explicitly says so
- No commit unless user asks

## Exit gate (Build → Review)

- [ ] Every AC addressed or noted deferred with reason
- [ ] Build exit 0 (evidence in message)
- [ ] Tests relevant to change: 0 failures (evidence)
- [ ] No `TODO` left for Critical path

## Output

```markdown
## LOOPS Build complete — [topic]

**Spec:** docs/superpowers/specs/...
**Files:** list
**Verification:** build ✅ | tests X/Y ✅
**Ready for:** LOOPS Review
```
