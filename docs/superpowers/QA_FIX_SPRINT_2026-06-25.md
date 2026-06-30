# QA Fix Sprint — 25 Jun 2026

**Orchestrator:** צ'אט ראשי — **אתה מדבר איתי, הצוות עובד ברקע**

## Sprint board

| ID | בעלות | סטטוס | סוכן |
|----|--------|--------|------|
| CR-01 | X | ✅ build + deploy + smoke 200 | Frontend |
| ST-01 | X | ✅ | Frontend |
| ST-02 | X | ✅ | Frontend |
| ST-03 | X | ✅ | Frontend |
| ST-04 | X | ✅ videoTitle null guard | Completion |
| HI-P4 | X | ✅ | Frontend |
| HI-A1 | X | ✅ | Frontend |
| HI-P2 | X | ✅ | Frontend |
| HI-P1 | X | ✅ | Frontend |
| HI-P3 | X | ✅ | Frontend |
| HI-P5 | X | ✅ footer unifiedTodayPct | Completion |
| CR-03 | C+X | ✅ code + deploy prod | Backend |
| HI-S3 | C+X | ✅ code + deploy prod | Backend |
| CR-07 | X | ✅ | Frontend |
| CR-02 | C | ✅ **SECURE: adminProcedure** | Completion |
| ME-01 | X | ✅ | Mobile |
| ME-02 | X | ✅ | Mobile |
| ME-03 | X | ✅ login nav suppress | Completion |
| ME-04 | X | ✅ quieter command hints | Completion |
| ME-08 | X | ✅ stepper labels | Frontend |
| UI-01..09 | X | ✅ wave 2 (B1-B9) | Completion |
| PF-01 | X | ✅ War Room 5s poll | Completion |
| PF-04 | X | ✅ H1H2 chart lazy | Completion |
| CR-04..08 | C | ⏳ | Claude droplet |
| PF-02..03 | X | ⏳ refactor גדול | — |

## Build & Tests

| Gate | סטטוס |
|------|--------|
| `npm run build` | ✅ (25 Jun, completion worker) |
| `npm test` | ✅ **299/299** |
| prod deploy wave 1 | ✅ (קודם) |
| prod redeploy wave 2 | ⏳ לא בוצע (ללא pm2 restart) |

## Gate

- [x] prod deploy wave 1 (`npm run build` + `pm2 restart tradesnow-app`)
- [x] prod `/trade` HTTP 200 (smoke)
- [x] Client wave 1 + wave 2 (feasible)
- [x] QA tests 100% (299/299)
- [x] CR-02 admin-only policy
- [ ] A6 market open E2E
- [ ] B10 merge

**דוח:** `docs/superpowers/QA_GREEN_REPORT_2026-06-25.md`
