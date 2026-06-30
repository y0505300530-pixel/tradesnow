// Bump this version on every update/deployment
export const APP_VERSION = "v1.00";
// v1.00 (2026-06-13): Official Release — TradeSnow Powered by Elza
//   - Full rebranding: TS icon, Elza avatar, PWA splash screen
//   - Daily entry cap: max 10 entries/day, 20min inter-entry cooldown
//   - SL software-side (avoid IBKR 15-order limit)
//   - Live engine: liveOrderExecutor.ts for U16881054
//   - War Room LIVE dashboard
// v19.03 (2026-06-13): Live Engine + Branding + Commission Guards
//   - Elza Live Engine: liveOrderExecutor.ts with SL software-side, TP on IBKR
//   - War Room LIVE page + sidebar nav
//   - PWA icons updated (TS branding, 192/512/180px)
//   - SplashScreen: TS logo + "Powered by Elza" header
//   - Apple PWA meta fixed (was "Trade Manager" → "TS")
//   - Commission-aware entry guard: min $2,000 position, TP > 3× commission
//   - Daily max entries limit + 20min cooldown between trades
// v19.02 (2026-06-12): SL software-side migration (avoid IBKR 15-order limit)
//   - Stop-Loss moved from IBKR bracket to server-side Engine monitor
//   - Keep only TP orders on IBKR gateway
//   - Reduces order count per contract from 3 to 1
// v16.6.0 (2026-06-08): 14-Bug Fix Release
//   P0: OCA-pair atomic SL+TP (placeOcaPair staged, enforce rewrite pending live verification)
//   P0: Full Reset — 3s wait + double-tap kill switch before liquidation
//   P0: Ghost filter verified (fetchPaperPositions) + orphan_stuck SL/TP enforcement
//   P1: orphan_stuck positions now get SL/TP protection from enforce loop
//   P2: NEXT CYCLE timer shows HOLD when engine paused (red badge)
//   P2: Manual Sell Blacklist — visible in Blocked section with per-ticker release
//   P2: Cooldown reduced from 5min to 60s for faster Full Reset retries
// v16.5.1 (2026-06-07): TASE Market Hours Fix — correct schedule everywhere:
//   TASE: Mon-Thu 10:00-17:30, Fri 10:00-14:30, Sat+Sun closed
//   Fixed: marketHours.ts (isTaseOpen, isTasePreOpen)
//   Fixed: alertPoller.ts (checkPeriodicTaseAnalyzeTime — was sending alerts on Sat)
//   Fixed: priceStream.ts (local isTaseOpen — was Sun-Thu 09:59-17:25)
//   Fixed: marketData.ts (weekend detection — was Fri+Sat, now Sat+Sun)
//   Fixed: ibkrServerTickle.ts (isActiveHours — now includes Friday)
//   559 tests passing, 0 TypeScript errors.
// v16.5.0 (2026-06-05): Architectural Refactor — Pending State Machine:
//   Fix 1: pending_entry state + Fill Poller (no more premature DB close on LMT orders)
//   Fix 2: pending_exit state + Retry Logic (replaces static pending_exit_blacklist)
//   Fix 3: OrderGuard bypass — MAX_FAILS raised 1→3, decay cooldown 30→10min
//   Fix 4: DB Sync Grace Period — 6 consecutive misses (was 3) + 10min age check
//   New module: orderFillPoller.ts — polls /orders/{id} status for pending states
//   Schema: added exitRetryCount column to paperPositions
//   All status queries updated to include pending_entry/pending_exit where appropriate
//   559 tests passing, 0 TypeScript errors.
// v15.34 (2026-06-03): IBKR Full Transparency — Never Hide Data:
//   - Removed units !== 0 filter from fetchPaperPositions and getPositions (show ghost/0-unit positions)
//   - Frontend: ghost positions labeled with "👻 ghost (0 units)" tag
//   - Frontend: orphan_stuck positions labeled with "⚠️ orphan_stuck" tag
//   - Total Value row shows IBKR grossPositionValue when it differs from table sum (>$100 gap)
//   - Principle: NEVER filter or hide any IBKR data from the user
// v15.33 (2026-06-03): Telegram Broadcast Improvements:
//   - All signal types (Near Entry Watch, Gold Breakout, Retest, addSignal) now broadcast to ALL users
//   - SL/TP from catalog added to all Telegram messages (BUY, Watch, Breakout, Retest)
//   - Removed EMA-50 from Near Entry Watch and Retest messages
//   - Fixed Markdown→HTML formatting in breakoutScanner and masterKnowledge messages
//   - TP calculated as: entry + 2.5 × (entry - SL) from catalog data
// v15.32.3 (2026-06-03): Auto-decay + UI reset for SL/TP enforcement counters:
//   - Auto-decay: after 30min of no new failures, counters decay 1 point every 5min
//   - UI: enforcement status bar shows fail count, blocked tickers, last fail time
//   - UI: "Reset Counters" button to manually unblock all tickers instantly
//   - tRPC: getSlTpEnforcementStatus query + resetSlTpCounters mutation
//   - No more dependency on FULL RESET to recover from transient failures
// v15.32.2 (2026-06-03): Side-aware SL/TP guards (supports SHORT positions):
//   - Detect position side from IBKR units sign (negative = short)
//   - SL guard: LONG → SL must be below market; SHORT → SL must be above market
//   - TP guard: LONG → TP must be above market; SHORT → TP must be below market
//   - Order side: LONG → SELL; SHORT → BUY (to cover)
//   - Quantity always Math.abs() to handle negative short units
// v15.32.1 (2026-06-03): Fix SL/TP enforcement root causes (based on Claude analysis):
//   - Quantity sync: use IBKR position qty (not DB) — prevents "quantity > position" errors
//   - Poll-after-cancel: replaced fixed 2s sleep with polling loop (up to 10s) — confirms cancel before placing
//   - SL price guard strengthened: uses IBKR live mktPrice (not stale DB currentPrice)
//   - TP price guard added: TP must be ABOVE market price (prevents "trigger immediately" errors)
//   - Safety: skip SL/TP placement entirely if no live market price available
//   - Safety: skip SL/TP placement if ticker not found in IBKR positions (phantom DB entries)
// v15.32 (2026-06-03): Harden SL/TP enforcement to prevent order spam:
//   - Fail counter reduced from 3 to 1 (block ticker immediately after first failure)
//   - Global fail cap: 20 total failures → ALL enforcement stops until FULL RESET
//   - MAX_WORKING_ORDERS reduced from 200 to 20 (triggers cancel-all sooner)
//   - UI: SL/TP tabs now filter out inactive/cancelled/filled/rejected orders (show only active)
//   - FULL RESET clears both per-ticker and global fail counters
// v15.31 (2026-06-02): Show ALL orders from IBKR in SL/TP tabs (unfiltered) — now re-filtered in v15.32
// v15.30 (2026-06-02): Live IBKR Display — UI shows ALL positions from IBKR (no blacklist filter)
// v15.29.1 (2026-06-02): Fix FULL RESET timeout — use paperKillSwitch (cancel-all in 1 API call) instead of globalOrderCancel (one-by-one)
// v15.29 (2026-06-02): Unified FULL RESET — single button replaces KILL/LIQUIDATE/CONIDS/RESET/CLEAR HISTORY
//   Performs: Liquidate All + Kill Switch + DB Reset + CB Reset + Clear Blacklists + Clear History
//   Also clears: manual_sell_blacklist, pending_exit_blacklist, cooldown_until_map (persisted to DB)
// v15.28 (2026-06-02): Critical stability — OrphanCleanup recovery, 2.9% aggressive LMT, SL/TP dedup, Sector Heatmap fix
// v15.26 (2026-06-02): Fix ISR assets disappearing from Asset Catalogue
//   Sector filter was applied to ALL assets (USA+ISR). ISR assets have sector="Israeli"/"Custom"
//   so selecting any USA sector hid all ISR. Fix: ISR list now uses sortedAllAssets (unfiltered).
// v15.24 (2026-06-02): Favorites Table Redesign — professional compact layout
//   Ticker first (left), bold text-base font. Score badges with color coding.
//   Compact rows (py-2 px-3), zebra stripes, hover states, proper alignment.
//   max-w-5xl table, tabular-nums for numbers, sticky header.
// v15.23 (2026-06-02): Auto Ziv Engine Score on Asset Add
//   When user adds asset to catalogue, Ziv Engine runs automatically in background
//   Score is persisted to userAssets + passed to Catalogue Entry Alert
//   Alerts now pass ZIV Firewall immediately → users get Telegram notifications
// v15.22 (2026-06-02): Fix Today% Showing 0% in Pre-Market (H1)
//   Added updateH1Prices procedure to portfolio router — persists dailyChangePercent from IBKR quotes to DB
//   Added H1 persist effect in PortfolioDetail.tsx — writes non-zero changePercent to DB (throttled 5min)
//   Pre-market fallback now shows last session's Today% instead of 0%
// v15.21 (2026-06-02): IBKR Offline Cache + War Room Badge
//   In-memory cache for positions, account summary, and PnL — survives API failures
//   When IBKR API fails, returns last known data instead of empty/null
//   War Room shows "IBKR Offline" amber badge with last update time when data is stale (>2min)
//   getIbkrCacheAge() exported for monitoring cache freshness
// v15.20 (2026-06-02): Liquidate-All Race Condition Fix + Working Orders Alert
//   fullReset: 5s wait between liquidate and cancel-all (prevents cancelling in-flight orders)
//   Telegram alert when Working Orders > 30 (early warning before accumulation)
//   Alert resets when orders drop back below 20
// v15.19 (2026-06-01): Fix SL/TP Order Accumulation Bug
//   Global Guard: auto cancel-all if working orders > 200 (prevents runaway accumulation)
//   Hard Cap: if > 4 SL or TP orders on one ticker, cancel ALL and skip placement that cycle
//   Wait-after-cancel: 2s delay after cancelling before placing new order (propagation fix)
//   Propagation 502: no longer counted as "failed" — silently skips to next cycle
//   Orphan cleanup on close: cancelOrphanOrdersForTicker called when position closes
//   Manual close: also cancels orphan orders via cancelOrphanOrdersForTicker
// v15.18 (2026-06-01): TASE Completely Disabled from Paper Lab
//   Entry Guard: blocks all .TA/.TLV tickers from entering (both main + Donchian paths)
//   SL/TP Enforcement: skips all TASE positions
//   DB Sync: skips TASE orphan detection
//   UI: removed ISR allocation card, TASE sub-tab, ISR flags from positions
//   DB: closed all remaining open TASE positions
// v15.17 (2026-06-01): TASE Agorot Fix — real IBKR orders with ×100 price conversion
//   BUY: bracket order with entry/SL/TP ×100 (ILS→agorot) sent to IBKR
//   SELL: aggressive LMT exit price ×100 for TASE tickers
//   SL/TP Enforcement: no longer skips TASE — prices converted to agorot before placing
//   Leverage Guard: removed isTaseVirtual bypass — TASE positions count toward leverage
//   DB Cleanup: closed 4 stale virtual TASE positions (ARIN, TRX, LAHAV, OPCE)
//   TASE is no longer virtual — all positions are real IBKR Paper positions.
// v15.16 (2026-06-01): Fix TASE Paper Trading — MKT orders instead of bracket LMT
//   TASE bracket LMT orders never filled in IBKR Paper (no price data → Submitted forever).
//   Now: TASE entries use /orders/market + separate /orders/stop-loss + /orders/take-profit.
//   USA entries unchanged (bracket LMT works reliably).
//   Also: MAX_IBKR_LEVERAGE raised 1.9x→2.5x, MAX_OPEN_POSITIONS 15→25.
//   Frontend leverage cap warning updated to 2.5x.
// v15.15 (2026-06-01): Leverage Rules for Position Sizing
//   USA stocks & ETFs: 2:1 overnight leverage (Reg T Margin standard)
//   TASE stocks (.TA/.TLV): 1:1 (no margin on non-US exchanges)
//   Applied to: Auto-Entry Buyer, Momentum Chase, Manual Sniper (calcPositionSize)
//   effectiveEquity = realizedEquity × leverageMultiplier → used for allocation %
//   Leverage guard (1.9x cap) still enforced by IBKR API check in tryPaperEntry.
// v15.13 (2026-06-01): Fix IBKR watchlist sync — numeric ID + ST:"STK" field in rows (IBKR requirement)
// v15.12 (2026-06-01): Favorites auto-refresh on mount + fix IBKR symbol mapping + better logging
// v15.11 (2026-05-31): Favorites moved before Paper Lab in nav + click stock → Deep Analysis
// v15.10 (2026-05-31): Favorites sortable columns (click headers to sort A-Z / high-low)
// v15.09 (2026-05-31): Favorites Light Theme (white bg, black text)
//   Switched Favorites page from dark to light theme per user request.
//   White background, black text, gray-50 alternating rows, green/red for changes.
// v15.08 (2026-05-31): Favorites UI Redesign + IBKR Watchlist API Fix
//   Redesigned Favorites page to IBKR watchlist compact style (dark, 2 tabs USA/ISR).
//   Columns: INSTRUMENT, LAST, CHNG, CHG%, ZIV SCORE. Pos+PnL sub-rows for holdings.
//   Fixed IBKR watchlist API: timeout 5s→15s, id=string, rows=[{C:conid}], SC=USER_WATCHLIST.
// v15.07 (2026-05-31): Favorites Page + IBKR Watchlist Sync
//   New page /favorites: Hunter Dashboard with live IBKR quotes for all catalog assets.
//   Two sections: USA and TASE (Israeli) stocks, sortable by score/tier/price/daily%.
//   Refresh IBKR button: fetches live prices from IBKR (not Yahoo).
//   Sync to IBKR button: full rebuild of "Algo Master USA" + "Algo Master ISR" native watchlists.
//   Auto-sync hook: adding a new asset to catalog triggers watchlist rebuild (fire-and-forget).
//   Nav: Favorites (Star icon) added to Tools dropdown between Watchlist and Transfer Ledger.
//   14 vitest tests passing. TypeScript: 0 errors.
// v15.06 (2026-05-31): Fix TradingView chart v5 — use widgetembed URL (bypasses S3 AccessDenied)
// v15.05 (2026-05-31): Fix TradingView chart AccessDenied — switched to official widget script injection
// v15.04 (2026-05-31): Overview Sector Heatmap — 3 sections (H1, H2 USA, H2 TASE) below VIX/Fear&Greed
// v15.03 (2026-05-31): Fix Leverage Guard — 3-layer protection (current + projected + internal fallback)
// v15.02 (2026-05-31): Fix TradingView chart blank iframe
//   Switched from srcDoc iframe (origin=null, blocked) to direct URL embed via
//   s3.tradingview.com/external-embedding/embed-widget-advanced-chart.html — works on all browsers.
// v15.01 (2026-05-31): Catalog Hunter Dashboard + H1+H2 UI Diet + De-Cluttering
//   Catalog: Removed Notes + Company + Signal columns. Added Sector badge (TASE unified for .TA).
//   Added Quick Sector Filter (single-select + All), Distance to Entry %, dynamic currency (₪/$).
//   H1+H2: Removed Bar Chart, Donut Chart, ILS Header. Reordered: Vitals→Cards→Equity→Top/Bottom 5→Table.
//   War Room: Sector Heatmap, Sector column in POS, Add Ticker modal.
// v15.00 (2026-05-29): Comprehensive Stability + Observability + Analytics Phase 2
//   STABILITY: All in-memory state persisted to DB (cooldowns, pending_exit, sellRetryQueue, dailyBlacklist).
//   Await SL/TP cancel BEFORE sell (ghost order fix). sellRetryQueue survives restart.
//   ANALYTICS: MFE/MAE tracking (peak/trough per position), SPY price at entry, Sector lookup.
//   OBSERVABILITY: Global Pre-Flight log, Order State Machine (BUY/SELL lifecycle),
//   System Health Summary in sync (positions, orders, blacklists).
//   All 523 tests passing. TypeScript clean.
// v14.29 (2026-05-28): Conid resolution improvements, USD/ILS accuracy, WMB 0-qty fix.
// v13.00 (2026-05-17): Major Engine Audit — lean momentum-only architecture
//   Entry Matrix: 7 strategies killed (Cold, Recovery, Three-Day, Snap-Back, JTM, Override, Parking Lot).
//   Exit Matrix: Gann Date Rule deleted, Tight Exit Audit deleted, Profit Lock Ladder deleted.
//   Circuit Breaker: tightened from 20% to 15% drawdown threshold.
//   Kept: Extreme Momentum, Liquidity Override, Anti-Stop Hunt, Gap-Aware, Portfolio Heat, Idle Cash Overflow.
//   Slow Grind: already guarded by Extreme Momentum (no change needed).
//   Re-entry Watch & Snap-Back Watch: fully purged (zero memory overhead).
// v12.26 (2026-05-17): Entry Signal Matrix Refactoring — pure momentum focus
//   KILLED: Cold Strategy, Recovery Re-entry, Three-Day Rule, Snap-Back,
//   Join The Move, Breakout Override, Parking Lot (7 strategies removed).
//   KEPT: Gold Breakout (high/med), Gold Retest (high/med), Donchian (via Ziv),
//   Conviction Top-Up — 6 strategies only. All 11 Entry Guards untouched.
// v12.25 (2026-05-17): Hard Rollback to v12.20b + Event Loop Yield Fix
//   ROOT CAUSE: v12.21-v12.24 introduced checkpoint/resume, S3 Layer 2.5 cache,
//   and auto-reconnect logic that blocked the Event Loop, preventing SSE heartbeats
//   from firing. Cloud Run issued SIGTERM thinking the instance was dead.
//   FIX: Full rollback to v12.20b stable code + reduced Event Loop yield from
//   every 50 days to every 3 days to guarantee 15s heartbeat always fires.
// v20.62: Add atomic DB-level entry lock (paperEntryLock table) — UNIQUE(userId,ticker)
//   guarantees only one position per ticker regardless of concurrent instances.
//   Lock acquired before INSERT, released on position close. Existing 12 open positions
//   pre-populated in lock table.
// v20.61: Fix Paper Lab duplicate position bug — MP opened 3x due to concurrent AlertPoller
//   instances all reading DB before any write completes. Added DB-level guard: also check
//   paperPositions opened in last 5 min (not just paperTrades). Cleaned 2 duplicate MP rows.
// v20.60: Fix Paper Lab Available Cash negative bug — getVirtualStats now computes availableCash
//   from first principles (initialCapital - deployed + realizedPnl - commissions) instead of
//   the drift-prone ledger value. Math.max(0,...) guard added. DB corrected: -$4,046 → $30,040.
// v20.59: Fix Asset Catalogue virtual scroll bug — removed measureElement ref (caused row position miscalculation),
//   added fixed style={{ height: '44px' }} per row, overscan increased to 20. All rows now show correct asset after scroll.
// v20.58: Fix Price Cache Build All — replaced single blocking buildCache mutation with buildCacheBatch
//   (10 tickers per batch). Frontend now calls batches in a loop with real-time progress bar updates.
//   Added Cancel button to stop mid-run. TypeScript: 0 errors.
// v20.57: Performance batch + DB cache-first for Yahoo Finance + JSON parse fix for rate-limit errors + daily priceCache Heartbeat job.
// v20.56: Fix Deep Analysis: clear stale priceCache, fix ILA double-divide bug, normalize bars on save.
// v20.55: DB cache-first for fetchLivePrice (24h TTL) + fix staleLivePrice TS errors.
// v20.54: Yahoo Finance rate-limit fix — DB priceCache fallback (48h TTL) for fetchBarsForTicker.
// v20.53: Full performance batch: SWR cache (10 endpoints), DB connection pool (max 10), Brotli compression,
//   virtual scrolling (Asset Catalogue), prefetch on hover, HTTP/2 preload headers, Service Worker v2.
// v20.52: Performance fixes — 6 DB indexes, N+1→GROUP BY in getSessionHistory, Promise.all in getVirtualStats,
//   stale alert archival, Paper Lab refetchInterval 30s→60s, IBKR adaptive polling (30s/120s).
// v20.51: DB Reset — Sessions 20 and 21 billion-dollar trades moved to 60 days ago (out of yield windows).
//   Session 22 started fresh at $100K. pauseNewEntries(2min) called on every Reset Lab to prevent
//   stale-code entries. CORRUPTED_SESSIONS expanded to [19,20,21]. TypeScript: 0 errors. Tests: 342 passed.
// v20.50: Fix Session History corrupted badge for sessions 19-20 (isCorrupted flag, ⚠ Data Error badge, grayed rows).
//   Fix NEAR SL/TP mutual exclusion: NEAR TP badge hidden when NEAR SL or BELOW SL is active (SL takes priority).
//   TypeScript: 0 errors. Tests: 342 passed.
// v20.49: DB Reset — Session 19 billion-dollar positions cleared. All session 19 trades moved to
//   60 days ago (out of yield windows). Session 20 started fresh at $100K. BUG-C1 code verified
//   correct (positionSizeBase=INITIAL_CAPITAL). New positions confirmed at $5,000 each.
//   TypeScript: 0 errors. Tests: 342 passed.
// v20.48: QA Batch — BUG-C1: Position sizing fixed (INITIAL_CAPITAL×0.05, was currentEquity→$20B overflow), Reset Lab.
//   BUG-H3: Daily/Weekly/Monthly yield now filter by real time ranges (no more identical values).
//   BUG-H1: /trade-manager → /trade redirect added. BUG-H2: Force-Close text updated to ZIV Health v2.
//   PERF-1: IBKR cache TTL 15s→30s. UX-2: Skeleton loading rows in Overview (no more $0 flash).
//   UX-1: Splash already has 7s minimum (no change needed). TypeScript: 0 errors. Tests: 342 passed.
// v1.01: QA Batch — Asset Catalogue (Buy Price→Add Alert dialog, active alert checkmark, H2 badge, mobile card view),
//         Settings (Telegram Chat ID section for all users, Platform Selection flex-col mobile),
//         Security (2FA fail Telegram alert — already active in twoFactor.ts),
//         Splash redesign (logo, tagline, fade-in animation, 52px CTA button, gradient bg).
//         TypeScript: 0 errors. Tests: 342 passed.
// v1.00: Major release — Premium Design System + Mobile Responsive + Full Bug Fix Batch.
//   Design System: Inter font, tabular-nums, ds-card/ds-table/ds-badge/ds-metric classes, Light Theme only (dark mode disabled).
//   Mobile: Card View for wide tables, 44px touch targets, 2-col stat grids, horizontal scroll fallback.
//   Bug fixes: ILA÷100×ilsRate currency fix for .TA (portfolio/nightlyResync/priceAlerts), SL sanity check,
//     ZIV H off-hours update, /paper-lab redirect, capital bar text order, TP column, PAPER MODE gold badge,
//     Yield N/A, Risk Level, Session History, H1H2 title sync, bar chart H2, Deep Analysis buttons,
//     Pie Chart, Leverage Ratio Overview, SL/TP columns PortfolioDetail, Deep Analysis currency symbol (cs),
//     Price Alerts edit dialog + duplicate prevention, Health Score for all tickers, TradingView iframe embed.
//   TypeScript: 0 errors. Tests: 342 passed.
// v20.46: ZIV Health v2 — 4 Gemini improvements + TP multiplier fix.
//   1. Fade-in (25–35 min): smooth transition from Phase 1 (7.0) to Phase 2 live score.
//   2. ATR Catastrophic Stop in Phase 1: price < entry - 3×ATR14 → immediate Force-Close.
//   3. V-Shape Grace: 3-minute grace window before Force-Close (flash-crash protection).
//      graceStartTime managed in paperLabEngine.ts zivHGraceStart Map.
//   4. Beta Context: if SPY drops >1.5% from day open → FC threshold lowered 4.0→2.5.
//   5. TP multiplier fixed: slCalculator.ts RISK_REWARD 2.5→5.0 (all 3 dynamic usages updated).
//   Tests: 342 passed (slCalculator test updated to 5.0×).
// v20.45: ZIV Health Score v2 — 4-Phase Lifecycle Model.
//   Phase 1 (0–30 min): Entry Window — returns fixed score=7.0, no Force-Close.
//   Phase 2 (30min–4h): Confirmation — 3 binary checks (momentum, volume, EMA-20), FC if 2/3 fail.
//   Phase 3 (4h–3 days): Active Management — 5 weighted components: SL Distance (30%), Momentum (25%), Volume (20%), Market Context (15%), Time Efficiency (10%).
//   Phase 4 (>3 days): Trail Mode — only dead-capital detector (>7 days, P&L -0.5% to +0.5%), no score-based FC.
//   Removed: Profit Cushion (caused 100% FC at entry), Reallocation Signal -1.5, Near Peak +0.3, Score Degraded -0.5.
//   New tiers: Strong Hold ≥7.5, Stable ≥5.5, Watch ≥4.0, Weak <4.0 (FC only in Active phase).
//   All callers updated to pass minutesInTrade via ctx.
//   TypeScript: 0 errors. Tests: 342 passed.
// v20.44: Paper Lab 5-bug fix batch.
//   Bug 1: Total Equity formula changed to explicit: initialCapital + realizedPnl + openPnl (avoids availableCash drift).
//   Bug 3: Duplicate position guard now checks ALL open positions (any session) — prevents orphaned positions from being re-entered.
//   Bug 4: Daily/Weekly/Monthly yield now computed from closedAt trade P&L directly per window — no more shared snapshot baseline.
//   Bug 5: TP multiplier doubled from 2.5x to 5.0x risk — gives trades more room to run.
//   Bug 6: Position sizing already correct at 5% equity — no change needed.
//   TypeScript: 0 errors. Tests: 342 passed.
// v20.10: Trade Journal + Equity Inflation Fix.
//   1. Trade Journal tab in Paper Lab: full entry/exit log — ZivH at entry/exit, ATR14, initial SL/TP, R:R ratio, hold time (minutes), exit reason.
//   2. DB schema extended: paperTrades gains zivHAtEntry, zivHAtExit, atr14AtEntry, initialSl, initialTp, finalSl, finalTp, rrRatio, holdTimeMinutes, equityAtEntry.
//   3. Engine fix: race condition (tsx watch multiple restarts) resolved with DB-level 5-min recent-entry guard + process singleton + cycle mutex.
//   4. Detailed cash-flow logs: CYCLE START/AFTER EXITS equity snapshots for debugging.
//   TypeScript: 0 errors.
// v17.00: Major bug-fix release.
//   1. Price Alerts loading speed: two-phase load — getAll=DB only (instant <100ms), getLivePrices=parallel Yahoo Finance (no sequential 300ms delays).
//   2. Israeli stocks (.TA) price conversion fix: Yahoo Finance returns prices in agorot (×100 of ILS).
//      analyzeAssetList now normalizes .TA bars ÷100÷USD/ILS before ZIV Engine.
//      loadAlertsFromCatalogue now converts .TA recommendedBuyPrice from agorot to USD.
//      104 stale/wrong .TA alerts deleted from DB (all with target > $500).
//   3. SELL button in Deep Analysis: DeepAnalysisPage now loads portfolio.getState and passes holdingContext+conid when ticker is held in Holding 1.
//   4. Buy Opportunities redesigned as sortable table: Ticker | Signal | ZIV | Label | Alert Time | Target $ | Now $ | Potential % | Actions.
//      Sort by any column, default ZIV descending.
//   5. BUY/SELL signal badge: added SignalBadge to all three alert sections (SL=SELL red, TP=SELL red, Buy Opp=BUY green).
//   6. Dark theme forced: ThemeProvider was defaulting to light mode causing white-on-white text. Now always applies .dark class.
//   TypeScript: 0 real errors (known pre-existing RootLayout tsserver cache error is non-issue).
// v16.80: Historical Price Cache Builder.
//   New tRPC router: priceCache — buildCache (bulk pre-download all watchlist tickers), getStatus, getSummary, exportCsv, refreshTicker.
//   fetchBarsForTicker in marketData.ts now checks DB priceCache first (if fresh <24h and >100 rows) before hitting Yahoo Finance.
//   New page /price-cache: status table per ticker (rows, date range, stale badge), Build All button with progress bar, per-ticker refresh, Export CSV.
//   GlobalNav: Price Cache (Database icon) added to Knowledge dropdown (desktop + mobile).
//   Nightly 2am scheduled task: auto-rebuilds stale cache entries.
//   TypeScript: 0 errors.
// v16.79: Money Transfer Ledger — track deposits/withdrawals for TWR performance normalization.
//   New DB table: moneyTransfers (userId, timestamp, type DEPOSIT/WITHDRAWAL, amount, balanceBefore, balanceAfter, source, notes).
//   New tRPC router: moneyTransfers — list, add, delete, monthlySummary, twrCurve, detectFromIbkr.
//   New page /money-transfers: summary stat cards, monthly bar chart (inflows vs outflows), TWR Clean Growth line chart, transfers table.
//   Add Transfer modal: type, amount, date, balance before/after, notes.
//   Sync IBKR button: calls detectFromIbkr to pull IBKR ledger cash flows.
//   GlobalNav: Transfer Ledger added to Knowledge dropdown (desktop + mobile).
//   TypeScript: 0 real errors (stale tsserver RootLayout cache error is a known non-issue).
// v16.78: IBKR prices for Holding 1/2/Overview/Fast Overview.
//   Added fetchIbkrLivePricesBatch() in marketData.ts — calls IBIND POST /quotes directly.
//   getLivePrices and refreshPrices procedures (portfolio router) now use IBKR exclusively.
//   Yahoo Finance kept ONLY for Ziv Engine, Deep Analysis, Asset Catalogue.
//   TypeScript: 0 errors.
// v16.77: Trading Paper Lab — full R-based execution engine.
//   New page /trading-lab with PAPER MODE banner, account stats, portfolio table, execution terminal.
//   executeSniper: R-based sizing (portfolioEquity × riskPct / riskPerShare), NOT fixed $5k.
//   SL: ATR-14 × 2.0 (hard cap 20%) — same as tradingLab.ts v1.130. Fallback: EMA-50 × 0.97.
//   TP: 2.5R from entry.
//   Exposure guards: MAX_OPEN_POSITIONS=8, MAX_DEPLOYED_FRAC=75%, MAX_SINGLE_POSITION_FRAC=20%.
//   Ticker dedup: blocks re-entry if ticker already open in paper account.
//   sizePosition procedure: preview units/amount before execution (live from paper account).
//   LabExecutionModal: Risk Level slider (1-10), dynamic units, risk budget, tier cap, exposure meters.
//   Double-confirmation: full trade parameters shown before final execute.
//   Paper Lab nav item added to Knowledge dropdown in GlobalNav.
//   PAPER_API_BASE_URL secret added (https://tradesnow.vip/paper-api).
//   TypeScript: 0 errors.
// v16.76: Auto-connect IBIND on PortfolioOverview open/return.
//   On mount: checks health → if inactive, calls /session/start → polls every 1s until active.
//   On visibilitychange (tab/app return): re-triggers auto-connect if not already connected.
//   Retry: on failure, retries every 10s automatically.
//   Indicator: amber spinner (checking/connecting), green pulsing dot (connected), WifiOff + retry button (error).
//   TypeScript: 0 errors.
// v16.75: Fix GOOG duplicate + prevent future duplicates.
//   DB fix: GOOG id=660002 corrected to 110 units @ $364.42 (matches IBKR Holding 1 exactly).
//   All other 9 holdings verified against IBKR screenshot (AMD/DVN/HAL/INTC/LUNR/MU/STX/TSM/WMB — all correct).
//   addHolding: auto-merge logic already in place (weighted avg + sum units on duplicate ticker).
//   Schema: portfolioHoldings (userId, ticker) index upgraded from index to uniqueIndex.
//   DB: unique constraint applied live via ALTER TABLE.
//   UI: Removed Dedup Holdings button from TradeManager (no longer needed).
//   TypeScript: 0 errors.
// v16.74: Fix Dedup Holdings for non-admin users.
//   dedupHoldings changed from adminProcedure to protectedProcedure.
//   Dedup Holdings button now visible to all authenticated users (not just admin).
//   TypeScript: 0 errors.
// v16.73: Fix duplicate holdings in PortfolioOverview.
//   Root cause: addPortfolioHolding had no duplicate check, so same ticker could be inserted twice.
//   Fix: Added dedupHoldings adminProcedure that merges duplicate tickers (weighted avg buy price + sum units).
//   Added Dedup Holdings button (red) in TradeManager admin toolbar.
//   PortfolioOverview: h1Holdings memo now deduplicates by ticker before passing to useLivePrices.
//   TypeScript: 0 errors.
// v16.71: Fix conid lookup for DVN/HAL (stocks not in current IBKR positions).
//   Root cause: Sync conid button only searched live IBKR positions — if stock not held, conid was not found.
//   Fix: Added ibkr.resolveConid tRPC procedure that calls IBIND /trsrv/stocks and caches result in ibkrConidCache.
//   Sync conid button now falls back to contract search when not found in positions.
//   TypeScript: 0 errors.
// v16.69: Fix Telegram for local users.
//   Root cause: admin saved telegramChatId to localUsers table, but alertPoller reads from userSettings table.
//   Fix: localUsers.update now syncs telegramChatId to userSettings (via upsertUserSettings) for the linked user.
//   Added adminSendTestToUser procedure: admin can send test Telegram to any chatId.
//   Added green Send button in Settings → User Management next to each user with a chat ID.
//   TypeScript: 0 errors.
// v16.68: Load Alerts button in Asset Catalogue.
//   New backend procedure priceAlerts.loadAlertsFromCatalogue:
//     Scans all catalogue assets with ZIV ≥ 8, creates a custom BUY alert for each
//     that doesn't already have an active alert. Target = recommendedBuyPrice (EMA-50).
//   Orange "Reload Alerts" button added to Asset Catalogue toolbar.
//   TypeScript: 0 errors.
// v16.67: Deep Analysis → Standalone Page.
//   All DeepAnalysisModal usages replaced with navigate('/deep-analysis/:ticker').
//   DeepAnalysisPage renders modal in pageMode (no overlay, normal scroll).
//   X button calls window.history.back() to return to previous page.
//   Admin: Copy Catalogue to User — adminCopyCatalogueToUser procedure + UI in AssetCatalogue.
//   TypeScript: 0 errors.
// v16.66: Admin Refresh All Users' Catalogue ZIV Scores.
//   New adminRefreshAllCatalogueScores procedure: fetches bars for all unique tickers across all users,
//   computes ZIV score for each, updates every user-asset row in DB.
//   Purple "Refresh All Users" button in Asset Catalogue toolbar (admin-only, hidden from regular users).
//   TypeScript: 0 errors.
// v16.65: Telegram alert fixes.
//   1. Anti-duplicate: set lastAlertSentAt on ALL trigger paths (checkAlerts, slCheckScheduled, alertPoller)
//      so the 24h anti-spam dedup prevents double-sending when multiple code paths fire for the same alert.
//   2. New message format: headline = "BUY Alert" / "SL Alert" / "TP Alert" (not "Custom Alert Alert").
//      Alert line shows BUY/SL/TP @ $price. Ziv Score embedded in message body.
//   TypeScript: 0 errors.
// v16.64: UI readability fixes.
//   1. Global: muted-foreground CSS var raised from 0.52 to 0.70 lightness — all grey labels now clearly visible on black bg.
//   2. Holdings bar (HoldingsSection): removed light slate/blue gradient from CardHeader and summary footer; now uses bg-zinc-900 (dark).
//   3. Triggered Alerts: zivScore fallback — if trigger-time score is NULL, shows current catalogue score instead of 'No Score'.
//   TypeScript: 0 errors.
// v16.63: Price Alerts UX improvements.
//   1. Clean backgrounds: SL/TP/BUY/Archive cards now use bg-card (black) instead of tinted red/green/amber.
//   2. Ticker clickable: all ticker names (Active + Triggered + Archive) use TickerLink — click opens Deep Analysis.
//   3. Triggered Alerts: shows Catalogue Ziv Score (current entry score from userAssets) below trigger-time score.
//      Backend: getTriggered procedure enriched with catalogueZivScore from userAssets JOIN.
//   TypeScript: 0 errors.
// v16.62: Fix PortfolioDetail key collision for same-ticker multi-position rows.
//   Root cause: key={row.ticker} caused React key collision when a user holds 2 positions
//   of the same ticker (e.g. NXSN.TA at different buy prices) — React reused DOM nodes
//   causing visual duplication/corruption when sorting.
//   Fix: Added id: number to HoldingDetailRow interface; propagated DB row id in h1Holdings
//   and h2Holdings useMemo maps; changed render loop to key={row.id}.
//   TypeScript: 0 errors.
// v16.61: Fix H2 duplicate rows when sorting with multiple positions of same ticker.
//   Root cause 1: h2Tickers passed duplicate tickers to Yahoo getLivePrices — fixed with Array.from(new Set(...)).
//   Root cause 2: h2SortedData sort was unstable for equal values (same live price for same ticker) —
//     added id-based tiebreaker so React never sees key-order changes on equal rows.
//   TypeScript: 0 errors.
// v16.60: ILS Summary Box added below All Accounts in PortfolioOverview.
//   Shows total portfolio value in ₪ and daily change in ₪.
//   Live USD/ILS rate fetched from Yahoo Finance (cached 1h, fallback 3.65).
//   New tRPC procedure: forex.getRate (publicProcedure, 1h TTL).
//   TypeScript: 0 errors.
// v16.52: Black/gold/white theme for PortfolioOverview. TradeSnow branding in all page headers. Fixed footer column alignment (fixed-width grid).
// v16.51: Rename PortfolioOverview footer label from "Unrealized" to "All Accounts".
// v16.50: Fix PortfolioOverview footer cutoff on mobile — increased bottom padding from h-8 to h-28 so footer clears the floating GlobalNav bottom bar.
// v16.49: Redirect / to /overview for logged-in users. IBIND active hours Mon-Thu 08:00-23:30 (isActiveHours guard).
// v16.48: Portfolio Overview page — mobile-first IBKR-style overview at /overview.
//   Rows: Holding 1, H2 TASE, H2 USA, H2 Crypto, Cash.
//   Columns: Name + count | Value/Cost | Today $ | Total % + $.
//   Footer: Unrealized total (sum of all rows).
//   Added to GlobalNav mobile menu as first item.
//   TypeScript: 0 errors.
// v16.38: Fix site stuck on "בודק חיבור ל-IBKR..." when IBKR/IBIND is offline.
//   Root cause: fetch("/api/ibind/health") had no timeout — when IBIND bridge was down,
//   the request hung for up to 35s (server-side ibindRequest timeout), causing
//   ibindSessionChecked to stay false forever and the UI to show the spinner indefinitely.
//   Fix 1 (client): Added 5-second AbortController timeout to the health check fetch in
//     useIbkrSync.ts — if the request times out or errors, ibindSessionChecked is set to
//     true immediately and the UI proceeds as "disconnected".
//   Fix 2 (server): Added 4-second server-side timeout to /api/ibind/health endpoint —
//     returns 502 immediately instead of waiting 35s for the IBIND bridge.
//   Result: site loads within ≤5 seconds regardless of IBKR/IBIND status.
//   TypeScript: 0 errors.
// v16.37: Fix H2 Today $ column showing — for crypto tickers (ETH-USD, BTC-USD, XRP-USD).
//   Root cause: h2LivePriceMap was built ONLY from ibkrH2Map. Crypto tickers are not in IBKR,
//   so liveData was undefined → dailyChange null → Today $ showed —.
//   Fix 1: h2LivePriceMap now seeds from DB-cached Yahoo values (currentPrice, prevClose,
//     dailyChangePercent) for ALL H2 tickers first, then overrides with IBKR when connected.
//   Fix 2: refreshPrices now uses live.prevClose (from Yahoo daily bars) directly instead of
//     re-deriving it as price - change.
//   Result: crypto Today $ = (currentPrice - prevClose) × units from DB cache.
//   TypeScript: 0 errors.
// v16.36: Fix H1/H2 $ TODAY empty + TODAY P&L card wrong value.
//   Bug 1 (H1 $ TODAY): HoldingsSection todayPnl now uses fallback change = price - prevClose
//     when holdingLivePriceMap.change is null (Gateway didn't return change field).
//   Bug 2 (H2 $ TODAY): TradeManager H2 row rendering now uses same fallback pattern.
//     Sort function also updated with same fallback.
//   Bug 3 (TODAY P&L card): ssotTodayPnl now ONLY uses portfolioMetrics.h1TodayPnl (sum-of-rows).
//     todayPnlIbkr (/pnl endpoint) is no longer used as fallback — it includes realized P&L
//     from closed positions, causing divergence from per-row $ TODAY column.
//   Bug 5 (H2 toast): Already removed in v16.35 (h2RefreshMut.onSuccess has no toast).
//   TypeScript: 0 errors.
// v16.35: Deep Analysis fixes + SSOT enforcement.
//   1. Auto-scroll fix: removed all autoFocus from modal inputs; added scroll-to-top on open/ticker change.
//   2. currentPrice SSOT: holdingsWithLiveBase now uses ibkrPositionMap.mktPrice (real-time) as
//      primary source for currentPrice, not snapshot price (which could return stale midPrice).
//   3. P&L math: pnlPct = (mktPrice - buyPrice) / buyPrice — correct total P&L, not daily change.
//   4. Global audit: no rogue (current-prev)/prev calculations found in client/src.
//   TypeScript: 0 errors.
//   3. Frontend lobotomy: TradeManager, usePortfolioMetrics, CapitalSummaryCards no longer
//      recalculate daily change — they render backend values directly.
//   4. TODAY P&L card = Σ (mktPrice - prevClose) × units (sum of rows), always.
//   TypeScript: 0 errors.
// v16.32: Fix H1 % TODAY and $ TODAY to match IBKR App exactly.
//   Root cause: holdingLivePriceMap was using pre_market_price (after-hours bar, 5-min lag)
//   for change/changePercent. The IBKR App uses /positions mktPrice (real-time, sub-second).
//   Fix: holdingLivePriceMap now uses ibkrPositionMap[ticker].mktPrice as currentPrice
//   (falling back to snapshot price when no position). change = mktPrice - prevClose;
//   changePercent = change / prevClose × 100. Matches IBKR App CHG% exactly.
//   TypeScript: 0 errors.
// v16.31: Fix H2 Today $ column — was showing — (null) because IBKR returns null change when market closed.
//   h2LivePriceMap now derives change = price - prevClose when change is null.
//   changePercent derived similarly. QLTU.TA $201.29 confirmed correct (740 ILS / 3.68 = $201).
//   TypeScript: 0 errors.
// v16.30: PM badge + Today $ column in H1 table + H2 sort fix (useReducer).
//   1. H2 sort: replaced dual useState with single useReducer for atomic col+dir updates.
//      Root cause: nested setState calls caused race conditions (stale closure).
//   2. PM badge: isClosingPrice field added to IbkrPriceEntry + holdingLivePriceMap.
//      HoldingRow shows purple 'PM' badge when isClosingPrice=true (market closed).
//   3. Today $ column added to H1 table: change × units from holdingLivePriceMap.
//      Shown in green/red with sign. Sortable via HoldingsSection columns.
//   TypeScript: 0 errors.
// v16.29: Fix Today P&L and % Today to match IBKR App in pre-market hours.
//   1. holdingsWithLiveBase: currentPrice + dailyChangePercent now use holdingLivePriceMap
//      (pre_market_price/changePercent from IBKR snapshot) instead of DB cache when IBKR connected.
//   2. usePortfolioMetrics: h1TodayPnlFinal uses pre-market prevClose-based calc when
//      ibkr.dailyPnl === 0 (pre-market, market not yet open).
//   TypeScript: 0 errors.
// v16.28: Add Today $ column to H2 table in TradeManager.
//   todayPnl = liveData.change × units (USD). Sortable via handleH2Sort.
//   TypeScript: 0 errors.
// v16.27: Bug Fix Sprint
//   1. Pre-market prices: getIbkrQuotes normalise() now uses IBIND pre_market_price
//      (from /history outsideRth=true) as effective price when is_closing_price=true.
//      getMarketSnapshot (H1) also requests bid(84)/ask(86) fields as fallback.
//   2. Today P&L card sign fix: pnlSign() in CapitalSummaryCards now returns '-' for negatives.
//   3. Top 5 Gainers / Losers: fmtPnlUsd() added (shows sign), fmtUsd() kept for value cells.
//   4. H2 sort fix: handleH2Sort rewritten with flat setState calls (no nested updaters).
//      h2SortedData deps include h2LivePriceMap so sort re-runs on price updates.
//   TypeScript: 0 errors.
// v16.26: Fix H2 sort — h2SortedData now uses h2LivePriceMap (live prices) as SSOT,
//         matching the values actually displayed in the table. Added h2LivePriceMap
//         and zivHMapH2 to useMemo deps so sort re-runs on price updates.
//         TypeScript: 0 errors.
// v16.25: SSOT Refactor — created usePortfolioAnalytics (centralized data+math hub).
//         H1H2Dashboard now consumes usePortfolioAnalytics exclusively — zero local .reduce().
//         Total Value, Today P&L, H2 Value are IDENTICAL to TradeManager down to the cent.
//         usePortfolioMetrics remains the math SSOT; usePortfolioAnalytics wraps all data fetching.
//         TypeScript: 0 errors.
// v16.23: ILS Double-Division Fix — getIbkrQuotes normalise() was dividing by 100×ilsRate
//         (assumed agorot). IBIND already returns ILS, so divisor corrected to ilsRate only.
//         TypeScript: 0 errors.
// v16.13: P&L Synchronization Fix — all 3 Today P&L locations now show identical values.
//         Root cause: HoldingsSection was NOT receiving ibkrTodayPnl/portfolioMetrics props,
//         and computed its own Yahoo-based P&L independently.
//         Fix: (1) Pass ibkrTodayPnl + portfolioMetrics to HoldingsSection.
//              (2) HoldingsSection H1 Summary Cards TODAY P&L now uses ssotTodayPnl (IBKR /pnl).
//              (3) Summary bar שינוי יומי $ now uses ssotTodayPnl (not weightedDailyPct×value).
//              (4) weightedDailyPct % derived from ssotTodayPnl/totalValue when IBKR connected.
//              (5) H2 summary bar + cards use portfolioMetrics.h2TodayPnl as SSOT.
//         Result: CapitalSummaryCards, HoldingsSection cards, and summary bar all show same value.
//         TypeScript: 0 errors.
// v16.12: Fix H2 table: rows now use livePrice and liveDailyChangePct from h2LivePriceMap
//         instead of stale DB values. currentPrice, dailyChangePercent, pnlTotal, pnlPct,
//         holdingValue all now reflect real-time Yahoo Finance data.
// v16.11: Revert v16.10 TASE prevClose fix. Yahoo regularMarketPrice IS live for TASE (not yesterday).
//         prevSessionClose is the correct prevClose baseline. changePercent = (livePrice - prevSessionClose) / prevSessionClose.
// v16.10: Fix TASE (.TA) Today P&L: prevClose now uses regularClose (yesterday) not prevSessionClose (day before).
//         During TASE trading hours, Yahoo regularMarketPrice = yesterday's close, extendedPrice = live.
//         Result: correct daily change% and Today P&L for all .TA stocks.
// v16.09: Fix .TA stock daily change% — Yahoo does not return regularMarketChange for TASE.
//         Now falls back to bars-based calculation: (currentPrice - prevSessionClose) / prevSessionClose.
//         QLTU.TA, NXSN.TA, TSEM.TA etc. will now show correct negative/positive daily change.
//         TypeScript: 0 errors.
// v16.08: % P&L shows 'N/A' (not 9999%) when buyPrice < $1 — both H1 and H2 tables.
//         TypeScript: 0 errors.
// v16.07: % P&L fix extended to H2 table (TradeManager.tsx) — same ±9999% cap.
//         Yahoo Finance rate-limit fix: safeJson now reads as text first,
//         rejects non-JSON responses gracefully. trade.ts + routers.ts updated.
//         TypeScript: 0 errors.
// v16.06: % P&L display fix for holdings with very low buy prices.
//         HoldingRow: pnlPct capped at ±9999% — prevents 100,000%+ distortion
//         when buyPrice is e.g. $0.10. $ P&L (always accurate) shown first,
//         % shown below with '*' tooltip showing actual value.
//         TypeScript: 0 errors.
// v16.05: IBKR /pnl endpoint integration — Today's P&L now comes from dedicated IBKR endpoint.
//         New GET /pnl passthrough in ibkrProxy.ts.
//         New ibkr.getPnl tRPC procedure: calls /pnl, returns daily_pnl, unrealized_pnl,
//         net_liquidation, market_value, excess_liquidity. Persists to DB (fire-and-forget).
//         useIbkrSync: ibkrPnlData query (30s polling when connected, staleTime 25s).
//         TradeManager: ibkrTodayPnl = ibkrPnlData.dailyPnl ?? summary.dailyPnl ?? DB cache.
//         CapitalSummaryCards: Today P&L sub-label shows 'IBKR live' when /pnl returns value.
//         TypeScript: 0 errors.
// v16.04: TODAY P&L null fix — when IBKR connected but dailyPnl not returned,
//         show "—" instead of wrong Yahoo-based calculation ($12k bug).
//         usePortfolioMetrics returns null for h1TodayPnl/h2TodayPnl/unifiedTodayPnl
//         when IBKR is live but dailyPnl unavailable. CapitalSummaryCards handles null.
//         TypeScript: 0 errors.
// v16.03: SSOT Math Sync Sprint — usePortfolioMetrics.ts centralized hook.
//         All portfolio math (H1/H2/Unified value, todayPnl, totalPnl) now flows through
//         a single memoized hook. Unified Value = H1 NLV + H2 TotalValue everywhere.
//         prevClose added to useLivePrices map. H1H2Dashboard todayPnl formula fixed.
//         CapitalSummaryCards + HoldingsSection + TradeManager all consume SSOT.
//         TypeScript: 0 errors.
// v16.02: H1 summary cards grid (שווי תיק, TODAY P&L, P&L כולל, מניות) — identical to H2.
//         TypeScript: 0 errors.
// v16.01: H2 inline summary bar — identical to H1 (N פוזיציות | שווי תיק | שינוי יומי %+$ | P&L כולל %+$).
//         Version badge enlarged (13px bold, glow border).
//         TypeScript: 0 errors.
// v16.00: Open Items Sprint — Today P&L fixed (prevClose-based, matches IBKR exactly in pre/post market),
//         GAON-M.TA ticker fixed in DB, QLTU/NXSN buy prices verified correct,
//         SSE stream confirmed for all tabs (H1+H2+Catalogue every 60s during market hours),
//         H2 Deep Analysis position management mode confirmed (HOLD/ADD/EXIT/REDUCE),
//         duplicate setInterval removed (SSE is primary, polling only when tab hidden).
//         TypeScript: 0 errors.
// v14.98: TradeManager.tsx Step 5 refactor fixed — 83 TypeScript errors resolved.
//         - Restored all missing variables: holdings, account, catalogueData, holdingLivePriceMap,
//           isMarketOpen, holdingsLastScanned, handleAnalyze, handleAnalyzeHoldings, replacementsMut,
//           dailyReviewMut, bracketOrderTarget, ibkrOrderTarget, buyTarget, editTarget,
//           backfillBuyScoreMut, cancelOrderMut.
//         - Fixed setIbindSessionActive/setIbindClosedReason/setIbindClosedAt calls in Session Gate
//           handlers (now uses setIbkrStatus only — internal hook state not exposed).
//         - useIbkrSync hook cleanly integrated: all IBKR state comes from hook.
//         TypeScript: 0 errors.
// v14.97: ZIV H Score engine, Asset Catalogue signals, Deep Analysis history, TelegramMonitor RSS.
//         - ZIV H Score: 6 health indicators + Module A (Over-Exposure -2.0, Dead Capital -1.0)
//           + Module B (Reallocation Signal -1.5, Underperformance -1.0).
//           New column in Holdings (H1) and Holding 2 tables with color-coded tier badges.
//           Deep Analysis: ZIV H Health section shown when user holds the stock.
//         - Asset Catalogue: ✓ checkmark column for active signals; clicking Buy Price opens Add Signal dialog.
//         - Deep Analysis: last 25 searches stored in localStorage, displayed as amber chips.
//         - TelegramMonitor: RSS tab (5 sources, 5-min refresh) + Telegram tab.
//         - Telegram bot: removed /holdings and /alerts from menu.
//         - IBKR session expired: no longer sends Telegram notification (silent log only).
//         TypeScript: 0 errors.
// v14.83: User isolation — all pages accessible to all authenticated users.
//         - /ibkr-account route: RequireAdmin (redirects non-admin to home).
//         - IBKR server procedures (ibkr.ts): adminProcedure only — non-admin gets 403.
//         - All other pages (Trade Manager, Settings, Alerts, etc.): RequireVerified (all users).
//         - Regular users: empty holdings, add manually, prices via Yahoo Finance.
//         - SYNC NOW FROM IBKR button hidden for non-admin users.
//         TypeScript: 0 errors.
// v14.80: Multi-user improvements — Telegram Chat ID per user, OAuth redirects fixed.
//         - All unauthenticated redirects now go to /login (not Manus OAuth).
//         - telegramChatId column added to localUsers table.
//         - User Management panel: TG button per user for inline Telegram Chat ID editing.
//         - localUsers router: telegramChatId exposed in list/update mutations.
//         - Settings.tsx: removed unused getLoginUrl import.
//         TypeScript: 0 errors.
// v14.36: Add Alert workflow in Deep Analysis Modal.
//         - Click 'הוסף איתות': copies JSON payload to clipboard, opens TradingView chart in new tab,
//           shows sticky bottom banner with step-by-step TV alert instructions.
//         - Banner: buy price displayed in huge font (5xl), 2 numbered steps,
//           'Copy JSON again' button, dismiss button.
//         TypeScript: 0 errors.
// v14.35: GlobalNav reorganization.
//         - Desktop: Settings is now a dropdown (General Settings, IBKR Account, TradingView, System Logs).
//         - Desktop: Trading Lab moved under Knowledge dropdown.
//         - Mobile: Trading Lab under Knowledge section; Settings section shows all 4 sub-items.
//         TypeScript: 0 errors.
// v14.34: Deep Analysis standalone page + ticker autocomplete + GOOG/GOOGL alias fix.
//         - /dip-analysis page rewritten: uses DeepAnalysisModal inline (no old custom UI).
//           Ticker autocomplete via Yahoo Finance search (debounced 300ms, top results dropdown).
//           Quick-pick buttons: NVDA, AAPL, MSFT, TSLA, AMZN, META, GOOG, PLTR.
//           Supports ?ticker=NVDA query param (PWA shortcut / external link).
//         - AssetCatalogue: GOOG <-> GOOGL aliasing in holdingTickers (same company, 2 share classes).
//           Also BRK.B <-> BRK/B aliasing.
//         - DB: deleted 21 manual holdings (user requested clean slate, IBKR sync will repopulate).
//         TypeScript: 0 errors.
// v14.33: Deep Analysis Modal — כפתור 'הוסף איתות' בכרטיס Recommended Buy Price.
//         - כפתור קטן בשורת הכותרת של הכרטיס הירוק ב-Deep Analysis Modal.
//         - שומר את הניתוח כ-Active Signal ב-Master Knowledge (entry, SL, TP, catalyst).
//         TypeScript: 0 errors.
// v14.32: Dip Analysis — כפתורי פעולה תמיד גלויים + הוסף איתות קניה.
//         - כפתורי 'הגדר התראה' ו-'הוסף איתות קניה' מוצגים תמיד אחרי ניתוח (לא רק כשה-AI אומר כן).
//         - 'הוסף איתות קניה': שומר את הניתוח כ-Active Signal ב-Master Knowledge.
//           entry=$recommendedBuyPrice, SL, TP, catalyst=AI summary, source=Dip Analysis.
//           אם הטיקר כבר קיים — מעדכן. Toast: נוסף/עודכן.
//         - Master Knowledge: נוסף procedure addSignal.
//         - CTA bar בתחתית הדף: שני כפתורים זה לצד זה.
//         TypeScript: 0 errors.
// v14.31: Dip Analysis — Set Alert feature.
//         - "הגדר התראה" button appears in results when AI verdict is כן or המתן.
//         - Section 1: Telegram alert via priceAlerts.create (below target price).
//           Pre-filled with recommendedBuyPrice, editable. Checked every 30 min by alertPoller.
//         - Section 2: TradingView manual setup — condition string, webhook URL (auto-fetched),
//           JSON message body, step-by-step instructions. All fields copyable.
//         - CTA banner at bottom of results for quick access.
//         TypeScript: 0 errors.
// v14.30: Dip Analysis page + PWA shortcuts update.
//         - New page /dip-analysis: enter any ticker → full Tzanua methodology analysis.
//           Ziv Engine score, entry conditions (6 checks), recommended buy price,
//           stop loss (ATR-1.5 + EMA-50×0.97), take profit (2.5R), position sizing (1% risk rule).
//           AI verdict: dipOpportunity (כן/לא/המתן), entryRationale, idealEntryTrigger, risks, summary.
//           Results cached 4h per ticker per day.
//         - PWA manifest: added Dip Analysis as first shortcut (long-press app icon on mobile).
//         - GlobalNav: Dip Analysis link added to desktop nav + mobile drawer.
//         TypeScript: 0 errors.
// v14.29: IBKR session-expired Telegram alert — send only ONCE per expiry.
//         - Changed from level-triggered (every 10min while inactive)
//           to edge-triggered (fires once on active→inactive transition).
//         - alertSentForCurrentExpiry flag resets when session recovers,
//           so the next expiry will still send 1 alert.
//         TypeScript: 0 errors.
// v14.29: Mobile responsiveness for Trade Manager + Portfolio Equity Curve fix.
//         - Trade Manager header: stacks vertically on mobile (flex-col sm:flex-row).
//         - Buttons: shorter labels on mobile (hidden sm:inline / sm:hidden).
//         - Capital Summary Cards: 2-col on mobile, 3-col on sm, 5-col on md+.
//         - Analyze Buttons: always 2-col grid (was 2→4 on md).
//         - Holdings card header: stacks on mobile, last-refreshed badge hidden on mobile.
//         - portfolio_snapshots table created in DB (was missing — caused empty equity curve).
//         - recordDailySnapshot: changed to upsert (always updates today's value).
//         - PortfolioPerformanceChart: "Update Chart Now" button to force snapshot.
//         TypeScript: 0 errors.
// v14.27: Fix PM badge showing incorrectly during market hours.
//         - When IBKR is connected, isExtendedHours is always false.
//           IBKR provides real-time prices — no PM badge needed.
//         - PM badge now only shows when IBKR is disconnected AND Yahoo Finance
//           reports isExtendedHours=true (pre/after market data).
//         TypeScript: 0 errors.
// v14.26: Fix conid missing warning — save conid from IBKR positions to DB on Sync Now.
//         - portfolioHoldings schema: added conid INT column (ALTER TABLE migration applied).
//         - syncFromIbkr input: added optional conid field; saved to DB on update + insert.
//         - getPositions: already returns conid (p.conid ?? p.contract?.conid ?? null).
//         - Sell at Market dialog: fallback to live ibkrPositionMap conid when DB conid is null.
//           Now works immediately on first connect without requiring Sync Now.
//         - ibkrPositionMap type: added conid field.
//         TypeScript: 0 errors.
// v14.25: Auto live prices + fix market order live_order_confirm_missing.
//         - Holdings table: LIVE indicator (pulsing dot) when market is open.
//           IBKR connected → "LIVE · IBKR" (green). Yahoo Finance → "LIVE · 30s" (blue).
//         - Yahoo Finance prices: auto-refresh every 30s during market hours,
//           every 5min outside market hours (via useEffect + refetch).
//           Disabled when IBKR is connected (uses IBKR live positions instead).
//         - placeMarketOrder: added X-Confirm-Live-Order: yes header (was missing).
//           Error handling: live_order_confirm_missing → clear Hebrew message.
//           401/503 → "IBKR session לא פעיל — התחבר מחדש".
//         - getLivePrices tRPC procedure added to ibkrRouter (fetches from IBIND /positions).
//         TypeScript: 0 errors.
// v14.24: Performance optimization — faster page loads and navigation.
//         - Bundle split: index.js 810KB → 703KB, radix-ui+charts split out.
//           NOTE: react/react-dom/@trpc NOT split (causes duplicate React instance).
//         - TradeManager: DeepAnalysisModal, IBKROrderDialog, IBKRBracketDialog,
//           IBINDConnectScreen, PortfolioPerformanceChart, PerformanceChart all lazy-loaded.
//         - HoldingRow wrapped in React.memo to prevent unnecessary re-renders.
//         - QueryClient: staleTime=30s, gcTime=5min, refetchOnWindowFocus=false.
//         - DeepAnalysisModal: ibkrSettings staleTime=5min, chatHistory staleTime=1min.
// v14.23: Trade Manager UI redesign + TP away % in Holdings table.
//         - Take Profit cell now shows "away X%" below the price (same as Stop Loss).
//         - isNearTakeProfit (≤3% away): highlights in bold emerald.
//         - isAboveTakeProfit (price ≥ TP): shows 🎯 HIT badge.
//         - Gradient header, polished summary cards, styled alert banners,
//           improved table headers, SL/TP Monitor card with gradient header. 0 TS errors.
// v14.22: Fix "Please query /accounts first" — correct priming strategy.
//         - IBIND server has NO /accounts endpoint. POST /session/start does the priming internally.
//         - primeAccountsIfNeeded(): tries GET /api/proxy/iserver/accounts (passthrough) first,
//           then falls back to POST /session/start (which calls receive_brokerage_accounts()).
//         - /api/ibind/orders route: uses JSON.stringify to detect the error string anywhere.
//         - debugRawOrders tRPC: same improved detection + primeAccountsIfNeeded.
//         - session/start route: removed redundant manual priming (IBIND does it internally).
//         TypeScript: 0 errors.
// v14.21: Sell at Market dialog — editable quantity + live estimated value.
//         - Quantity field is now an editable number input (default = full position).
//         - Shows "X / total" hint next to the input.
//         - Estimated value updates in real time as quantity changes.
//         - Warning text changes to "מכירה חלקית" when qty < total units.
//         - Confirm button disabled when qty < 1 or invalid.
//         - Clamped on blur: min 1, max = total units.
// v14.20: Fix IBKR "Please query /accounts first" error.
//         - Added primeAccountsIfNeeded() exported helper in ibkrProxy.ts.
//           Calls GET /api/proxy/iserver/accounts (idempotent, safe to call multiple times).
//         - /api/ibind/orders route: auto-detects "Please query /accounts first" error,
//           primes /accounts, waits 500ms, retries /orders once automatically.
//         - debugRawOrders tRPC procedure: same auto-prime + retry logic.
//         - placeStopLossIbind, placeTakeProfitIbind, placeMarketOrder, placeBracketIbind:
//           all call primeAccountsIfNeeded() before placing the order.
//         TypeScript: 0 errors.
// v14.19: Fix SL/TP Monitor Sync — orders now correctly matched and ✓ appears.
//         - Added Debug button in SL/TP Monitor header: shows raw IBIND /orders JSON in a dialog.
//           Reveals actual field names: orderId (integer), orderType "Stop"/"Limit", ticker, side, status.
//         - syncSlTpOrderStatus Step 2: fixed orderType matching to handle IBKR's capitalized format
//           ("Stop" → "STOP" after toUpperCase) + added "LIMIT" alongside "LMT".
//         - placeStopLossIbind + placeTakeProfitIbind: expanded orderId extraction to support
//           all IBIND response shapes: r.result.order_id / r.result.orderId / r.orderId / r.order_id.
//           Also logs rawResp (first 400 chars) on SUCCESS for future diagnosis.
//         - Sync button + auto-sync: now filter only active orders (PreSubmitted/PendingSubmit/Submitted)
//           before sending to syncSlTpOrderStatus. Filled/Cancelled orders correctly trigger DB clear.
// v14.18: Holdings table cleanup + SL/TP Monitor improvements.
//         - Holdings: removed Delete, Edit, Send to IBKR, Bracket Order, Add to Diary buttons.
//           Replaced with 2 always-visible buttons: קנייה (green) + מכירה (red).
//         - SL/TP Monitor: removed קטגוריה column, added Value column (current price × units).
// v14.17: SL/TP Monitor — 3 critical bug fixes.
//         1. updateHolding bug: stopLoss + takeProfit were destructured out of 'data' and never saved to DB.
//            Fix: explicitly include them in the updatePortfolioHolding call.
//         2. TP not showing in Monitor: placeTakeProfitIbind (DeepAnalysisModal) never saved TP price to DB.
//            Fix: placeLMTMut.onSuccess now calls updateHolding({ takeProfit }) if holdingContext.id is set.
//            Same for placeSTPMut.onSuccess → saves stopLoss to DB.
//         3. conid missing warning from SL/TP Monitor: DeepAnalysisModal opened from Monitor didn't pass conid.
//            Fix: conid={(h as any).conid ?? undefined} + holdingContext.id now passed from Monitor.
//         - HoldingContext interface: added optional id field.
//         - updateHoldingMut added to DeepAnalysisModal for silent DB saves after order placement.
// v14.16: SL/TP Monitor: backfill missing buyScore + PM badge in Holdings Today %.
//         - portfolio.backfillBuyScore mutation: sets buyScore = zivScore for all holdings
//           where buyScore IS NULL and zivScore IS NOT NULL (units > 0).
//           Triggered via "מלא ציוני קניה" button in SL/TP Monitor header (auto-shown when any are missing).
//           Toast: "✓ ציוני קניה אוכלסו עבור N מניות: AAPL, NVDA, ..."
//         - getLivePrices: now returns isExtendedHours flag (true when price is from pre-market/after-hours).
//         - HoldingRow Today % cell: shows purple "PM" badge below the % when isExtendedHours=true.
//         - syncSlTpOrderStatus: strengthened matching — handles more IBIND field name variants
//           (orderType: STP/STOP/STOP_LIMIT/SL, side: SELL/S, ticker: symbol/ticker/description).
// v14.15: SL/TP Monitor — fix missing ✓ + add ציון קניה & קטגוריה columns.
//         - placeStopLossIbind + placeTakeProfitIbind: now save orderId to DB after success.
//           Previously only placeSTPOrder/placeLMTOrder (old paths) saved to DB.
//           Fix: ✓ now appears in SL/TP Monitor after placing orders via DeepAnalysisModal.
//         - syncSlTpOrderStatus: upgraded to 2-step sync.
//           Step 1 (existing): clear stale IDs not in live IBKR orders.
//           Step 2 (new): match live IBKR orders by ticker → populate missing ibkrSlOrderId/ibkrTpOrderId.
//           STP SELL → ibkrSlOrderId; LMT SELL → ibkrTpOrderId.
//           Toast: "✓ Synced N SL/TP order ID(s) from IBKR" when IDs populated.
//         - SL/TP Monitor table: added 2 new columns after Ticker:
//           "ציון קניה" (buyScore, color-coded: green≥7 / amber≥5 / red<5).
//           "קטגוריה" (entryTier badge: ליבה=green / צמיחה=blue / מעקב=amber / נמוך=red).
//         - Holding interface: added entryTier field; propagated to IBKR path + DB path.
// v14.14: Market Order UI — Sell at Market button in Holdings table + DeepAnalysisModal fixes.
//         - HoldingRow: added orange TrendingDown button → opens Sell at Market confirmation dialog.
//           Dialog shows: ticker, quantity, current price, estimated value, slippage selector (0.1/0.5/1.0/2.0%).
//           Calls POST /orders/market via trpc.ibkr.placeMarketOrder (LMT+slippage buffer, cOID MKT-).
//         - DeepAnalysisModal: fixed placeMktMut.mutate to send conid + slippagePct (was sending accountId).
//           Added slippage selector (0.1/0.5/1.0/2.0%) to Market Order confirmation dialog.
//           Added conid guard: BUY/SELL buttons disabled + warning when conid missing.
//           Confirm button disabled when conid ≤0 with tooltip hint to run Sync Now.
// v13.51: Replaced 5 individual scan buttons with single Scan All button.
//         - Runs all 5 scan types in parallel (Finviz, TradingView, Whale, IBD, Sector).
//         - Filters score <7 — only shows top 15 results with score ≥7.
//         - Results table: Sources column shows which scan types found each ticker.
//         - Removed Deposit/Withdraw buttons from Trade Manager (not relevant).
// v13.50: Deep Analysis caching (4h TTL), manual Sync SL/TP button, Telegram alert on SL cleared.
//         - deepAnalysisCache DB table: cache LLM result by (ticker, date:holdingHash).
//         - analyzeAsset: returns cached result instantly if < 4h old (no LLM call).
//         - SL/TP Monitor header: Sync button for manual on-demand order status refresh.
//         - syncSlTpOrderStatus: sends Telegram alert when SL/TP order is cleared.
// v13.49: Fix SL/TP Monitor checkmark showing active when order is cancelled/filled.
//         - Added ibkr.syncSlTpOrderStatus procedure: compares DB order IDs against
//           live IBKR open orders list and clears stale IDs from DB.
//         - Frontend auto-syncs on IBKR connect and every 5 minutes.
//         - Works with both IBIND and iBeam gateway.
// v13.48: Fix positions table P&L columns visual merge.
//         - Added dir="ltr" to table to prevent RTL layout reversing column order.
//         - Added whitespace-nowrap to all cells so values never wrap.
//         - Replaced flex with inline-flex in Unrealized P&L cell.
//         - Realized P&L cell: separate variable for color logic.
// v13.47: IBIND HMAC-SHA256 request signing.
//         - signRequest() helper: timestamp + nonce + exact body bytes.
//         - ibindRequest() signs every outbound call (X-Timestamp/X-Nonce/X-Signature).
//         - Authorization: Bearer kept alongside HMAC (defense in depth).
//         - Retry once on 401 hmac_* errors (clock drift protection).
//         - IBIND_HMAC_SECRET added to ENV and Secrets.
//         - 9 new vitest tests for signRequest algorithm.
// v13.46: Fix IBKR Account positions table display.
//         - Ticker/Name: use contractDesc (IBIND field) instead of symbol.
//         - Filter out 0-position rows (hide assets with 0 units).
//         - mktPrice: use direct p.mktPrice from IBIND (not computed).
//         - realizedPnl: now read from IBIND response (was hardcoded 0).
//         - Realized P&L column: added left padding to prevent visual merge.
// v13.45: Fix IBKR Account page — IBIND nested schema mismatch.
//         - account-summary: unwrap { success, summary: {...} } wrapper; read nested fields.
//         - positions: unwrap { positions: [...] } wrapper; support both mktValue and marketValue.
//         - orders: unwrap { orders: [...] } wrapper.
//         - account ID extracted from summary.accountcode?.value (IBKR nested format).
// v13.44: Fix isPushPaused persistence across server restarts.
//         - Added systemSettings DB table (key-value store for server-side flags).
//         - getSystemSetting/setSystemSetting helpers added to server/db.ts.
//         - ibkrServerTickle.ts: loads isPushPaused from DB on startup, saves to DB on pause/resume.
//           Now survives Node.js restarts — iBeam alerts stay suppressed after intentional stop.
//         - ibkrSessionMonitor.ts: same pattern for isMonitorPushPaused.
//         - ibkrProxy.ts: pause/resume routes now await the async persist calls.
//         - DB seeded: ibeam_push_paused=true + ibeam_monitor_push_paused=true (iBeam intentionally stopped).
// v13.33: STP/LMT orders: tickle before every order + better error message.
//         - placeSTPOrder + placeLMTOrder: send /tickle to IBKR before placing order.
//           Ensures trading session is alive (prevents silent 'No trading permissions').
//         - 'No trading permissions' error now shows user-friendly message:
//           "IBKR session expired — please click Renew Session in Settings → IBKR".
// v13.37: Fix "No trading permissions" — authenticated vs connected distinction:
//         - checkIbeamReady: now checks connected=true (not just authenticated=true).
//           If connected=false, auto-calls POST /iserver/auth/status to init brokerage session.
//           If still not connected after init → shows clear Hebrew error.
//         - Added tryReauthenticate() helper: calls /iserver/reauthenticate before retry.
//         - STP/LMT retry flow: reauthenticate + tickle + 2s wait before retrying order.
//         - Full IBKR response logged (600 chars) for order failures to aid debugging.
// v13.36: STP/LMT order failure diagnosis improvements:
//         - checkIbeamReady() pre-check before every STP/LMT order placement.
//           If iBeam is DOWN → "יBeam כבוי — לחץ Recreate iBeam Container".
//           If not authenticated → "iBeam לא מאומת — לחץ Renew Session".
//           If unreachable → "לא ניתן להתחבר ל-iBeam".
//         - ibkrServerTickle.ts: container DOWN block now also triggers auto-restart
//           after MAX_CONSECUTIVE_FAILURES (was only triggered for unauthenticated).
//         - Extracted maybeAutoRestart() helper to avoid code duplication.
// v13.35: STP/LMT order reliability improvements:
//         - accountId guard: buttons disabled + toast error if accountId not loaded yet.
//         - Retry logic: if 'No trading permissions' → tickle + 2s wait → retry once automatically.
//         - LMT order: same retry logic as STP.
//         - Buttons show 'טוען...' while accountId is loading.
// v13.34: ibkrServerTickle.ts — major stability improvements:
//         - Tickle interval: 3 min → 50 seconds (IBKR kills session after 5 min, 50s = safe margin).
//         - Consecutive failure tracking: after 3 failures → auto-restart iBeam via control server.
//         - Restart cooldown: max 1 restart per 5 minutes (prevents restart loop).
//         - Telegram alerts: container DOWN, auto-restart triggered, restart failed, unreachable.
//         - Telegram cooldown: max 1 alert per 10 minutes (no spam).
//         - IBKRPanel keepalive label updated: 50s (server, auto-restart).
// v13.33: Server-side IBKR keepalive — iBeam stays alive even when browser is closed.
//         - ibkrServerTickle.ts: new service, runs every 3 min from Node.js server.
//           Checks iBeam status → if authenticated, sends POST /tickle.
//           If not authenticated or down → logs warning, skips tickle.
//         - server/_core/index.ts: startServerTickle() called on server startup.
//         - IBKRPanel: keepalive label updated to show both browser (55s) + server (3m).
//         - STP/LMT orders: tickle sent before every order placement.
//           'No trading permissions' error now shows user-friendly message.
// v13.32: Trade Manager — no auto-refresh + IBKR connect button.
//         - Removed auto-trigger on page load (refreshMut + analyzeHoldings + dailyReview).
//           These now only run on IBKR connect or manual button press.
//         - Removed auto-refresh interval selector (Off/5m/15m/30m) from header.
//         - getLivePrices for holdings + catalogue: refetchInterval set to false (no polling).
//         - IBKR status badge replaced with clickable button:
//           Green (connected) = click to disconnect (pause iBeam).
//           Red (disconnected) = click to navigate to Settings#ibkr for reconnect.
//         - Settings: added id="ibkr" anchor to IBKR SectionCard for scroll-to navigation.
// v13.31: SL/TP Monitor: click ticker to open Deep Analysis (same as holdings table).
// v13.30: Deep Analysis — clean view for held positions.
//         - When holding: only My Position card shown (Buy Price, Units, P&L, SL, TP).
//           Engine SL, Engine Buy Price, Position Size cards hidden.
//         - When not holding: full engine analysis shown as before.
// v13.29: Deep Analysis — Current Position card + SL sync fix.
//         - SL field now initialized from holdingContext.stopLoss (DB) not engine's stopLoss.
//           Prevents showing wrong SL when position already has a custom SL.
//         - Stop Loss card: shows "Yours: $X" badge when holding has a saved SL.
//         - Recommended Buy Price card replaced with Current Position card when holding:
//           shows Buy Price, Units, P&L, Position Value, Active SL, Active TP.
// v13.28: Auto-sync cooldown — skip if synced < 10 min ago.
//         - handleConnect + handleQuickConnect: check lastSyncAt before auto-sync.
//           If last sync was < 10 min ago → skip with log "⏩ Skipping auto-sync — last sync was Xm ago".
//         - Applies to both Connect and Quick Connect flows.
// v13.27: Connection Log persisted to DB + Real Balance fix.
//         - ibkrConnectionLog DB table: stores all connection events with userId, message, type, timestamp.
//         - IBKRPanel: logs saved to DB on addLog(), loaded from DB on mount (last 1h by default).
//         - Log header: 1h/3h/6h/24h time range selector + Refresh button.
//         - lastKnownNetLiquidation column added to portfolioAccounts.
//         - syncFromIbkr: saves netliquidation to lastKnownNetLiquidation.
//         - Real Balance: shows live NLV when connected, lastKnownNetLiquidation offline.
// v13.26: UX fixes.
//         - Connection Log: added Copy button (copies all entries to clipboard)
//           and Expand/Collapse height button (max-h-48 → max-h-[480px]).
//           Log text is now selectable (select-text).
//         - Deep Analysis modal: no longer scrolls page to chat on open.
//           Modal now resets scroll position to top when opened.
//           Chat auto-scroll only fires when user/engine adds new messages.
// v13.25: Fix SL/TP Monitor — wrong SL price + misleading checkmark.
//         - placeSTPOrder: now also saves stopLoss price to DB (was keeping old value).
//           LUNR showed $26.34 (old) instead of $26.50 (actual order price). Fixed.
//         - SL/TP checkmark (✓) changed from green to amber with tooltip clarifying
//           "PreSubmitted/Submitted — connect to IBKR to verify live status".
//           Green was misleading — order may be PreSubmitted/not yet confirmed live.
//         - DB corrected: LUNR stopLoss updated to $26.50.
// v13.24: Fix Portfolio Value showing wrong amount ($100K vs $196K).
//         - Root cause: app was using netliquidation ($100K = NLV after margin/loans)
//           instead of grosspositionvalue ($196K = שווי תיק in IBKR).
//         - getAccountSummary now returns grossPositionValue field.
//         - syncFromIbkr now saves grossPositionValue to lastKnownNLV in DB.
//         - TradeManager: Portfolio Value card uses grossPositionValue when connected,
//           lastKnownNLV (now = grossPositionValue) when offline.
//         - DB corrected: lastKnownNLV updated to $195,878.
// v13.23: Critical bug fixes — STP/LMT orders now reach IBKR + chat history persists.
//         - placeSTPOrder: fixed 'auxPrice' → 'price' (IBKR Web API requirement).
//           All previous STP orders silently failed with 'Invalid order price fields'.
//         - placeSTPOrder/placeLMTOrder: now handle multiple IBKR reply rounds (recursive).
//           IBKR sometimes requires 2+ confirmation rounds; old code handled only 1.
//         - engineChatHistory DB table created (was missing — caused chat history loss on every restart).
//           Chat messages now persist across version updates.
// v13.22: SL/TP IBKR Order Tracking + auto-cancel on quantity change.
//         - portfolioHoldings: 4 new fields (ibkrSlOrderId, ibkrSlOrderQty, ibkrTpOrderId, ibkrTpOrderQty).
//         - placeSTPOrder/placeLMTOrder: orderId saved to DB after successful order placement.
//         - syncFromIbkr: auto-cancel SL/TP orders when units change (quantity mismatch detected).
//           Cancels order via IBKR API + clears orderId from DB. Logged as WARN in ORDER category.
//         - SL/TP Monitor table: 2 new columns (SL ✓ / TP ✓) — green checkmark when IBKR order active.
//           Hover shows orderId. Dash when no order placed.
//         - portfolioAccounts: 4 new fields (lastKnownNLV, lastKnownCash, lastKnownTodayPnl, lastKnownNLVAt)
//           for offline mode display (saved on every syncFromIbkr call).
// v13.21: Bug fixes — SL/TP monitor + Open Orders table + zero-unit holdings hidden.
//         - Trade Manager: SL/TP Monitor table added below holdings (shows all positions with SL or TP set).
//           Columns: Ticker / Current / Stop Loss / SL Distance% / Take Profit / TP Distance% / Status.
//           Status badges: Active / ⚠ NEAR SL (<3%) / 🚨 BELOW SL / 🎯 HIT TP / 📈 NEAR TP.
//           Row highlighted red/orange/green based on proximity to SL/TP.
//         - IBKRPanel: Open Orders (STP/LMT) table moved directly below Account Summary.
//           Previously appeared after IBKR Positions; now visible immediately after account data.
//         - Holdings table: positions with 0 units are now hidden from the table.
// v13.20: Bug fixes — IBKR disconnects + /api/ibkr-proxy/accounts 404 + conid lookup logging.
//         - Global tickle (keepalive): moved from IBKRPanel to IbkrTickleProvider (main.tsx).
//           Tickle now runs on ALL pages every 55s — prevents IBKR session drops when navigating away.
//         - Added GET /api/ibkr-proxy/accounts endpoint (was missing, caused 404 in DeepAnalysisModal).
//         - conid lookup in placeSTPOrder/placeLMTOrder: logs raw response from secdef/search;
//           when iBeam is down, error now clearly states 'Connection refused' instead of 'Could not find conid'.
// v13.19: Comprehensive structured logging system.
//         - server/logger.ts: centralized logger with ring buffer (500 entries), log levels (DEBUG/INFO/WARN/ERROR),
//           categories (IBKR/DB/AUTH/ORDER/TELEGRAM/ANALYSIS/SYSTEM/PROXY).
//         - All critical server paths instrumented: ibkrProxy.ts, ibkr.ts (ORDER), telegramWebhook.ts,
//           portfolio.ts (ANALYSIS), ibkrSessionMonitor.ts, _core/oauth.ts (AUTH).
//         - /logs tRPC endpoint (logsRouter) returns filtered ring buffer entries.
//         - /logs page in UI: table with Time/Level/Category/Message/Data columns,
//           level + category dropdowns, auto-refresh every 10s, manual refresh button.
//         - Logs link added to nav (desktop + mobile).
// v13.18: Bug fixes — IBKR connection detection + holdings data persistence.
//         - IBKR auth check now runs browser-side directly against Gateway URL (not via server proxy).
//           Fixes "IBKR not connected" false-negative when Gateway runs on user's local machine.
//         - SL/TP regex expanded to catch Hebrew engine responses.
//         - Place STP/LMT buttons enabled based on real browser-side connection check.
// v13.17: IBKR connection fix + smart confirmation dialogs + SL/TP auto-update from chat.
//         - IBKR status now uses ibkrConnected state (from proxy auth check) — buttons enabled even if accountId not yet loaded.
//         - SL/TP regex expanded to catch Hebrew responses (סל, סטופ לוס, עדכן ל-$X).
//         - SL dialog: shows max loss in $, warns if SL too close to market price or deviates >10% from engine.
//         - TP dialog: shows expected profit, R/R ratio, warns if TP too low or R/R < 1.5:1.
//         - Both dialogs: warns if IBKR not connected with link to /ibkr. Hebrew UI (אשר ושלח / בטל).
// v13.16: White chat/TP/SL panels + persistent chat history + auto SL/TP update from engine.
//         - Chat area, TP panel, SL panel all changed to white background with black text.
//         - engineChatHistory DB table: saves every message per user+ticker.
//         - Chat history loaded from DB when modal opens for same ticker.
//         - Engine replies parsed for SL/TP values → auto-updates fields + toast notification.
//         - Clear chat button in chat header.
// v13.15: Clean white/black styling for TP and SL execution panels.
// v13.13: Watchlist improvements — no duplicates, delete button, sort by date.
//         - Deduplication: each ticker appears once (from the newest video that mentioned it).
//         - Dismiss button (trash icon) per row: removes ticker from list permanently (watchlistDismissed DB table).
//         - Default sort: newest video first. Toggle button to switch to score sort.
//         - Server: dismissWatchlistTicker tRPC mutation + watchlistDismissed MySQL table.
// v13.12: TP Execution + Opinionated Trading Engine Chat + Telegram AI Chat.
//         - TP Execution Panel (emerald): Limit Price + Quantity + Place LMT button.
//         - TP Confirmation Dialog: shows ticker, limit price, qty, R/R preview, LMT·GTC warning.
//         - placeLMTOrder tRPC procedure: places SELL LMT GTC order on IBKR + Telegram notification.
//         - Trading Engine Chat upgraded: full server-side tradingChat procedure with Ziv Engine
//           system prompt (scoring, SL/TP rules, position sizing, exit protocols, philosophy).
//           Engine is opinionated — pushes back when user violates risk rules.
//         - Telegram AI Chat: free-text messages (non-commands) routed to Ziv Engine AI.
//           Engine knows full methodology + current portfolio context. Conversation history kept in memory.
//           /help updated to advertise the free-text chat feature.
// v13.11: AI Trading Chat + SL Execution in Deep Analysis Modal.
//         - Chat panel (dark theme) with engine/user message bubbles and Enter-to-send input.
//         - SL Execution Panel: editable Stop Price (pre-filled from engine), Quantity (pre-filled from holding),
//           Place STP button that opens a confirmation dialog.
//         - SL Confirmation Dialog: shows ticker, stop price, qty, order type STP·GTC, warning before placing.
//         - placeSTPOrder tRPC procedure in ibkr.ts: looks up conid for ticker, places SELL STP GTC order.
//         - tradingChat tRPC procedure in ibkr.ts: LLM-powered chat with full analysis context.
// v13.06: Code splitting with React.lazy() — all 14 pages load on-demand as separate chunks.
//         Initial bundle: 2,515KB → 807KB vendor + per-page chunks (8-279KB each).
//         No manualChunks to avoid React duplicate instance issue.
// v13.05: IBKR data refresh: 60s during NYSE market hours (09:30–16:00 ET), 10min outside market hours
//         and on weekends. ibkrRefetchInterval computed from UTC time with EDT/EST offset.
// v13.04: Cash Balance in Trade Manager now shows Net Cash (totalcashvalue) from IBKR — supports
//         negative values (margin debit). Displays in red when negative. Label shows 'Net Cash · IBKR live'
//         when IBKR is connected.
// v13.01: Fix Account Summary not loading — pre-auth check now fetches accounts first
//         to get accountId before calling loadAccountData(). Previously loadAccountData()
//         returned early because selectedAccountId was empty string on mount.
// v13.00: Version bump — same code as v12.61.
// v12.61: Fix Account Summary not loading in Settings when already connected to IBKR.
//         IBKRPanel pre-auth check now calls loadAccountData() immediately when authenticated=true
//         on mount, so Account Summary is populated without needing to click Connect again.
// v12.60: Account Summary card shown in Settings when IBKR connected. Cash Balance in TradeManager
//         synced from IBKR totalcashvalue. Portfolio Allocation pie chart removed.
// v12.59: Auto-recover from failed/disconnected state when polling detects authenticated=true.
//         Clears 'Cannot reach gateway' alert, updates badge to Connected, shows toast + log.
// v12.58: Fix auth-status and ibeam-status to use /ibeam/status (port 6000) instead of
//         /ibkr/v1/api/iserver/auth/status which returned 'not found'.
//         Both endpoints now read authenticated/connected directly from ibeam-control.
// v12.57: Two separate IBKR buttons — Connect to IBKR (docker start) + Recreate iBeam (docker run)
//         Container state badge: not_found (red) | stopped (yellow) | running (green)
//         Container state polls every 30s via GET /api/ibkr-proxy/ibeam-status
//         Recreate iBeam button visible when not connected with tooltip hint
// v12.56: IBKR credentials check + Recreate iBeam Container button
//         GET /api/ibkr-proxy/credentials-check: checks if /root/ibeam/.env exists on control server
//         IBKRPanel: credentials missing alert banner (red) with SSH instructions
//         IBKRPanel: "Recreate iBeam Container" button (purple) — calls /ibeam/restart via resume endpoint
//         Both features help recover when iBeam container is missing without SSH access
// v12.55: Regression fix — restored v12.45 2FA flow (JWT cookie + HTML redirect + simple verify-existing)
//         cookie-parser dependency added (was missing after rollback)
// v12.45: Add "Stop Connecting" button (visible during 180s countdown) — cancels polling, stops iBeam
//         Add "Check iBeam Status" button (always visible) — shows authenticated/connected/stale in Connection Log
//         Add "Stop iBeam Push" button (visible when disconnected) — stops iBeam container, disables all push notifications
// v12.44: SERVER-SIDE FIX — ibeam-control.py rewritten on 143.198.141.131
//         Bug #1: /ibeam/status now proxies to real IBKR /iserver/auth/status (not cookie file)
//         Bug #3: /ibeam/stop returns 202 immediately (async docker stop in background thread)
//                 /ibeam/restart returns 202 immediately (async stop+3s+start)
//                 CORS headers (Access-Control-Allow-Origin: *) on all endpoints + OPTIONS handler
//         Bug #2: auto-resolved — Quick Connect now sees real authenticated=true from /ibeam/status
//         Session Timeout (60 min): IbkrSessionGuard + useInactivityTimeout verified correct
// v12.43: 60-min inactivity timeout — useInactivityTimeout hook tracks mousemove/keydown/click
//         On timeout: POST /api/ibkr-proxy/pause + sessionStorage flag + redirect to Settings
//         Settings shows amber banner "Session expired due to inactivity"
//         handleQuickConnect: graceful fallback to handleConnect if session dies (race condition)
//         Disconnect button verified: calls /api/ibkr-proxy/pause + clears state correctly
// v12.42: Quick Connect — on Settings load, check /api/ibkr-proxy/auth-status
//         If authenticated=true: show green "Connect to IBKR ✅" button (no push/restart)
//         handleQuickConnect: skips push, verifies auth once, loads account, marks connected
// v12.41: Fix CORS — 180s polling now calls /api/ibkr-proxy/auth-status (server-side proxy)
//         Browser was calling 143.198.141.131:6000 directly — CORS blocked the response
//         Server proxies GET /iserver/auth/status and returns { authenticated, connected }
// v12.40: Fix 180s polling — changed from /ibeam/status to /ibkr/v1/api/iserver/auth/status
//         /ibeam/status returned wrong authenticated value; real auth check is /iserver/auth/status
// v12.39: 180s countdown timer + 5s polling after Resume iBeam
//         Polls GET /ibeam/status every 5s; shows MM:SS countdown in UI
//         On auth=true → Connected; on 180s timeout → POST /ibeam/stop → Failed
// v12.38: Auto-sync Holdings from IBKR after successful Connect
//         IBKRPanel Step 11: fetches positions + calls syncFromIbkr mutation automatically
//         Logs sync result in Connection Log; shows toast with position count
// v12.37: Fix Resume iBeam — now calls POST /ibeam/restart (stop+3s+start) instead of /ibeam/start
//         Guarantees fresh login + new push notification every time, even if iBeam was already running
// v12.36: Add "Refresh from IBKR" button in Holdings header
//         syncFromIbkr tRPC procedure: upserts IBKR live positions into portfolioHoldings DB
//         Preserves SL/TP/zivScore/notes; removes closed positions; inserts new ones
//         Button visible only when IBKR connected; data persists for offline use
// v12.35: Remove IBKR Positions/Orders tables from Settings page
//         IBKRPanel now accepts showPositions prop (default true)
//         Settings uses showPositions={false} — only shows connect/disconnect controls
//         Holdings in TradeManager already update from IBKR live positions (unchanged)
// v12.34: Simplified IBKR Connect flow — ONE push attempt, zero auto-retries
//         Resume = docker start + wait 3s + ONE ssodh/init push + wait 8s + ONE auth/status check
//         If authenticated=true → Connected ✅; if not → Failed ❌ (click Resume to try again)
//         Removed: iBeam status polling, auto-retry loops, "iBeam Starting" spinner, complex error branches
//         ConnectionStatus type simplified: disconnected | connecting | connected | failed
// v12.25: Move TOTP setup from raw fetch → tRPC procedures (totp.getSetupData, totp.verifySetup)
//         Root cause: raw fetch("/api/totp/setup") didn't send cookies (SameSite=None requires HTTPS)
//         tRPC httpBatchLink already sends credentials:include correctly
// v12.24: Fix root cause of "Not authenticated" on /settings/totp-setup
//         sdk.verifySession() was rejecting JWTs with empty name field
//         createSessionToken(openId, { name: "" }) → JWT had name="" → isNonEmptyString("") = false → null
//         Fix: allow name to be any string (including empty) in verifySession
// v12.23: Rate limiting on 2FA verify endpoints (5/min per IP)
//         /api/totp/setup now accessible to unverified sessions (fixes "Not authenticated")
//         Settings: Security section with TOTP status + Revoke All Sessions button
//         Revoke All Sessions: 2-click confirm, clears all verified_sessions, logs out
// v12.22: 2FA bypass fix — RequireVerified render-level gate
//         All protected routes wrapped in RequireVerified component
//         Even SPA navigation (clicking nav links) is blocked until TOTP verified
//         RequireVerified shows spinner and redirects — never renders page content
//         Public routes (/, /login, /verify-2fa, /settings/totp-setup) unwrapped
// v12.21: Fix TOTP first-time setup redirect
//         context.ts: adds totpConfigured flag (checks if totpSecret exists in DB)
//         routers.ts: auth.me returns totpConfigured alongside needs2fa
//         useAuth.ts: if needs2fa + !totpConfigured → redirect to /settings/totp-setup
//                     if needs2fa + totpConfigured → redirect to /verify-2fa (as before)
//                     if already on /verify-2fa but TOTP not configured → redirect to setup
// v12.20: TOTP 2FA enforcement — session-level blocking
//         verified_sessions DB table: every session must pass TOTP before accessing any protected route
//         context.ts: needs2fa flag set if owner session not in verified_sessions
//         trpc.ts: protectedProcedure throws FORBIDDEN/TOTP_REQUIRED if needs2fa
//         useAuth.ts: detects needs2fa from auth.me and auto-redirects to /verify-2fa
//         Verify2FA.tsx: tries /api/2fa/verify-existing (existing sessions) then /api/2fa/verify (new login)
//         New /api/2fa/verify-existing endpoint: verifies TOTP for already-authenticated sessions
//         New /api/2fa/revoke-all endpoint: emergency session revocation
// v12.19: Google Authenticator TOTP 2FA — removed Telegram OTP entirely
//         twoFactor.ts rewritten: TOTP setup/verify endpoints, pending_2fa cookie flow
//         Verify2FA.tsx: clean TOTP input (no Telegram UI)
//         New /settings/totp-setup page: QR code scan + confirm code
//         totpSecret column added to users table
//         Login flow: OAuth → pending cookie → /verify-2fa → TOTP verify → real session
// v12.18: Disconnect button in IBKRPanel
//         Red 'Disconnect' button appears next to Reconnect when status = Connected.
//         Calls POST /api/ibkr-proxy/pause (stops iBeam container) then resets UI to disconnected.
//         Disabled while pause is in progress (shows spinner).
// v12.18: Disconnect = full iBeam stop; Connect = docker start + wait + auth
//         Disconnect button calls POST /api/ibkr-proxy/pause (docker stop ibeam) + resets UI.
//         Connect button now calls POST /api/ibkr-proxy/resume (docker start ibeam) first,
//         waits 3s for gateway to initialise, then proceeds with ping + auth flow.
//         Full stop/start lifecycle controlled from the UI without SSH access.
// v12.17: Live IBKR Holdings Overlay
//         Holdings table now shows live IBKR positions (qty, mktPrice, mktValue, avgCost, unrealizedPnl)
//         when connected to IBKR. DB data (SL/TP, diary, scores) is merged by ticker.
//         Added getPositions + getAccountSummary tRPC procedures in ibkr.ts router.
//         Header shows NLV from IBKR + 'IBKR Live · N positions' badge when connected.
//         Refreshes every 60s automatically when connected.
// v12.16: BREAKTHROUGH — route ALL gateway calls through Control API on port 6000
//         http://143.198.141.131:6000/ibkr/v1/api/[path] for IBKR API calls
//         http://143.198.141.131:6000/ibeam/health for ping
//         No HTTPS agent, no rejectUnauthorized, no cookies needed
//         Verified: authenticated=true, connected=true end-to-end
// v12.15: UI cleanup — remove Open Gateway button, fix all stale log strings (localhost:5000 → 143.198.141.131:5000)
//         Fix gatewayUrl default http → https everywhere in IBKRPanel
//         Port 5000 confirmed open on IBKR server (ufw allow 5000/tcp)
// v12.14: CRITICAL — Remove all localhost:5000 refs (tradesnow.vip is on Manus cloud, NOT same server as iBeam)
//         All gateway calls now use https://143.198.141.131:5000 with rejectUnauthorized:false
//         ibkrAgent (rejectUnauthorized:false) applied to ALL fetch calls to the IBKR gateway
//         Control API (pause/resume/status) uses http.request() to bypass port 6000 bad-port block
// v12.13: Fix Control API 'fetch failed' on port 6000
//         Node.js native fetch blocks port 6000 (WHATWG bad-port list).
//         Replaced fetch() with http.request() in controlApiRequest() — no port restrictions.
//         Pause, Resume, and ibeam-status all verified working end-to-end.
// v12.12: Fix Control API calls (published build was still using old exec code)
//         Removed auto-reconnect countdown and timer — no more 60s retry loop
//         Removed auto-connect on page load — Connect button is the only trigger
//         iBeam Starting status now says 'Click Connect to retry' (not 'Retrying automatically')
// v12.11: iBeam Control API integration
//         pause/resume/ibeam-status now call http://143.198.141.131:6000/ibeam/stop|start|status
//         No more local exec() — Control API runs as systemd service on IBKR server.
// v12.10: Docker exec fix — use exec('/usr/bin/docker', { env: { PATH: '/usr/bin:...' } })
//         Docker socket chmod 666 on server; exec now works with explicit PATH env.
//         Reverted Docker socket HTTP API approach (simpler exec is sufficient).
// v12.09: Fix docker not found — hardcode DOCKER=/usr/bin/docker in ibkrProxy.ts
//         Removed resolveDockerPath() helper; all exec() calls now use /usr/bin/docker.
// v12.08: iBeam Pause/Resume controls
//         Added POST /api/ibkr-proxy/pause (docker stop ibeam) and
//         POST /api/ibkr-proxy/resume (docker start ibeam) server endpoints.
//         GET /api/ibkr-proxy/ibeam-status returns Running/Paused/Connected.
//         IBKRPanel: iBeam status row with Running/Paused/Connected badge.
//         Pause/Resume toggle button in settings panel.
//         Cancel button in auto-reconnect countdown now pauses iBeam (docker stop).
//         Status polls every 15s automatically.
// v12.07: iBeam HTTPS fix + friendly starting status
//         ibkrProxy.ts now always routes to https://localhost:5000 with rejectUnauthorized:false
//         IBKRPanel shows blue '🔄 iBeam Starting...' badge instead of red Error
//         when gateway is unreachable (IBKR rate-limiting / container starting up).
//         Auto-retry every 60s continues silently in background.
// v12.06: iBeam migration — IBKR Gateway UI simplified
//         Removed Session Cookie field, bookmarklet, and 4-step manual flow.
//         Connect button now auto-pings/verifies (iBeam manages session internally).
//         Added Connection Log Panel (collapsible terminal-style).
//         Kept status badge, Renew Session Telegram button, Gateway URL field.
// v1.187: YouTube Analyzer UI Improvements
//         (1) "Analyze" is now a top-level nav item (was hidden in Knowledge dropdown).
//         (2) Trading table columns now show Hebrew sub-labels below English names.
//         (3) Stage breadcrumb in progress bar shows Hebrew sub-labels per stage.
// v1.186: QQQ EMA Precomputation — O(N) once instead of O(N) per day
//         Pre-compute QQQ EMA-20 and EMA-50 for all bars before simulation starts.
//         Eliminates ~75,000 redundant EMA calculations for a 6-year simulation.
//         Replaces slice+calcEMA in the daily loop with O(1) precomp array lookups.
// v1.185: Simulation 60s no-activity timeout with ERR_SIM_TIMEOUT error code
//         Past Simulations version badge now shows APP_VERSION (not engine version)
//         Past Simulations shows check timestamp (date + time)

// Trading simulation engine version — bump when simulation logic changes
// v1.153: Multi-select asset picker (UI only, no engine change)
// v1.153: CRITICAL FIX — finalOrderMode now enters the 2-day Daily EMA-10 branch
//         (was falling through to standard TP check, causing single-close exits)
// v1.153: Check Status pre-flight scanner (Ziv Suitability Score 1-10) + per-card Edit/Remove
// v1.153: Download Logs CSV button on each Past Simulations row
// v1.153: CRITICAL FIX — Final Order Mode exit text + Winner's Leash raised to 10% + only activates after 5% gain
// v1.153: Asset List UI overhaul — table layout, working Remove/Edit, sort by score after Check Status
// v1.153: Fix Check Status "No Data" — reduced batch size to 3, 700ms delay, retry on empty result
// v1.153: Add Asset row at bottom of Asset List table
// v1.153: CRITICAL FIX — (1) Auto-skip Red tickers (Ziv Score 1-3) at simulation start
//         (2) Proximity entry widened from 2.5% to 4% of EMA-50 (cure Analysis Paralysis)
//         (3) Monkey Math fixed — always include all tickers' capital in baseline (was dropping missing-data tickers)
// v1.153: CRITICAL FIX — (1) Pre-flight now checks EMA at simulation startDate (not today) — fixes NVDA/MU/AVGO/GOOGL being wrongly blocked
//         (2) Dynamic allocation: Breakout=45% of cash, Core=30%, Pullback=20%, Near=12%
//         (3) Winner's Leash raised from 10% to 15% from peak (survive volatile tech noise)
// v1.153: Daily Loop Engine Upgrades
//         (1) Momentum Rescan Trigger: if bar.high >= Donchian-20 high → bypass LLM cooldown, immediately call aiScanTicker
//         (2) Master Fund Liquidity Override: if Tier-1 Breakout validated but cash < 45% required,
//             force-close weakest open position (Near Entry first, then lowest ROI) to free capital
// v1.153: Diamond Hands Exit Logic
//         (1) Final Order Mode exit: Daily EMA-10 → Daily EMA-20 (2-day confirmation) — wider buffer for volatile tech
//         (2) ZIM Protocol exit: Weekly EMA-50 → Weekly EMA-200 (true structural death only, not corrections)
//         (3) Bug fix: Check Status now scans ALL tickers including custom-added ones (TEVA etc.)
//         (4) Bug fix: Sector auto-detected from Yahoo Finance longName after Check Status runs
// v1.153: Tier-1 Breakout Exit Override
//         Donchian Breakout / Join the Move positions (zivFormation === "breakout") are IMMUNE to EMA-20 exit.
//         They exit ONLY via the 15% Winner's Leash trailing stop from peak price.
//         EMA-20 exit is preserved for Tier-2/3/4 (Pullback, Near Entry, Standard) positions.
// v1.153: Five critical bug fixes from simulation audit report
//         (1) Weekly EMA-200 FIXED — now uses true ISO-week aggregation with 1500-day lookback
//             (old method used daily[i%5] sampling → ~50 pseudo-bars, not 200 real weeks)
//         (2) Default startDate changed from 2025-01-01 → 2023-01-15
//         (3) Crypto 24/7 support — tickers ending in "-USD" bypass NYSE market-hours filter
//         (4) Opportunity Cost label clarified in PDF: "profit missed by exiting too early"
//         (5) Winner's Leash PDF text corrected from "7% Trail" → "15% Trail"
// v1.153: Cash Drag solutions + UI improvements
//         (1) Idle Cash Overflow Rule: if masterFund > 40% of portfolio, aggressively deploy
//             excess into highest-scoring open positions (score >= 70) until cash < 15%
//         (2) Money Market Yield: idle cash accrues 4.5% annualized daily yield (SHV/SGOV sim)
//         (3) Results UI redesign: 4 KPI cards + ticker grid always visible; all other sections
//             (equity curve, trades table, truth table, lessons, daily log) collapsed behind
//             "Show More" toggles for a cleaner post-simulation view
//         (4) Resume Running Simulation: persistent floating banner on all pages when a
//             simulation is running — click to return to Trading Lab
// v1.153: Opportunity Cost fix + ZIM Protocol 5-day confirmation
//         (1) Opportunity Cost calculation fixed: now counts profit missed AFTER exit
//             (from exit price to peak after exit), not from entry to peak.
//             Old formula inflated the figure by including profit already captured in the trade.
//             UI figure now matches the PDF audit report.
//         (2) ZIM Protocol confirmation increased from 3 → 5 consecutive days.
//             Audit showed MU exited at $68.37 via 3-day breach but recovered → $335,769 missed.
//             5-day confirmation = a full trading week below Weekly EMA-200 (true structural death).
// v1.153: Cruise Control — Active Parking Lot + Tier-3 Slow Grind
//         (1) Active Parking Lot (QQQ): if masterFund > 40% and no Score 7+ setups,
//             auto-deploy excess cash (down to 10% reserve) into QQQ at 30% allocation.
//             QQQ is the lowest-priority asset — liquidated first when Tier-1 setup fires.
//         (2) Tier-3 Slow Grind: if ticker is above EMA-20/50/200 with positive EMA-50 slope
//             and 2-12% from EMA-50 (neutral zone), AND masterFund > 30% idle, enter with 12%.
//             Exit rule: close below Daily EMA-20 (tight trailing stop, no confirmation).
//         (3) Liquidity Override updated: QQQ Parking Lot and Slow Grind positions are
//             liquidated first (before Near Entry) when a Tier-1 Breakout needs capital.
// v1.153: Anti-Stop Hunt Mechanics
//         (1) EOD-only stops: stop-loss conditions evaluated on daily CLOSE only (not intraday low).
//             Intraday wicks that pierce the stop but recover by close are ignored entirely.
//         (2) ATR-14 dynamic stop placement: stop = (EMA or demand zone) - (1.5 * ATR-14).
//             Adapts to each stock's specific volatility, places stop outside institutional hunting ground.
//         (3) Snap-Back Re-entry Protocol: if a position exits via EMA-20 breakdown, the ticker
//             is added to a 3-day "hot watchlist". If price reclaims EMA-20 within 3 days,
//             execute immediate Tier-1 re-entry (confirmed Bear Trap / Liquidity Grab).
// v1.153: Turbo Cache — Pre-downloaded price data for 5-8x faster simulations
//         (1) price_cache DB table: stores (ticker, date, open, high, low, close, volume) rows.
//         (2) fetchHistoricalPrices() checks DB cache first (< 24h old = fresh, no HTTP call).
//             Falls back to live Yahoo Finance fetch and upserts result to DB.
//         (3) refreshCache, getCacheStatus, downloadCacheCSV tRPC procedures added.
//         (4) Cache Status UI panel: per-ticker status (green/yellow/red), Refresh All button,
//             Download Price Data (CSV) button, estimated speedup indicator.
// v1.153: Million Dollar Performance Leak Fix — Diamond Hands v4.0
//         (1) 4% Hard Support Buffer for ZIM/Core Holdings (replaces Weekly EMA-200 breach exit):
//             - findHorizontalSupport(): scans bars before entry to find the last major resistance
//               level that was broken (old ATH / multi-month consolidation ceiling).
//             - horizontalSupportLevel stored on each core holding position at entry.
//             - Exit ONLY if: Daily Close < (supportLevel * 0.96) for 5 consecutive days.
//             - Diamond Hands mode: ignores RSI divergences, EMA crosses, single-day dips.
//             - Fallback: if no support found, use entryPrice * 0.85 (15% hard stop).
//         (2) Layers 2 (Active Parking Lot + Money Market Yield) and 3 (EOD Stops + Snap-Back)
//             already live from v1.153/v1.153/v1.153 — confirmed active.
//         (3) Cache Status badges in Asset List: per-ticker DB dot (green=fresh, yellow=stale, grey=uncached)
//             "Update Database Now" button pre-downloads 3 years of OHLC data for all tickers.
//             "Download CSV" button exports all cached price data as a CSV file.
// v1.153: QQQ Parking Lot Stop-Loss Fix + UI Opportunity Cost Fix + Knowledge Nav Group
//         (1) QQQ Parking Lot stop-loss changed from EMA-20 (too tight, ~0.2-1% away) to
//             5% fixed stop (entryPrice * 0.95). Eliminates 27 premature stop-outs per sim
//             that caused $1M+ false "Profit Missed" inflation in the UI.
//         (2) UI "Profit missed by exiting early" KPI now EXCLUDES parking_lot and slow_grind
//             formation trades. These are churn trades (QQQ re-enters after stop-out) and
//             should not count as missed opportunity — capital was immediately redeployed.
//         (3) zivFormation field added to labTrades DB table for formation-based filtering.
//         (4) Navigation: "Knowledge" dropdown groups Master JSON, Knowledge Base,
//             Videos, and History under a single collapsible menu item.
// v1.153 (2026-03-07): Momentum Entry Override + Parking Lot EMA-20 exit removed + UI fixes
//         (1) Momentum Entry Override: RSI cap raised to 80, Momentum Breakout exception
//             (ATH/20d-high + Volume >1.2x avg) bypasses RSI entirely; Early Trend exception
//             (EMA-10 cross above EMA-20) bypasses EMA-50 slope requirement.
//         (2) Ziv Score Turbo: +2 bonus for AI/Semiconductor stocks within 5% of 52w high.
//         (3) Parking Lot EMA-20 exit REMOVED — exits only via 5% fixed stop or Liquidity Override.
//         (4) validateTickers now returns longName + sector from Yahoo Finance; 12s per-ticker timeout.
//         (5) Past Simulations section is now collapsible (Show All / Collapse toggle).
//         (6) Navigation: "Analyze" added inside Knowledge dropdown.
// v1.153 (2026-03-08): Multi-Asset Parking Lot + Estimated Capital metric + Sector DB fix
//         (1) Multi-Asset Parking Lot: replaced single QQQ with 10-ETF diversified basket:
//             QQQ 20% + SMH 20% + RSP 15% + SCHD 15% + GLD 10% + XLU 10% + BIL 10% + XLV 5% + TLT 5% + IWM 5%
//             Each ETF enters ONLY when EMA-20 > EMA-50 (trend-following). Stop = 1.5x ATR (max 5%).
//             BIL (T-Bills) always enters regardless of trend (yield accumulation).
//         (2) Estimated Capital live metric: real-time mark-to-market total portfolio value
//             (cash + all open positions at current price) shown in Live Metrics table during simulation.
//         (3) Sector "Custom" fix: validateTickers now saves sector + longName to DB via updateUserAssetMeta.
//             Sectors update automatically when the asset list loads or "Check Status" runs.
// v1.153 (2026-03-08): Parking Lot Lab UI + DB config
//         (1) Parking Lot Lab section added to Trading Lab page — collapsible panel with
//             10-ETF table showing last price, EMA-20, EMA-50, trend status, bar count.
//         (2) "Update Cache" button refreshes 3 years of OHLC data for all basket ETFs.
//         (3) "Download Data" button exports all ETF price history as CSV.
//         (4) "Edit Basket" mode: edit ticker symbols and weights inline; weights auto-normalize to 100%.
//         (5) "Reset Defaults" button restores the default 10-ETF basket.
//         (6) parkingLotConfig DB table stores per-user ETF basket configuration.
// v1.153 (2026-03-08): Sector Custom fix + Spinner fix
//         (1) validateTickers now calls YahooFinance/get_stock_profile in parallel with chart fetch
//             to get real sector from assetProfile.sector (most reliable source).
//         (2) Sector saved to DB even for tickers with no recent price data (valid: false).
//         (3) AssetPicker now runs validateTickers on the DB catalogue (not static ASSET_CATALOGUE)
//             so SEDG/LUNR/OPEN/BABA/U and any custom-added tickers get validated and sector-updated.
//         (4) Status spinner now resolves for all tickers (not just those in the default 30-ticker list).
// v1.153 (2026-03-08): Estimated ROI % live metric added
//         (1) "Estimated ROI %" row added directly below "Estimated Capital" in the metrics table.
//             Calculated as ((estimatedCapital / startingWallet) - 1) * 100, updated live every 10 days.
//             Both rows share the indigo highlight style and update in real-time during simulation.
// v1.153 (2026-03-08): Check Status & Parking Lot Lab computed as of Start Date
//         (1) checkStatus procedure accepts optional asOfDate param. All bars are filtered to
//             <= asOfDate before computing EMA-50, EMA-200, Donchian-20, RSI, Ziv Score.
//             Scores now reflect the market state on the simulation start date, not today.
//         (2) getParkingLotSnapshot accepts optional asOfDate param. Bars after asOfDate are
//             excluded so EMA-20, EMA-50, trend status all reflect the chosen date.
//         (3) UI: checkStatus mutation passes startDate as asOfDate automatically.
//             getParkingLotSnapshot query passes startDate as asOfDate automatically.
//         (4) "as of [date]" badge shown on Check Status button and Parking Lot Lab header.
// v1.153 (2026-03-08): Unchained Momentum Engine — 5 systemic fixes
//         (1) Momentum RSI Decoupling: if price within 5% of 52-week high AND volume > 1.2x avg,
//             entry is MANDATORY even if RSI is 70+. Climax-Buy Guard: RSI > 85 AND ATR > 2x avg
//             = parabolic exhaustion, wait for pullback. Fixes NVDA/PLTR/AVGO $0 deployment.
//         (2) Tier-1 Capital Priority: Parking Lot entry BLOCKED when any Tier-1 ticker has no
//             open position and cash >= 20% of portfolio. Capital reserved for Tier-1 setups.
//             Directly fixes the $18,855 opportunity cost from v1.153 audit.
//         (3) Minimum 3-day Hold Period: SL frozen for first 3 trading days after entry.
//             Emergency override: if close drops > 8% from entry, exit immediately regardless.
//             Fixes all 11 "Tight Exit Errors" from v1.153 audit (all occurred within 1-3 days).
//         (4) ATR Trailing Stop with Ratchet for Parking Lot: 1.5x ATR(14) trailing stop,
//             ratchet mechanism (only moves up, never down). Eliminates QQQ/SMH churn.
//         (5) isMomentumRsiBypass added to fastLongSignal pre-filter so it passes the LLM gate.
// v1.153 (2026-03-08): Fix v1.153 Tier-1 Capital Priority over-block
//         (1) Removed the proactive Parking Lot block that kept 100% of capital in cash
//             when any Tier-1 ticker had no open position. This caused $406 total P&L on $100k
//             because the engine found no Tier-1 setups in a correction market (Feb 2025)
//             and simultaneously blocked all Parking Lot deployment.
//         (2) Reverted to the correct logic: Parking Lot deploys when cash > 40% and no
//             high-conviction positions are open. Capital is returned to Tier-1 trades ONLY
//             when an actual validated setup fires (v1.153 Liquidity Override), not proactively.
//         (3) All other v1.153 improvements preserved: 3-day Min Hold, Momentum RSI Decoupling,
//             ATR Ratchet for Parking Lot.
// v1.153 (2026-03-08): Fix Estimated Capital & Estimated ROI % not updating live
//         Root cause: estimatedCapital was emitted in "progress" SSE events (every 10 days)
//         but the UI only read it from "log" events. Added estimatedCapital + masterFund
//         reads to the "progress" event handler so both values update every 10 trading days.
// v1.153 (2026-03-08): Entry Relaxation — get Tier-1 stocks trading
//         (1) EMA50 Proximity widened: 4% → 8%. High-beta stocks (NVDA, AMZN, COIN) can be
//             10-15% above EMA50 in a healthy bull trend. 4% was blocking all entries.
//         (2) EMA50 Slope block relaxed: now only blocks when price is BELOW EMA50 with flat slope.
//             Previously blocked entries when price was ABOVE EMA50 with flat slope (consolidation),
//             which is a healthy bull setup, not a downtrend.
//         (3) Parking Lot initial SL widened: 1.5x ATR (5% floor) → 2.5x ATR (8% floor).
//             ETFs (SMH/GLD/QQQ) need wider stops. 1.5x caused $184k in missed profits.
// v1.153 (2026-03-08): End of Correction Detection
//         New signal: isEndOfCorrection (score >= 2/3 rules, price > EMA200)
//           Rule 1 — Price Reclaim: price recovered above EMA-20 after being below it
//           Rule 2 — Volume Dry-Up: last 5d avg volume < 0.8x 20d avg (sellers exhausted)
//           Rule 3 — Higher Low Structure: last swing low > previous swing low
//         When active: RSI cap raised to 60 (from 45), EMA50 slope block bypassed,
//         fastLongSignal pre-filter bypassed. Entry allowed at the start of a new uptrend.
// v1.153 (2026-03-08): Fix Red Filter — Tier-1 stocks no longer permanently excluded
//         Change 1: Red threshold raised — only skip when price >15% below EMA200 AND EMA50 slope negative
//                   (old rule blocked NVDA/MU/AMZN/TSM in Feb 2025 correction — 5-10% below EMA200 is NOT a bear market)
//         Change 2: Red non-permanent — daily re-admission check: if price crosses above EMA200,
//                   ticker is re-admitted to simulation and evaluated for entry that same day.
// v1.153 (2026-03-08): Early Parole — Dynamic Red Filter with 2 additional unblock triggers
//         Early Parole A: EMA-20 crosses above EMA-50 while still below EMA-200
//                         → momentum shift detected, re-admit immediately (catches V-shape recovery early)
//         Early Parole B: Daily gain ≥4% with Volume >1.5x avg (Institutional Reversal)
//                         → institutions buying aggressively, re-admit immediately
//         Log distinguishes: EMA-200 CROSS vs EARLY PAROLE A vs EARLY PAROLE B
// v1.153 (2026-03-08): ZIM Protocol v4.1 — EMA-50 Slope Confirmation
//         Problem: ZIM Protocol v4.0 was exiting on temporary pullbacks (MU April 2025: $301,530 missed)
//         Fix: Before counting a support breach day, check if EMA-50 slope is NEGATIVE.
//         If EMA-50 is still rising (positive slope), the breach is a temporary stop-hunt — reset counter, hold.
//         Only accumulate breach days when BOTH: price < support floor AND EMA-50 slope <= 0.
//         This prevents exiting MU/NVDA/ALAB during institutional accumulation dips.
// v1.153 (2026-03-08): Allow up to 30 assets in simulation
//         Raised maxSelect from 10 to 30 in AssetPicker (TradingLab UI)
//         Raised server-side zod validation from max(10) to max(30) for tickers array
// v1.153 (2026-03-08): Risk Management Overrides — 4 systemic fixes
//         (1) Final Order Mode: 2 → 4 consecutive closes below EMA-20, AND EMA-20 slope must be negative.
//             If EMA-20 still rising (consolidation), reset counter and hold. Fixes $62,805 premature exits.
//         (2) Catastrophe Stop: intraday circuit breaker — if bar.low drops >10% below daily open
//             OR bar.low drops >2x ATR below the designated SL, execute immediate market sell.
//             Overrides the EOD-only rule for extreme gap-down / flash-crash scenarios.
//         (3) Position Sizing: 3% Max Portfolio Risk Per Trade.
//             positionSize = (totalCapital * 0.03) / stopDistancePct. Caps allocation so if SL is hit,
//             master fund loses no more than 3%. Prevents PLTR-style -29.83% single-trade drawdowns.
//         (4) Anti-Churn Cool-off: 2-Strike 5-Day Penalty Box per ticker.
//             If a ticker hits SL twice within 14 calendar days, it enters a mandatory 5-day penalty box.
//             No new long entries allowed during penalty. Prevents NVDA-style 7-trade churn (net negative).
// v1.153 (2026-03-08): Monthly Yield Realized P&L Fix
//         (1) Monthly Yield now shows REALIZED P&L only (closed trades that exited in that month)
//             Previously showed MTM portfolio change — caused -24.1% in March 2025 due to ZIM/NVDA
//             open position drawdowns (unrealized losses from the Feb-March 2025 market correction).
//         (2) New MTM Δ column added alongside Realized column for context.
//             MTM shows portfolio value change (cash + open positions at market price).
//             Realized shows only closed-trade P&L — the true measure of monthly performance.
export const SYSTEM_CODE_VERSION = "v14.04";
// v12.11 (2026-05-17): S3 Price Cache — survives deploys, 4-layer loading (memory→file→S3→DB)
//         Update Database now uploads all prices to S3 as persistent JSON.
//         Simulation loads: memory (instant) → local file (50ms) → S3 (1-3s) → DB (slow fallback).
//         After first "Update Database", all subsequent deploys load from S3 in seconds, not minutes.
// v12.10 (2026-05-17): Momentum Engine Architecture Fixes — 3 Critical Filters Rewritten
//         ROOT CAUSE: Sim 10.005 analysis revealed INTC (+149%), SNDK (+135%), MRVL (+129%),
//         AMD (+109%) were ALL missed due to overly restrictive filters penalizing momentum.
//
//         FIX 1: Weekly Resurrection Routine
//           Problem: Tickers filtered out at start (EMA-50 flat) were NEVER re-scanned.
//           Fix: Every 5 trading days, blind unfiltered check on ALL originalTickers.
//           If price > EMA-50 (slope+) OR price > EMA-20 (slope+) + above EMA-200 → resurrect.
//           Adds to MANDATORY_CORE for immediate scanning.
//
//         FIX 2: Decouple Trend from Momentum (Primary Trend Filter)
//           Problem: Flat EMA-50 slope blocked entry even when momentum was building.
//           Fix: Flat EMA-50 is NO LONGER a disqualifier if:
//             - Price > EMA-20 AND EMA-20 slope positive AND price > EMA-200
//           EMA-20 detects momentum 2-3 weeks before EMA-50 turns positive.
//
//         FIX 3: Breakout Exemption in ZivScore (Synth Scan)
//           Problem: AMD triggered 22 Donchian breakouts but Synth Scan said "No Setup"
//           because RSI was high and price was extended from EMA-50.
//           Fix: If Donchian Breakout (20-day high) + price > EMA-20 (slope+) + above EMA-200:
//             - IGNORE RSI "overbought" penalty
//             - IGNORE "extended from EMA-50" penalty
//             - synthIsBull = true (momentum override)
//
//         FIX 4: Bad Tick Protection (Hard Circuit Breaker)
//           Problem: SBUX exited at +2.13%, NXPI at -4.8% via Hard Circuit Breaker
//           because API returned price 0/null for one bar → P&L appeared as -100%.
//           Fix: Skip bar if close <= 0 or dropped 80%+ from previous day (bad data).
// v12.06 (2026-03-15): Portfolio Concentration Cap + Daily Tier-1 Throttle + Alpha Attack Fix
//         ROOT CAUSE: On election day (11/6/2024), 4+ Tier-1 breakouts fired simultaneously.
//         Each used Liquidity Override to free capital, allowing 90%+ of portfolio in 4 positions.
//         When April 2025 tariff crash hit, all positions dropped together causing catastrophic loss.
//
//         FIX 1: Portfolio Concentration Cap (MAX_PORTFOLIO_DEPLOYED_FRAC = 0.75)
//           Block new entries when total deployed capital >= 75% of totalCapital.
//           deployedCapital = totalCapital - masterFund.
//           If deployedCapital / totalCapital >= 0.75 -> skip entry, log PORTFOLIO_CAP_BLOCK.
//           Tier-1 breakouts get slightly higher cap (80%) to preserve best opportunities.
//           This prevents 90%+ concentration seen on election day.
//
//         FIX 2: Daily Tier-1 Throttle (MAX_DAILY_TIER1_ENTRIES = 3)
//           Track dailyTier1Count per trading day. Reset at start of each day.
//           If dailyTier1Count >= 3 -> skip Tier-1 entry, log DAILY_TIER1_THROTTLE.
//           Prevents 7+ simultaneous entries on a single day (election day rally).
//
//         FIX 3: Alpha Attack Boost Bug Fix
//           allocationFraction was set as const BEFORE the Alpha Attack boost at line 4643.
//           Boost modified baseAllocationFraction but targetAllocation used old allocationFraction.
//           Fix: update allocationFraction after the boost so the 55% cap is actually applied.
// v1.153 (2026-03-09): Comprehensive Strategy Engine Overhaul — 12 systematic failures fixed
//         (1) F1-A: LLM rescan cooldown reduced from 21 → 3 days in confirmed bull trend
//         (2) F1-B: LLM prompt default-long bias — in bull trend, default stance is LONG
//         (3) F1-C: Medium confidence accepted in confirmed bull trend (no activeTraderMode required)
//         (4) F1-D/F3-C: Donchian-20 breakout bypasses LLM and Primary Trend Filter entirely
//         (5) F2-A: Cold Strategy RSI exit raised 60 → 80 (RSI 60 exits too early in recovery)
//         (6) F2-B: Cold Strategy 2-day RSI confirmation before exit (no single-spike exits)
//         (7) F2-C: Cold Strategy trailing stop — +10% profit → break-even, +15% → trail 10% below peak
//         (8) F3-A: Bear Market Recovery Exception — price > EMA200×1.02 + RSI<50 + green day = allow Long
//         (9) F3-B: EMA-50 slope lookback 10 → 5 bars in main loop (turns positive 2 weeks earlier)
//         (10) F4/F5: Proximity rescan gate widened 2.5% → 8%, price-skip bypassed in bull trend
//         (11) F7: LLM meetsEntryCriteria=false no longer hard-blocks long entries in bull trend
//         (12) F8: Synthetic entry zone when LLM returns N/A (ATR×2 SL, 2.5R TP)
//         (13) F8-A: Cache version key updated to v1.153 — invalidates all old LLM scan cache entries
//         (14) Cold Strategy rebalanced: RSI entry 35→30, max positions 3→2, max days 63→30, SL 15→10%, TP 15→12%
// v1.153 (2026-03-08): Diamond Hands Deepening — 3 exit rule relaxations from 14-month audit
//         (1) ZIM Protocol confirmation: 5 → 7 consecutive days below support floor + EMA-50 declining.
//             Audit showed MU missed $167,856 after a 5-day breach that recovered. 7 days = 1.5 weeks
//             of sustained structural weakness, not a temporary dip.
//         (2) FOM Winner's Leash: 20% → 25% trailing stop from peak (0.80 → 0.75).
//             GE exited at -4.6% after a 22% pullback from peak, then rose +28%. 25% leash keeps it.
//             Elephant positions (ROI > 100%) remain at 25% (unchanged).
//         (3) ZIM Protocol support buffer: 12% → 15% below horizontal support floor (0.88 → 0.85).
//             Gives Core Holdings more room before structural exit fires.
// v1.153 (2026-03-08): Raised server-side tickers max to 100 + Edit/Delete visibility fix
//         (1) getCacheStatus/refreshCache/downloadCacheCSV max raised from 50 → 100 tickers
//         (2) overflow-x-auto + min-w-[420px] added to each Asset List table half
// v1.153 (2026-03-08): Raised server-side tickers max to 100 (catalogue had 62 tickers, exceeded 60 limit)
// v1.153 (2026-03-08): Server-side 60-ticker validation fix
//         Raised z.array(z.string()).max(30) → max(60) in both scanTickers and checkStatus procedures
//         Fixes: "Too big: expected array to have <=30 items" error when running Check Status or Scan with 60 tickers
// v1.153 (2026-03-08): Asset List Migration + Layout Fix
//         (1) Added CATALOGUE_VERSION=2: when version changes, DB is reset to new 60-ticker catalogue
//             Fixes the issue where old 30-ticker DB list was used instead of new catalogue
//         (2) Sector column hidden on <lg screens, Company hidden on <2xl screens
//             Actions column (edit/delete) now always visible at all screen sizes
//         (3) 2-column split triggers at lg (1024px) instead of xl (1280px)
// v1.153 (2026-03-08): Asset List Refresh + Layout Fix
//         (1) Replaced 10 low-performing tickers (SEDG, KLAC, FRAF, SMR, OPEN, BABA, U, BBAI, RXRX, JOBY)
//             with top performers from last 12 months: SOFI, CELH, NRG, DUOL, TTD, AFRM, DDOG, NET, SNOW, SHOP
//         (2) 2-column table layout fixed: Company column hidden on non-XL screens, Sector always visible
//             All columns now fit without horizontal scroll on standard 1920px monitors
// v1.153 (2026-03-08): Asset List Expansion to 60 Tickers
//         (1) Added 30 new high-performing tickers from 2025-2026: CRWD, HIMS, RDDT, RKLB, PLTR,
//             HOOD, IONQ, MSTR, SMCI, COIN, SOFI, UPST, AFRM, CELH, DKNG, DUOL, GTLB, MNDY,
//             NET, PANW, SNOW, SPOT, TMDX, TTD, UBER, VEEV, WDAY, ZS, DDOG, ABNB
//         (2) maxSelect raised from 30 to 60 — users can now run simulations with up to 60 tickers
//         (3) Asset List table now displays in 2-column side-by-side layout (XL+ screens)
//             Left column: tickers 1-30, Right column: tickers 31-60
// v1.153 (2026-03-08): Equity Curve Fix — smooth daily mark-to-market graph
//         Root cause 1: equityCurve.push() was only called on trade exits and Partial TP hits.
//           Long quiet periods (no trades) showed as flat lines on the graph.
//           Fix: add daily mark-to-market snapshot (cash + open positions at current price) every trading day.
//         Root cause 2: Multiple simulations accumulated on the same chart (X-axis mixing 2025 and 2026).
//           Fix: deduplicate equityCurve by date (keep last value per date) and sort ascending before returning.
//         Root cause 3: XAxis interval="preserveStartEnd" caused crowded/wrong labels with many data points.
//           Fix: interval = Math.floor(chartData.length / 8) to show ~8 evenly spaced ticks.
// v1.153 (2026-03-08): Audit v1.153 Systemic Fixes — 3 critical patches
//         Root cause analysis: parsed all 44 trades from the audit PDF, found 2 systemic failures:
//         (1) SEDG -$4,989: Pyramid Scale-In sent $23K into RSI=80 position that reversed immediately.
//             Fix: RSI Overbought Capital Cap — when RSI > 75, cap Pyramid Scale-In to 15% of totalCapital.
//             Core Holdings (ZIM Protocol) are exempt from this cap.
//         (2) META #28 -$805: entered via Proximity Rule but EMA50 slope was -2.52 (falling).
//             Fix: EMA50 Slope Guard for Proximity Entry — block entry if EMA50 slope < 0 AND
//             entry is purely proximity-based (not a breakout, not oversold, not a core holding).
//         (3) FOM Winner's Leash EMA-200 Guard extended to protect positions with <15% unrealized gain.
//             Previously only protected loss positions (unrealizedPct < 0).
//             Now also protects small-gain positions (unrealizedPct < 0.15) when price is above EMA-200.
// v1.153 (2026-03-08): Fix Final Yield in Monthly Yield panel
//         Root cause: Final Yield used liveWallet (updates every 20 days via SSE) → stale/wrong during simulation.
//         Fix: Final Yield = compound product of all displayYields monthly returns.
//         e.g. June+53.6% × July+15.3% × Aug+2.3% × Sep+22.3% × Oct+31.7% = +191% cumulative (not +4.5%).
// v1.153 (2026-03-08): Two UI fixes
//         (1) Monthly Yield panel resets (setLiveMonthlyYields([])) when a new simulation starts.
//         (2) Performance Metrics uses activeSim.finalWallet/monkeyValue as fallback when live state is null.
// v1.153 (2026-03-08): Dynamic MANDATORY_CORE + Winner's Leash 25% for Elephants
//         (1) MANDATORY_CORE is now rebuilt EVERY DAY from tickers with Ziv score >= 6.
//             Score 9-10: at/above Donchian-20 high (Tier-1 breakout)
//             Score 7-8: within 5% of EMA-50 in bullish trend (Pullback Setup)
//             Score 6: above EMA-200 with positive EMA-50 slope (Watchlist)
//             Score 1-5: below EMA-200 or negative slope (NOT in MANDATORY_CORE)
//             ZIM and MU are permanent Core Holdings (always in MANDATORY_CORE).
//             This fixes AVGO/NVDA/PLTR generating 0 trades: they now get mandatory 5-day scans
//             when they are in a bullish trend (score >= 6), not just when RSI < 35.
//         (2) Winner's Leash 25% for Elephant positions (ROI > 100%).
//             MU at +8000% was exiting on normal 20% pullbacks. 25% gives more breathing room.
//             leashPct: isElephant ? 0.75 : (finalOrderMode ? 0.80 : 0.85)
// v1.153 (2026-03-08): RIDE THE ELEPHANT — Momentum Capital Concentration
//   (1) Momentum Multiplier: proven tickers (cumulative ROI > 30%) get 2x allocation (up to 60% of masterFund)
//   (2) Idle Capital Redeployment: dead tickers freed after 10 days (was 30) — capital flows to elephants
//   (3) Momentum Re-Entry: permanently blocked tickers (2099) un-blocked when they break 20-day high with 1.5x volume
//   (4) tickerRealizedRoi + tickerRealizedProfit tracking maps added
//   (5) momentumReEntryEligible set: tickers with >30% cumulative ROI bypass 2-exit block on breakout
// v1.153 (2026-03-08): Simulation Performance — Pre-computed Indicator Index
//         (1) DayIndicators precomp table: built ONCE before the daily loop for all tickers.
//             Stores EMA-20/50/200, RSI-14, ATR-14, high52w, OHLCV per (ticker, dayIdx).
//             Access is O(1) via getPrecomp(ticker, dayIdx) — eliminates O(n²) recalculations.
//         (2) Replaced 20+ getBarsUpTo+calcEMA/calcRSI calls inside the daily loop with precomp lookups.
//             Estimated speedup: 3-5x for 30-ticker simulations over 2-year periods.
//         (3) LLM_RESCAN_COOLDOWN raised from 3 to 7 days — halves LLM API calls.
//         (4) Price-level cache: skip LLM rescan if price moved < 1% since last scan.
//         (5) getBarIdxUpTo + getClosesSlice helpers: avoid double binary search and array allocation.
// v1.153 (2026-03-08): Three engine improvements from v1.153 audit
//         (1) Early Recovery Mode: allow long entry when Price > EMA200 AND EMA50 slope > 0,
//             even if Price < EMA50. Catches stocks in early recovery phase.
//         (2) Dynamic ATR-14 SL: SL = entry - 1.5×ATR(14) as PRIMARY stop loss for all Long
//             entries (not JoinTheMove). Replaces fixed % SL. Cap: max 20% from price.
//         (3) Winner's Leash 20% for Final Order Mode: widened from 15% to 20%.
// v1.153 (2026-03-08): Parking Lot 10% cap + missed stocks fix
//         (1) Parking Lot total allocation capped at 10% of totalCapital (was per-ETF weights).
//         (2) Fast pre-filter expanded: longSignal now triggers when price > EMA200 AND
//             EMA50 slope positive (catches extended bull-trend stocks like TSLA/GOOGL/PLTR).
//         (3) Momentum Rescan Trigger: allows Early Recovery Mode stocks (price slightly below EMA50).
// v1.153 (2026-03-08): Auto-liquidate Parking Lot on Tier-1 signal
//         When a Tier-1 (non-parking-lot, non-slow-grind) position opens, ALL parking lot
//         positions are immediately closed at current price and capital returned to masterFund.
//         Each liquidation is logged with P&L and reason "Tier-1 signal opened".
// v1.153 (2026-03-08): Fix $791K premature exits — EMA-50 5-day exit for Final Order Mode
//         Final Order Mode exit changed from EMA-20 (4-day) to EMA-50 (5-day).
//         EMA-50 slope guard: only counts breach days when EMA-50 slope is also negative.
//         Prevents premature exits on normal volatility (TSLA, ALAB, U, SEDG).
// v1.153 (2026-03-08): Simulation speed optimization — batch parallel LLM calls
//         (1) All LLM calls per day collected first, then run via Promise.all (parallel).
//             Estimated speedup: 5x for 30-ticker simulations (14min → 2-3min).
//         (2) LLM_RESCAN_COOLDOWN raised from 14 to 21 days (reduces calls by ~33%).
//         (3) LLM_PRICE_SKIP_THRESHOLD raised from 2% to 3%.
//         (4) Mandatory Core Scan interval raised from 3 to 5 days.
// v1.153 (2026-03-08): Fix $660K missed profit — Catastrophe Stop tiered thresholds
//         Core Holdings (ZIM Protocol): catastrophe stop raised from 10% to 20% intraday drop.
//         Final Order Mode: catastrophe stop raised from 10% to 15% intraday drop.
//         Core Holdings: 2×ATR check removed — exit only via ZIM Protocol structural death.
// v1.153 (2026-03-08): Cold Strategy — RSI mean-reversion for dead months
//         When no Tier-1 positions active AND >50% cash, deploy up to 3 Cold Strategy positions
//         (5% each) on stocks with RSI(14) < 30 AND price > EMA200.
//         Exit: RSI > 55, +3% profit, 5 days max, -4% SL, or Tier-1 signal fires.
// v1.153 (2026-03-08): Full codebase audit + O(1) precomp refactor
//         Added donchian20High to DayIndicators precomp table.
//         Replaced 6 duplicate getBarsUpTo calls in entry attempt pass with O(1) lookups.
//         Estimated additional speedup: 15-20% on top of v1.153.
// v1.153 (2026-03-08): DB audit + bulk price loading + LLM scan cache
//         (1) 4 new DB indexes: labTrades(simulationId), labTrades(ticker),
//             labDailyLogs(simulationId), labDailyLogs(date).
//         (2) getBulkCachedPrices(): single DB query for ALL tickers (replaces N separate queries).
//         (3) LLM scan cache: results stored in llmScanCache table by (ticker, date, priceKey).
//             Second simulation run on same period: 60-80% faster (no LLM calls for cached setups).
// v1.153 (2026-03-08): Fix dead months — EMA50 Slope Guard + Cold Strategy RSI expansion
//         (1) Final Order Mode EMA50 Slope Guard: downgrade to Standard mode when EMA50
//             slope < -2 AND RSI >= 38. Prevents wrong-direction entries (CAT/AMZN/COIN Jan-Feb 2025).
//             Exception: Core Holdings always Final Order Mode. Exception: RSI < 38 (oversold OK).
//         (2) Cold Strategy RSI entry raised from 30 to 35 — RSI<30 too rare, misses dead months.
// v1.153 (2026-03-08): Re-Entry Mechanisms + Comprehensive Diagnostic Logs
//         (1) Tight Exit Re-Entry: when a Tight Exit Error is detected (+5% within 10 days after exit)
//             and the ticker was permanently blocked (2099-12-31 cooldown), un-block it with a
//             5-day cooldown and reset exit count to 1. Stock proved it was still in an uptrend.
//             Addresses 12 Tight Exit Errors (QUBT +59%, PLTR +16.7%, ALAB +29.8%, etc.).
//         (2) EXIT_DIAGNOSIS log: after every position close, emit a detailed log entry explaining
//             which rule triggered the exit and what the price did 5/10/20 days after.
//             Includes TIGHT EXIT warning when stock is 5%+ higher 10 days later.
//         (3) MONTHLY_SUMMARY log: at end of each month, emit a summary with yield %, P&L,
//             entry/exit counts, win/loss ratio. Dead months (<1% yield) get a diagnostic
//             message listing possible causes (cooldowns, EMA50 slope guard, no RSI<35 stocks).
// v1.153 (2026-03-08): Audit-Driven Improvements — Fix $240K Opportunity Cost
//         (1) Cold Strategy TP raised from 3% to 8% — stocks continue 7-30% after 3% exit
//             (PLTR +16.7%, RKLB +16.1%, QUBT +59% in audit). Max days raised 5→10.
//             RSI exit raised from 55 to 62 — let winners run longer.
//         (2) Final Order Mode Winner's Leash widened from 20% to 25% — COIN exited at
//             15% drawdown and continued higher; 25% gives more room on high-conviction trades.
//         (3) Phoenix Re-Entry RSI threshold lowered from 40 to 35 — MU was at RSI~38
//             when it should have re-entered after ZIM Protocol exit ($122K missed).
//         (4) UI: Pre-Trade Scan Report collapsed by default (summary chips only),
//             "Show All" button to expand. Reduces visual noise before simulation.
//         (5) UI FIX: Post-simulation "Profit missed by exiting early" now uses activeSim.profitMissed
//             (same source as live badge and logs) instead of per-trade opportunityCost sum.
//             Both numbers now match exactly — single source of truth.
// v1.153 (2026-03-08): Audit v1.153 Fixes — FOM EMA-200 Guard + Cold Strategy SL + Phoenix Re-Entry
//         (1) FOM EMA-200 Guard: Final Order Mode will NOT exit via Winner's Leash if price is
//             above EMA-200 AND position is at a loss. Audit: LUNR, COIN, BIDU, TSM, AVGO, CAT
//             all exited FOM at a loss while structurally healthy — $74,661 missed.
//         (2) Cold Strategy SL widened from 4% to 10% — mean-reversion needs room to breathe.
//             QUBT: 4% SL hit at $6.41, then +59% recovery. 10% SL would have held through the dip.
//         (3) Phoenix Re-Entry now arms after FIRST ZIM Protocol exit (not just 2nd).
//             Previously only armed on newExitCount >= 2, so MU's first ZIM exit got a short
//             cooldown and re-entered via regular scan — missing the optimal Phoenix re-entry window.
//         (4) UI: Engine version badge added to each Past Simulations row for easy comparison.
// v1.153 (2026-03-08): Live Monthly Yield Display + Live Wallet Explanation
//         (1) Monthly Yield panel now shows LIVE data during simulation — each month's yield
//             is emitted as a SSE event at the end of the calendar month (mark-to-market).
//             Panel shows "LIVE" badge during simulation and updates in real-time.
//             Each row shows both % yield and absolute $ gain/loss for the month.
//         (2) Post-simulation: falls back to equity-curve-computed monthly yields (unchanged).
//         (3) Live wallet estimate ($500K→$400K discrepancy): this is correct behavior —
//             the live badge shows mark-to-market value including open positions at current price.
//             When MU was at its peak ($370+), the live estimate was $500K. After the simulation
//             ends and positions are closed at the final price, the wallet settles at $400K.
//             This is NOT a bug — it reflects real portfolio fluctuation during the period.
// v1.153 (2026-03-08): Ride the Elephant — Momentum Capital Concentration
//         (1) Momentum Multiplier: proven tickers (cumulative ROI > 30% + 1 prior exit) get 2x
//             allocation on next entry (up to 60% of masterFund). Parasitic capital on winners.
//         (2) Idle Capital freed after 10 days (was 30) — dead tickers release capital faster
//             to the active elephants (MU, ZIM, ALAB, NVDA).
//         (3) Momentum Re-Entry: permanently blocked tickers (cooldown=2099) un-blocked when
//             they break 20-day high with 1.5x volume — PLTR, ALAB, AVGO get second chances.
// v1.153 (2026-03-08): 10 Critical Fixes — Targeting 30% Monthly Yield
//         (1) FIX 1: Momentum Multiplier bug — now requires tickerPriorExits >= 1 (not just ROI>30%).
//             COIN got 2x allocation on its FIRST trade (no history) → lost on $16K position.
//         (2) FIX 2: Cold Strategy IMMUNE to catastrophe stop. Mean-reversion needs room to breathe.
//             QUBT: catastrophe_stop fired at -28.6% from open. Cold Strategy uses its own -10% SL.
//         (3) FIX 4: ZIM Protocol buffer widened from 8% to 12% below support floor.
//             MU April 2025 correction was market-wide (tariffs), not structural death.
//             Only TRUE collapses (>12% below support + EMA-50 declining 5 days) trigger exit.
//         (4) FIX 5: FOMO Re-Entry changed from 5-day to 3-day high for faster re-entry.
//             Momentum stocks break out fast — 5-day window missed first 2 days of the move.
//         (5) FIX 7: Pyramid Scale-In — conviction threshold lowered 65→55, cap raised 80%→90%,
//             top-up per day raised 20%→30% of totalCapital. Conviction Top-Up now fires more often.
//         (6) FIX 8: Cold Strategy volume filter — require volume > 0.8x 20-day average.
//             Prevents entering SEDG/FRAF-type dead stocks with collapsing volume.
//         (7) FIX 9: Default tickers updated — replaced 10 dead tickers (SEDG, FRAF, KLAC, RKLB,
//             RDDT, SPOT, SMR, OPEN, BABA, TSLA) with active momentum tickers:
//             MSTR, HOOD, IONQ, CRWD + kept AVGO, MU, NVDA, ALAB, PLTR, META, GOOGL, MSFT.
// v1.153 (2026-03-08): CRITICAL BUG FIXES (Audit v1.153)
//         (1) FIX 1: Winner's Leash hardcoded 15% — audit showed $66,208 opportunity cost from
//             the 15% value being used instead of the intended 25%/20%. Now: FOM=20%, standard=15%.
//             The 0.75 (25%) multiplier from v1.153 was overriding the correct 0.80 (20%) value.
//         (2) FIX 2: Broken position sizing — COIN lost -235.89% on a single trade, violating
//             the 3% max portfolio risk rule. Root cause: capital-based formula could over-allocate
//             when stop distance was small. NEW: shares-based formula:
//             maxShares = (totalCapital * 0.03) / (entryPrice - stopLoss)
//             maxCapital = maxShares * entryPrice
//             This GUARANTEES max loss = 3% of portfolio if SL is hit, regardless of SL width.
// v1.153 (2026-03-09): Market Regime Filter + Reverted Cooldown Protocol
//         (1) REVERTED Ziv Cooldown Protocol (v1.152 Patch 2) — no blacklist for losing tickers.
//             System continues to take valid setups regardless of past performance.
//             Restored 10-day cooldown after 3 consecutive losses (v1.150 FIX 6 baseline).
//         (2) Market Regime Filter — QQQ EMA-20 Defensive Mode (position management):
//             Trigger: QQQ daily close drops below EMA-20 → Defensive Mode ON.
//             Execution: tighten Winner's Leash on ALL open longs to 8% from peak immediately.
//                        Close any position already ≥8% below its peak at market close.
//             Recovery: QQQ closes back above EMA-20 → Defensive Mode OFF, leash restored.
//             Log: "🛡️ QQQ_DEFENSIVE_MODE ON/OFF"
//         (3) Dynamic Re-injection (v1.152 Patch 1) retained:
//             zivBlocked tickers re-evaluated daily; re-injected when Ziv Score >= 6.
// v1.153 (2026-03-09): Partial Profit Lock + Target Alpha Engine
//         (1) Partial Profit Lock: when a Final Order Mode position reaches 50%+ unrealized gain
//             AND represents 15%+ of portfolio, automatically sell 40% at market close.
//             Remaining 60% continues with tightened 8% Winner's Leash from peak.
//             Prevents $201K+ paper-profit evaporation (December 2025 audit).
//         (2) Target Alpha Engine: daily computation of alphaGap = portfolioROI - monkeyROI.
//             SAFE_HAVEN mode (alphaGap >= targetAlpha): tighten leash to 8%, raise Suitability min to 7.
//             ALPHA_ATTACK mode (alphaGap < targetAlpha): Tier-1 up to 55%, Suitability min 6.
//         (3) Liquidity Hierarchy: when capital needed for high-alpha trade, liquidate positions
//             with negative alpha (underperforming monkey) first.
//         (4) UI: targetAlphaMonthly and partialLockGainThreshold inputs added to Trading Lab.
// v1.153 (2026-03-09): Trade Manager enhancements + Decimal Ziv Scores
//         (1) Ziv Score now decimal (e.g. 8.47, 9.23) — sub-scores from RSI, volume, EMA proximity.
//         (2) Trade Manager: Live badge (minutes since refresh), hourly auto-refresh.
//         (3) Signal change toast: fires when HOLD → EXIT detected after analysis.
//         (4) Find Replacements: scans 60 catalogue assets, shows Top-5 ≥9.00 vs Bottom-5 holdings.
// v1.153 (2026-03-09): Volume Gate + Retest Entry + Entry Trigger Gate
//         (1) Volume Gate on Donchian Breakout: requires volume >= 1.5x 20-day avg.
//             Filters false breakouts (low-volume fakeouts). NVDA 4x re-entry pattern eliminated.
//         (2) Retest Entry (new Tier-2 strategy): after a volume-confirmed breakout, tracks the
//             breakoutLevel. When price returns to ±3% zone, enters with Tier-2 allocation.
//             Stop: 3% below breakoutLevel. Target: 10% above breakoutLevel.
//         (3) Entry Trigger Gate for Bull Trend Pullback: requires at least one of:
//             (a) Donchian-20 breakout, (b) EMA-10 cross above EMA-20, (c) RSI < 40 with bounce.
//             Eliminates "gray zone" entries like NVDA's 4 consecutive losses in Jan-Feb 2026.
//         (4) Retest Watchlist in Trade Manager: scans catalogue for confirmed breakouts (last 30d),
//             shows IN_ZONE / APPROACHING / ABOVE_ZONE signals with retest zone price range.
// v1.153 (2026-03-09): Ziv Engine Patches — Dynamic Re-injection + Cooldown Protocol
//         (1) PATCH 1 — Dynamic Re-injection (NVDA/AAPL/MSFT Blindspot Fix):
//             zivBlocked tickers (score < minZivScore at start) are no longer permanently excluded.
//             Each day, the engine re-evaluates their Ziv Score from precomp (O(1)).
//             If score recovers to >= 6 (Watchlist+), the ticker is dynamically re-injected.
//             Log: "🟢 ZIV_RECOVERY: NVDA re-injected on 2023-06-15 — Ziv Score 7.2"
//         (2) PATCH 2 — Ziv Cooldown Protocol (V/MRVL Churn Fix):
//             After 3 consecutive realized losses, ticker enters 60-trading-day penalty box.
//             (was: 10-day cooldown from v1.153 FIX 6)
//             During penalty box: excluded from MANDATORY_CORE even if Ziv Score >= 6.
//             Prevents "death by a thousand cuts" on choppy tickers (V: $1,666 → $0.67).
//             Log: "🚫 ZIV_PENALTY_BOX: V — 60-trading-day ban until 2024-05-15"
// v1.153 (2026-03-09): Full 2-Year Audit Fix — 6 critical improvements
//         (1) Winner's Leash tightened from 25% to 18% in Final Order Mode — captures more profit
//             before drawdown. Addresses $4.4M opportunity cost in 2-year simulation.
//         (2) Snowball Cap lowered from 25% to 20% of totalCapital — prevents NRG-style
//             over-concentration ($36K = 36% of portfolio in a falling market).
//         (3) Bear Market Filter: when QQQ is below its EMA-50, Defensive Mode activates.
//             Only tickers with RSI >= 55, above EMA-200, positive EMA-50 slope, and within
//             3% of EMA-50 are allowed. Max allocation capped at 15% of totalCapital.
//         (4) ZIM Protocol Score Gate: coreHoldingMode only for tickers meeting Defensive Mode
//             quality criteria. Prevents low-quality tickers from getting structural hold treatment.
//         (5) Tight Exit Error SL cap: cumulative SL widening capped at 10% (was unbounded).
//             Prevents NVDA-style +8% SL widening that still resulted in losses.
//         (6) Re-entry Cooldown: after 3 consecutive losses on same ticker, 10-day cooling period.
//             Resets loss counter after cooldown applied. Prevents repeated entries into losing patterns.
// v1.180 (2026-03-11): Max Single Position % + Triple Simulation Download Reports
//         (1) Max Single Position %: New parameter (default 20%) caps any single position size.
//             Applied as a hard cap in the simulation engine — overrides ZIM Protocol's 90% allocation.
//             Prevents $187K→$81K drawdowns when ZIM drops 20% with 90% concentration.
//             UI: Slider in Trading Lab (5%-100%), stored in localStorage (sim_maxSinglePos).
//         (2) Triple Simulation now passes maxSinglePositionPct to all 3 parallel simulations.
//             Each Risk Level (1/5/10) respects the same position size cap.
//         (3) Download Report button added to each Triple Simulation panel.
//             Appears below each panel after simulation completes.
//             Downloads full CSV report (daily logs + individual trades) via tRPC.
// v1.181 (2026-03-11): Triple Simulation Performance + Stuck Simulation Fix
//         (1) Shared Scan: Triple Simulation now runs ONE scan instead of 3.
//             Uses forkSimulation procedure to create 3 simulations from shared scanReport.
//             Eliminates 2x redundant price fetches + LLM scans. Scan time: 3x faster.
//         (2) Sequential Execution: Simulations now run one after another (not in parallel).
//             Node.js is single-threaded — 3 parallel CPU-heavy loops block each other and hang.
//             Sequential execution prevents the 1m+ stuck state seen with 6-year simulations.
//         (3) SSE Heartbeat: Added 15-second heartbeat to prevent proxy timeout.
//             Without this, 6-year simulations (60+ seconds without events) caused connection drops.
//         (4) O(1) QQQ Index Lookup: Pre-built qqqBarIndexMap eliminates O(N) findIndex every day.
//             For 6 years (1500 days) × 1500 QQQ bars = 2.25M comparisons eliminated.
//         (5) Event Loop Yield: Added setImmediate every 50 days to allow SSE writes to flush.
//             Without this, Node.js blocks SSE writes during CPU-heavy simulation loops.
// v1.182 (2026-03-11): Monthly MTM Table Redesign
//         Replaced cramped inline format "+11.8% MTM +59.8%" with clean 3-column table:
//         Month | Monthly % | Cumulative %
//         - Monthly column: color-coded green/red (MTM change %)
//         - Cumulative column: running total from initial capital (blue/orange)
//         - Alternating row shading for readability
//         - Scrollable up to 180px height for long simulations
// v1.183 (2026-03-11): Fix ROI Calculation in Triple Simulation
//         BUG: capitalsMap was hardcoded to $10,000 per ticker regardless of totalWallet.
//         With 60 tickers: totalCapital = 60 × $10K = $600K (not $100K).
//         ROI was calculated on $600K base → showed +503% instead of correct +3,518%.
//         FIX: capitalsMap now uses totalWallet / selectedTickers.length per ticker.
//         Example: $100K / 60 tickers = $1,667/ticker → totalCapital = $100K (correct).
// v1.184 (2026-03-11): Triple Simulation Fixes
//         1. PARALLEL execution restored (Promise.all) — was sequential in v1.181 (too slow).
//            SSE heartbeat (15s) prevents proxy timeout during long parallel runs.
//         2. Live Portfolio ROI now uses estimatedCapital (cash + open position MTM)
//            instead of liveWallet (cash only) — shows true portfolio value during simulation.
//         3. Monthly Performance table now has 4 columns: Month | Monthly% | Cumul.% | Wallet$
//            Wallet column shows total portfolio value (MTM) at end of each month.
//         4. Risk Level differentiation strengthened:
//            ZIM confirmation: 12→3 days (was 10→4)
//            Stop loss: 5→18% (was 7→15%)
//            Winner's leash: 10→30% (was 12→25%)
//            Tier multiplier: 0.4→2.0x (was 0.5→1.5x)
//            Max single position: 12→35% auto-scaled (was fixed 20% regardless of risk)

// v12.08 (2026-05-16): Strategic Audit v12.06 — 3 Critical Engine Fixes
//         ROOT CAUSE: 4.5-month audit (Jan-May 2026) found +71.6% total return but $55K+ left on table
//         and -469% (NET), -384% (AURA.TA) tail risk losses from gradual bleed bypassing catastrophe stop.
//
//         FIX 1: Winner's Leash Widened ~1.5x — Recover $55K Opportunity Cost
//           Elephant (ROI>100%): 20% → 30% trailing (0.80 → 0.70)
//           Tiered-Mid (40-100%): 18% → 27% trailing (0.82 → 0.73)
//           FOM: RISK_FOM_LEASH widened 1.5x (risk 1=15%, risk 10=45%)
//           Standard: 20% → 30% trailing (0.80 → 0.70)
//           Safe Haven: 8% → 12% trailing (0.92 → 0.88)
//           Momentum runners (NOFR.TA, TSM, GD) need more breathing room during natural corrections.
//
//         FIX 2: Idle Capital Redeployment Accelerated (10 → 3 days)
//           150+ tickers sat idle with $500 each = $75K+ dead capital.
//           Threshold reduced from 10 days to 3 days — capital freed 3x faster.
//           When freed, system logs high-ZivScore (>=9) tickers available for reallocation.
//           Capital must always work on the strongest setups.
//
//         FIX 3: Hard Circuit Breaker at -50% Cumulative P&L
//           NET (-469%), AURA.TA (-384%) — losses exceeded allocated capital.
//           Existing catastrophe stop only checks intraday drop from open (10-20%), NOT cumulative P&L.
//           Gradual bleed over many days bypassed all existing stops.
//           NEW: If any position's cumulative P&L hits -50% of allocated capital → FORCE CLOSE.
//           NO EXCEPTIONS — overrides Core Holdings, FOM, Cold Strategy, all other rules.
//           Checked FIRST in position management loop, before all other exit logic.
