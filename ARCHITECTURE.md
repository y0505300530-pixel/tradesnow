# System Architecture Map — tradesnow.vip
**Project:** trading-youtube-analyzer  
**Version:** v14.97  
**Date:** April 2026  

---

## 1. Project Structure (Tree View)

```
trading-youtube-analyzer/
│
├── client/                         ← React 19 SPA (Vite)
│   ├── index.html                  ← HTML entry, Google Fonts CDN
│   ├── public/                     ← favicon.ico, manifest.json, robots.txt
│   └── src/
│       ├── main.tsx                ← App bootstrap: QueryClient, tRPC, ThemeProvider
│       ├── App.tsx                 ← Router (wouter) + layout shells
│       ├── index.css               ← Tailwind 4 global theme + CSS variables
│       ├── const.ts                ← getLoginUrl(), app constants
│       │
│       ├── pages/                  ← 19 page-level components (see §2)
│       ├── components/             ← Shared & feature components
│       │   ├── ui/                 ← shadcn/ui primitives (40+ components)
│       │   ├── GlobalNav.tsx       ← Top navigation bar + mobile drawer
│       │   ├── DashboardLayout.tsx ← Sidebar layout wrapper
│       │   ├── DeepAnalysisModal.tsx ← Full deep analysis modal (Ziv Engine)
│       │   ├── AIChatBox.tsx       ← Streaming AI chat component
│       │   ├── IBKROrderDialog.tsx ← Market/Stop/Limit order dialog
│       │   ├── IBKRBracketDialog.tsx ← Bracket order dialog
│       │   ├── IBINDConnectScreen.tsx ← IBKR session connect UI
│       │   ├── PortfolioPerformanceChart.tsx
│       │   ├── PerformanceChart.tsx
│       │   └── Map.tsx             ← Google Maps proxy component
│       │
│       ├── contexts/
│       │   ├── IbkrTickleContext.tsx  ← IBKR session keep-alive (client-side tickle)
│       │   └── ThemeContext.tsx       ← Dark/light theme state
│       │
│       ├── hooks/
│       │   ├── useComposition.ts
│       │   ├── useInactivityTimeout.ts
│       │   ├── useMobile.tsx
│       │   └── usePersistFn.ts
│       │
│       └── lib/
│           ├── trpc.ts             ← tRPC client + React Query binding
│           ├── utils.ts            ← cn() and helpers
│           └── ibkr.ts             ← IBKR client-side helpers
│
├── server/                         ← Express 4 + tRPC 11 API server
│   ├── _core/                      ← Framework plumbing (OAuth, context, tRPC, LLM)
│   │   ├── index.ts                ← Server entry: registers all routes + background services
│   │   ├── app.ts                  ← Express app factory
│   │   ├── trpc.ts                 ← publicProcedure, protectedProcedure, adminProcedure
│   │   ├── context.ts              ← Request context (user, db)
│   │   ├── oauth.ts                ← Manus OAuth callback handler
│   │   ├── llm.ts                  ← invokeLLM() helper (Manus Forge API)
│   │   ├── imageGeneration.ts      ← generateImage() helper
│   │   ├── voiceTranscription.ts   ← transcribeAudio() helper
│   │   ├── notification.ts         ← notifyOwner() helper
│   │   ├── map.ts                  ← Google Maps proxy helper
│   │   └── systemRouter.ts         ← system.notifyOwner procedure
│   │
│   ├── routers.ts                  ← Root tRPC router (merges all sub-routers)
│   │
│   ├── routers/                    ← Feature routers (see §3)
│   │   ├── portfolio.ts            ← Holdings, capital, diary, ZIV H, analysis (largest: ~2,800 lines)
│   │   ├── tradingLab.ts           ← Simulation engine (largest: ~6,200 lines)
│   │   ├── ibkr.ts                 ← IBKR/IBIND integration (~1,460 lines)
│   │   ├── analyze.ts              ← YouTube video analysis
│   │   ├── masterKnowledge.ts      ← Active signals, deep research
│   │   ├── telegramMonitor.ts      ← Telegram group monitoring + RSS feeds
│   │   ├── telegramWebhook.ts      ← Telegram bot webhook handler
│   │   ├── tradingView.ts          ← TradingView settings + alerts
│   │   ├── tradingViewWebhook.ts   ← TradingView webhook handler
│   │   ├── ibkrProxy.ts            ← IBIND REST proxy routes
│   │   ├── trade.ts                ← Watchlist scan + live prices
│   │   ├── tradeManager.ts         ← Watchlist CRUD + risk rating
│   │   ├── holding2.ts             ← Secondary holdings portfolio
│   │   ├── knowledgeBase.ts        ← Knowledge base + proficiency matrix
│   │   ├── videoManagement.ts      ← YouTube channel + video management
│   │   ├── settings.ts             ← User settings (Telegram, general)
│   │   ├── priceAlerts.ts          ← Price alert CRUD + Telegram delivery
│   │   ├── performance.ts          ← Portfolio snapshots + holding performance
│   │   ├── localUsers.ts           ← Local user management (admin)
│   │   ├── logs.ts                 ← Log file access
│   │   ├── labReport.ts            ← Lab simulation CSV report download
│   │   ├── labStream.ts            ← Lab simulation SSE stream
│   │   ├── marketScan.ts           ← Market scan SSE stream
│   │   └── systemLogs.ts           ← System log file REST endpoints
│   │
│   ├── zivEngine.ts                ← calcZivEngineScore() + calcZivHScore()
│   ├── marketData.ts               ← Yahoo Finance + bar data fetching
│   ├── alertPoller.ts              ← Background: price alerts + daily summary
│   ├── ibkrSessionMonitor.ts       ← Background: IBKR session health check
│   ├── ibkrServerTickle.ts         ← Background: IBKR session keep-alive
│   ├── telegram.ts                 ← Telegram Bot API helper
│   ├── twoFactor.ts                ← TOTP 2FA routes + OTP cleanup
│   ├── logger.ts                   ← Structured logger
│   ├── db.ts                       ← Drizzle ORM query helpers
│   └── storage.ts                  ← S3 storagePut() / storageGet()
│
├── drizzle/
│   └── schema.ts                   ← All 30 database tables (MySQL/TiDB)
│
├── shared/
│   ├── version.ts                  ← APP_VERSION constant
│   ├── const.ts                    ← Shared constants (cookie name, etc.)
│   └── types.ts                    ← Shared TypeScript types
│
└── package.json                    ← Monorepo: client + server in one package
```

---

## 2. Frontend Architecture

### 2.1 Entry Points

| File | Role |
|------|------|
| `client/index.html` | HTML shell, Google Fonts CDN links |
| `client/src/main.tsx` | Mounts React app; wraps with `QueryClientProvider`, `TRPCProvider`, `ThemeProvider`, `IbkrTickleContext` |
| `client/src/App.tsx` | Defines all routes via `wouter`; wraps authenticated routes in `RequireVerified` / `RequireAdmin` guards |

### 2.2 Pages & Routes

| Route | Page Component | Access |
|-------|---------------|--------|
| `/` | `LandingPage.tsx` | Public |
| `/login` | `LoginPage.tsx` | Public |
| `/verify-2fa` | `Verify2FA` (inline) | Public |
| `/landing` | `Home.tsx` | Verified |
| `/knowledge` | `KnowledgeBase.tsx` | Verified |
| `/master` | `MasterKnowledge.tsx` | Verified |
| `/trade` | `TradeManager.tsx` | Verified |
| `/catalogue` | `AssetCatalogue.tsx` | Verified |
| `/settings` | `Settings.tsx` | Verified |
| `/history` | `HistoryPage.tsx` | Verified |
| `/videos` | `VideoManagement` (lazy) | Verified |
| `/watchlist` | `WatchlistPage` (lazy) | Verified |
| `/lab` | `TradingLab.tsx` | Verified |
| `/lab/triple` | `TripleSimulation.tsx` | Verified |
| `/tradingview` | `TradingViewPage.tsx` | Verified |
| `/alerts` | `PriceAlerts.tsx` | Verified |
| `/ibkr-account` | `IBKRAccountPage.tsx` | **Admin only** |
| `/logs` | `LogsPage.tsx` | Verified |
| `/dip-analysis` | `DipAnalysis.tsx` | Verified |
| `/h1h2` | `H1H2Dashboard.tsx` | Verified |
| `/my-settings` | `MySettings` (lazy) | Verified |
| `/telegram-monitor` | `TelegramMonitor.tsx` | Verified |
| `/404` | `NotFound.tsx` | Public |

### 2.3 Global State & Context

The application does **not** use Redux or Zustand. State management is handled through three layers:

**React Query (TanStack Query v5)** is the primary server-state layer, accessed exclusively through tRPC hooks. All data fetching, caching, and invalidation flows through `trpc.*.useQuery` and `trpc.*.useMutation`. The `QueryClient` is configured with `staleTime: 30s`, `gcTime: 5min`, and `refetchOnWindowFocus: false`.

**React Context** provides two global cross-cutting concerns: `ThemeContext` manages dark/light mode via `next-themes`, and `IbkrTickleContext` runs a client-side interval that calls the IBKR tickle endpoint to keep the brokerage session alive while the user is on the page.

**Local component state** (`useState`) handles all ephemeral UI state — dialogs, form inputs, sort order, selected rows — within each page component.

### 2.4 TradeManager.tsx — Component Relationships

`TradeManager.tsx` is the most complex file in the project (4,539 lines). It is a self-contained monolith that imports and orchestrates the following:

```
TradeManager.tsx
├── Lazy-loaded heavy components
│   ├── DeepAnalysisModal       ← Full deep analysis overlay
│   ├── IBKROrderDialog         ← Market order placement
│   ├── IBKRBracketDialog       ← Bracket order (entry + SL + TP)
│   ├── IBINDConnectScreen      ← IBKR session connect/disconnect
│   ├── PortfolioPerformanceChart ← Equity curve chart
│   └── PerformanceChart        ← Holdings performance chart
│
├── Internal sub-components (defined in same file)
│   ├── HoldingRow (memo)       ← Single row in Holdings table
│   ├── ZivHBadge               ← ZIV H Health tier badge
│   ├── ScoreBadge              ← Ziv Engine score badge
│   ├── QuickAddRow             ← Inline add holding row
│   ├── AddHoldingDialog        ← Add new position dialog
│   ├── CapitalDialog           ← Deposit / withdrawal dialog
│   ├── BuyFromCatalogueDialog  ← Buy from Asset Catalogue
│   └── EditCatalogueDialog     ← Edit catalogue entry
│
└── tRPC procedures consumed
    ├── portfolio.getState          ← All holdings, capital, events
    ├── portfolio.getLivePrices     ← Yahoo Finance live prices
    ├── portfolio.getZivHScores     ← ZIV H Health scores for all holdings
    ├── portfolio.analyze           ← AI portfolio analysis
    ├── portfolio.dailyReview       ← Daily review AI
    ├── portfolio.portfolioChat     ← AI chat about portfolio
    ├── portfolio.getDiaryEntries   ← Trading diary
    ├── portfolio.findReplacements  ← Asset replacement engine
    ├── ibkr.getPositions           ← Live IBKR positions
    ├── ibkr.syncFromIbkr           ← Sync DB from IBKR
    ├── ibkr.placeMarketOrder       ← Execute market sell
    ├── ibkr.syncSlTpOrderStatus    ← Sync SL/TP order status
    ├── holding2.list               ← Secondary portfolio holdings
    └── masterKnowledge.get         ← Active signals
```

---

## 3. Backend & API Map

### 3.1 tRPC Procedures (by router)

All tRPC traffic is served at `/api/trpc`. The root router merges 16 sub-routers:

| Router | Key Procedures |
|--------|---------------|
| **portfolio** | `getState`, `addHolding`, `updateHolding`, `deleteHolding`, `syncHoldingAlerts`, `getLivePrices`, `refreshPrices`, `deposit`, `requestWithdrawal`, `analyze`, `analyzeHoldings`, `analyzeAssetList`, `getLatestAnalysis`, `getEvents`, `validateTicker`, `buyFromCatalogue`, `findReplacements`, `getRetestWatchlist`, `getCatalogueWithScores`, `dailyReview`, `getQuickStats`, `analyzeAsset`, `getDiaryEntries`, `addDiaryEntry`, `deleteDiaryEntry`, `updateDiaryEntry`, `archiveAssets`, `restoreAssets`, `portfolioChat`, `getChatHistory`, `logJournalEvent`, `getJournalEvents`, `getSnapshotsAll`, `recordDailySnapshot`, `dipAnalysis`, `backfillBuyScore`, `getZivHForTicker`, `getZivHScores` |
| **ibkr** | `getSettings`, `saveSettings`, `markConnected`, `getPositions`, `getAccountSummary`, `syncFromIbkr`, `placeSTPOrder`, `placeLMTOrder`, `tradingChat`, `placeMarketOrder`, `logOrder`, `addConnectionLog`, `syncSlTpOrderStatus`, `placeStopLossIbind`, `placeTakeProfitIbind`, `placeBracketIbind`, `getSessionStatus`, `startSession`, `cancelOrder`, `debugRawOrders`, `getLivePrices`, `stopSession` |
| **tradingLab** | `runSimulation`, `forkSimulation`, `getSimulation`, `listSimulations`, `deleteSimulation`, `getReport`, `getLabSettings`, `saveLabSettings`, `getAssetList`, `saveAssetList`, `getTripleSettings`, `runTripleSimulation`, `getTripleSimulation` *(+17 more)* |
| **analyze** | `start`, `status`, `history`, `validateUrl`, `startBulk`, `bulkStatus`, `bulkHistory` |
| **masterKnowledge** | `get`, `generate`, `addSignal`, `updateSignal`, `deleteSignal`, `sendToTradeManager`, `mergeFromAnalysis`, `deepResearch` |
| **telegramMonitor** | `listGroups`, `addGroup`, `toggleGroup`, `deleteGroup`, `getMessages`, `pollNow`, `getGroupMessages`, `getRssFeed`, `getUnreadCount` |
| **trade** | `scan`, `livePrices`, `historicalData` |
| **tradeManager** | `list`, `scanAndSave`, `update`, `delete`, `rateRisk`, `livePrices` |
| **holding2** | `list`, `add`, `update`, `remove`, `refreshPrices`, `fixIsraeliPrices` |
| **settings** | `getTelegram`, `saveTelegram`, `testTelegram`, `get`, `save` |
| **priceAlerts** | `getAll`, `getTriggered`, `create`, `dismiss`, `delete`, `deleteForTicker`, `getTelegramSettings`, `setTelegramSettings`, `testAlert`, `getAlertHistory`, `clearHistory` |
| **tradingView** | `getSettings`, `updateSettings`, `regenerateSecret`, `getAlerts`, `clearAlerts`, `updateAlertStatus` |
| **performance** | `getSnapshots`, `saveSnapshot`, `getHoldingPerformance` |
| **knowledgeBase** | `get`, `generate`, `updateFromAnalysis` |
| **videoManagement** | `listChannels`, `addChannel`, `deleteChannel`, `listVideos`, `analyzeVideo`, `getAnalysis`, `bulkAnalyze`, `getStats` *(+more)* |
| **localUsers** | `list`, `create`, `update`, `delete` |
| **logs** | `getLogs` |

### 3.2 REST HTTP Endpoints (non-tRPC)

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/oauth/callback` | Manus OAuth redirect handler |
| `POST` | `/api/local-auth/login` | Username/password + TOTP login |
| `POST` | `/api/local-auth/logout` | Session cookie clear |
| `GET` | `/api/totp/status` | Check if 2FA is enabled for session |
| `POST` | `/api/2fa/verify-existing` | Verify TOTP code |
| `POST` | `/api/2fa/revoke-all` | Revoke all TOTP devices |
| `GET` | `/api/ibind/health` | IBIND proxy health check |
| `POST` | `/api/ibind/session/start` | Start IBKR IBIND session |
| `POST` | `/api/ibind/order` | Place order via IBIND |
| `GET` | `/api/ibind/positions` | Fetch live positions from IBIND |
| `GET` | `/api/ibind/orders` | Fetch open orders from IBIND |
| `GET` | `/api/ibind/account-summary` | Fetch account summary from IBIND |
| `POST` | `/api/telegram/webhook` | Telegram Bot webhook receiver |
| `POST` | `/api/tradingview/webhook` | TradingView alert webhook receiver |
| `POST` | `/api/market-scan` | Market scan SSE stream |
| `GET` | `/api/lab/stream/:id` | Lab simulation SSE stream |
| `GET` | `/api/lab/report/:id` | Lab simulation CSV download |
| `GET` | `/api/system-logs/list` | List log files |
| `GET` | `/api/system-logs/preview/:key` | Preview a log file |
| `GET` | `/api/system-logs/download/:key` | Download a log file |
| `GET` | `/api/system-logs/download-all` | Download all logs as ZIP |

### 3.3 External Service Integration Points

**Interactive Brokers (IBKR) via IBIND:**
IBIND is a self-hosted IBKR Client Portal Gateway proxy. The server communicates with it via `ibkrProxy.ts` which forwards requests to the IBIND container. Three background services manage the IBKR connection: `ibkrSessionMonitor.ts` checks session health every 10 minutes; `ibkrServerTickle.ts` sends a keep-alive ping every 55 seconds; and `IbkrTickleContext` on the client side sends a browser-level tickle while the user is active. Order placement uses the IBIND `/iserver/account/{id}/orders` endpoint with bracket, stop, limit, and market order types.

**AI / LLM (Manus Forge API):**
All LLM calls go through `server/_core/llm.ts` → `invokeLLM()`, which calls the `BUILT_IN_FORGE_API_URL` with `BUILT_IN_FORGE_API_KEY`. LLM is used in: YouTube video analysis (`analyze.ts`), portfolio AI chat (`portfolio.ts`), deep analysis (`portfolio.dipAnalysis`), knowledge base generation (`knowledgeBase.ts`), master knowledge deep research (`masterKnowledge.ts`), Telegram message classification (`telegramMonitor.ts`), and the Trading Lab scan (`tradingLab.ts`).

**Yahoo Finance (via `marketData.ts`):**
Used for all market data when IBKR is not connected: live prices, historical OHLCV bars, RSI/EMA calculations, and ticker search autocomplete. The `marketData.ts` module wraps Yahoo Finance API calls with retry logic and caching.

**Telegram Bot API:**
`telegram.ts` wraps the Telegram Bot API. It is used by: `alertPoller.ts` for price alerts and daily summaries; `telegramWebhook.ts` for the bot command handler (`/start`, `/status`, `/scan`, `/signal`, `/help`); and `telegramMonitor.ts` for polling group messages via MTProto (user-level API, not bot API).

**TradingView Webhooks:**
`tradingViewWebhook.ts` receives POST alerts from TradingView, validates the secret, and stores them in `tvAlerts` table. The `tradingView.ts` router manages webhook URL generation and alert history.

**AWS S3 (via `storage.ts`):**
`storagePut()` and `storageGet()` wrap the AWS SDK. Used for storing simulation reports and any user-uploaded files.

---

## 4. Data Flow & Schema

### 4.1 Primary Data Models

| Table | Purpose | Key Fields |
|-------|---------|-----------|
| `users` | Manus OAuth users | `id`, `openId`, `name`, `role` (admin/user), `telegramChatId` |
| `localUsers` | Local username/password users | `id`, `username`, `passwordHash`, `totpSecret`, `role` |
| `portfolioHoldings` | Active portfolio positions (H1) | `userId`, `ticker`, `units`, `buyPrice`, `stopLoss`, `takeProfit`, `conid`, `zivScore` |
| `holding2` | Secondary portfolio (H2) | `userId`, `ticker`, `units`, `buyPrice`, `stopLoss`, `takeProfit`, `currency` |
| `capitalEvents` | Deposits & withdrawals | `userId`, `type`, `amount`, `note`, `createdAt` |
| `portfolioAccounts` | Portfolio account metadata | `userId`, `totalCapital`, `ibkrAccountId` |
| `userAssets` | Watchlist / Asset Catalogue | `userId`, `ticker`, `zivScore`, `buyScore`, `sector`, `isActive` |
| `masterKnowledge` | Active trading signals | `userId`, `ticker`, `entry`, `stopLoss`, `takeProfit`, `catalyst`, `source` |
| `tradingDiary` | Trade journal entries | `userId`, `ticker`, `buyPrice`, `units`, `stopLoss`, `takeProfit`, `rationale` |
| `analyses` | YouTube video analysis results | `userId`, `videoUrl`, `videoTitle`, `result` (JSON), `status` |
| `knowledgeBase` | Trading knowledge from videos | `userId`, `content`, `generatedAt` |
| `labSimulations` | Simulation run metadata | `userId`, `status`, `settings` (JSON), `finalCapital`, `roi` |
| `labTrades` | Individual simulation trades | `simulationId`, `ticker`, `entry`, `exit`, `pnl`, `type` |
| `priceAlerts` | Price alert rules | `userId`, `ticker`, `alertType`, `targetPrice`, `direction`, `triggered` |
| `portfolioSnapshots` | Daily equity curve data | `userId`, `date`, `totalValue` |
| `tvAlerts` | TradingView incoming alerts | `userId`, `ticker`, `action`, `price`, `payload` |
| `telegramMonitorGroups` | Monitored Telegram groups | `userId`, `groupHandle`, `groupId`, `isActive` |
| `telegramMonitorMessages` | Classified Telegram messages | `groupId`, `messageId`, `category`, `ticker`, `summary`, `isRelevant` |
| `deepAnalysisCache` | Cached deep analysis results | `userId`, `ticker`, `date`, `result` (JSON) |
| `priceCache` | Historical OHLCV cache | `ticker`, `date`, `open`, `high`, `low`, `close`, `volume` |
| `ibkrSettings` | IBKR connection config | `userId`, `ibindUrl`, `accountId`, `isConnected` |
| `userSettings` | User preferences | `userId`, `telegramEnabled`, `telegramChatId`, `dailySummaryEnabled` |

### 4.2 IBKR Data Flow

The flow from IBKR to the TradeManager UI follows this path:

```
IBKR Client Portal Gateway
        │
        ▼
IBIND Container (self-hosted proxy)
        │  REST API calls
        ▼
ibkrProxy.ts  (/api/ibind/*)
        │
        ├──► ibkrServerTickle.ts  (every 55s keep-alive)
        ├──► ibkrSessionMonitor.ts (every 10min health check)
        │
        ▼
ibkr.ts tRPC router
        │
        ├── syncFromIbkr()  →  portfolioHoldings (DB write)
        ├── getPositions()  →  live position data (no DB)
        └── getLivePrices() →  live price data (no DB)
                │
                ▼
        TradeManager.tsx (React)
                │
                ├── portfolio.getState.useQuery()     ← DB holdings (60s refetch)
                ├── portfolio.getLivePrices.useQuery() ← Yahoo Finance (30s market / 5min off-hours)
                ├── ibkr.getPositions.useQuery()       ← Live IBKR positions (on demand)
                └── ibkrPositionMap (useMemo)          ← Merged view for UI rendering
```

When the user clicks **Sync Now**, `ibkr.syncFromIbkr` is called, which fetches positions from IBIND, upserts them into `portfolioHoldings`, and invalidates `portfolio.getState` — triggering a full UI refresh.

---

## 5. Environment & Tech Stack

### 5.1 Core Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| **Frontend framework** | React | 19.x |
| **Build tool** | Vite | 7.x |
| **Styling** | Tailwind CSS | 4.x |
| **UI components** | shadcn/ui (Radix UI) | Latest |
| **Routing** | wouter | 3.x |
| **API layer** | tRPC | 11.x |
| **Server-state** | TanStack React Query | 5.x |
| **Serialization** | superjson | 1.x |
| **Backend framework** | Express | 4.x |
| **ORM** | Drizzle ORM | 0.44.x |
| **Database** | MySQL / TiDB | — |
| **Language** | TypeScript | 5.9.x |
| **Runtime** | Node.js | 22.x |
| **Package manager** | pnpm | 10.x |
| **Testing** | Vitest | 2.x |

### 5.2 Key Libraries

| Library | Purpose |
|---------|---------|
| `lightweight-charts` | TradingView-style price charts |
| `recharts` | Portfolio performance charts |
| `framer-motion` | UI animations |
| `react-hook-form` + `zod` | Form validation |
| `date-fns` | Date manipulation |
| `sonner` | Toast notifications |
| `streamdown` | Markdown streaming renderer for AI responses |
| `@distube/ytdl-core` | YouTube video metadata |
| `youtube-transcript` | YouTube transcript extraction |
| `axios` | HTTP client (server-side external API calls) |
| `bcryptjs` | Password hashing |
| `speakeasy` + `otplib` | TOTP 2FA |
| `jose` | JWT signing/verification |
| `pdfkit` | PDF report generation |
| `@aws-sdk/client-s3` | S3 file storage |
| `mysql2` | MySQL/TiDB driver |
| `nanoid` | Unique ID generation |

### 5.3 Background Services (Server-Side)

Three persistent background services run on server startup:

| Service | File | Interval | Purpose |
|---------|------|----------|---------|
| Alert Poller | `alertPoller.ts` | Every 30 min | Check price alerts; send Telegram notifications; daily summary at 09:00 |
| IBKR Session Monitor | `ibkrSessionMonitor.ts` | Every 10 min | Check IBKR session health; log silently on expiry |
| IBKR Server Tickle | `ibkrServerTickle.ts` | Every 55 sec | Keep IBKR session alive via IBIND tickle endpoint |

### 5.4 Authentication Architecture

The system supports two parallel authentication methods: **Manus OAuth** (primary, for Manus platform users) and **Local Auth** (username + password + TOTP 2FA, for direct access). Both methods set the same `app_session_id` cookie, which is validated on every tRPC request via `server/_core/context.ts`. Role-based access control uses the `role` field (`admin` | `user`) on both `users` and `localUsers` tables, enforced via `adminProcedure` on the server and `RequireAdmin` route guard on the client.

---

*This document was generated by scanning the live codebase at v14.97. It should be updated whenever major architectural changes are made.*
