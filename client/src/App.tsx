import { lazy, Suspense } from "react";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Route, Switch, Redirect } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import { RootLayout } from "./components/RootLayout";
import { RequireVerified } from "./components/RequireVerified";
import { RequireAdmin } from "./components/RequireAdmin";
import { RequireFullViewer } from "./components/RequireFullViewer";
import { IbkrSessionGuard } from "./components/IbkrSessionGuard";
import { PWAInstallPrompt } from "./components/PWAInstallPrompt";
import { useServiceWorkerUpdate } from "./hooks/useServiceWorkerUpdate";

// ── Eagerly loaded (tiny, always needed) ─────────────────────────────────────
import NotFound from "@/pages/NotFound";
import LandingPage from "./pages/LandingPage";
import LoginPage from "./pages/LoginPage";
import ChangePasswordPage from "./pages/ChangePasswordPage";
import Verify2FA from "./pages/Verify2FA";

// ── Lazily loaded — each page becomes its own JS chunk ────────────────────────
const KnowledgeBase    = lazy(() => import("./pages/KnowledgeBase"));

const TradeManager     = lazy(() => import("./pages/TradeManager"));
const AssetCatalogue   = lazy(() => import("./pages/AssetCatalogue"));
const Settings         = lazy(() => import("./pages/Settings"));
const VideoManagement  = lazy(() => import("./pages/VideoManagement"));
const WatchlistPage    = lazy(() => import("./pages/WatchlistPage"));
const AIInsightsPage   = lazy(() => import("./pages/AIInsightsPage"));
const IBKRAccountPage  = lazy(() => import("./pages/IBKRAccountPage"));
const LogsPage         = lazy(() => import("./pages/LogsPage"));
const DipAnalysis      = lazy(() => import("./pages/DipAnalysis"));
const H1H2Dashboard    = lazy(() => import("./pages/H1H2Dashboard"));
const PortfolioOverview = lazy(() => import("./pages/PortfolioOverview"));
const PortfolioDetail  = lazy(() => import("./pages/PortfolioDetail"));
const DeepAnalysisPage = lazy(() => import("./pages/DeepAnalysisPage"));
const MoneyTransfers   = lazy(() => import("./pages/MoneyTransfers"));
const SplashScreen     = lazy(() => import("./pages/SplashScreen"));
const WarRoomLive      = lazy(() => import("./pages/WarRoomLive")); // Elza Live Engine
const WarRoomDror      = lazy(() => import("./pages/WarRoomDror"));
const WarReport        = lazy(() => import("./pages/WarReport"));   // Closed-trade ledger / stats
const Favorites        = lazy(() => import("./pages/Favorites"));
const MobileTradingPreviewPage = import.meta.env.DEV
  ? lazy(() => import("./pages/dev/MobileTradingPreviewPage"))
  : null;

// ── Minimal loading spinner shown while a lazy chunk loads ───────────────────
function PageLoader() {
  return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
    </div>
  );
}

function Router() {
  return (
    <RootLayout>
      <IbkrSessionGuard>
        <Suspense fallback={<PageLoader />}>
          <Switch>
            {/* ── Public routes ── */}
            <Route path={"/"} component={LandingPage} />
            <Route path={"/login"} component={LoginPage} />
            <Route path={"/change-password"} component={ChangePasswordPage} />
            <Route path={"/verify-2fa"} component={Verify2FA} />
            {import.meta.env.DEV && MobileTradingPreviewPage && (
              <Route path={"/dev/mobile-trading-preview"} component={MobileTradingPreviewPage} />
            )}

            {/* ── Protected routes ── */}
            <Route path={"/knowledge"}>
              <RequireFullViewer>
                <RequireVerified><KnowledgeBase /></RequireVerified>
              </RequireFullViewer>
            </Route>
            <Route path={"/master"}><Redirect to="/knowledge?tab=master" /></Route>
            <Route path={"/trade"}>
              <RequireVerified><TradeManager /></RequireVerified>
            </Route>
            <Route path={"/tools"}><Redirect to="/catalogue" /></Route>
            <Route path={"/trade-manager"}><Redirect to="/trade" /></Route>
            <Route path={"/catalogue"}>
              <RequireVerified><AssetCatalogue /></RequireVerified>
            </Route>
            <Route path={"/settings"}>
              <RequireVerified><Settings /></RequireVerified>
            </Route>
            <Route path={"/videos"}>
              <RequireFullViewer>
                <RequireVerified><VideoManagement /></RequireVerified>
              </RequireFullViewer>
            </Route>
            <Route path={"/watchlist"}>
              <RequireFullViewer>
                <RequireVerified><WatchlistPage /></RequireVerified>
              </RequireFullViewer>
            </Route>
            <Route path={"/ai-insights"}>
              <RequireVerified><AIInsightsPage /></RequireVerified>
            </Route>
            <Route path={"/ibkr-account"}>
              <RequireAdmin>
                <RequireVerified><IBKRAccountPage /></RequireVerified>
              </RequireAdmin>
            </Route>
            <Route path={"/logs"}>
              <RequireAdmin>
                <RequireVerified><LogsPage /></RequireVerified>
              </RequireAdmin>
            </Route>
            <Route path={"/dip-analysis"}>
              <RequireVerified><DipAnalysis /></RequireVerified>
            </Route>
            <Route path={"/h1h2"}>
              <RequireFullViewer>
                <RequireVerified><H1H2Dashboard /></RequireVerified>
              </RequireFullViewer>
            </Route>

            <Route path={"/splash"}>
              <RequireVerified><SplashScreen /></RequireVerified>
            </Route>
            <Route path={"/war-room-live"}>
              <RequireAdmin>
                <RequireVerified><WarRoomLive /></RequireVerified>
              </RequireAdmin>
            </Route>
            <Route path={"/war-room/dror"}>
              <RequireVerified><WarRoomDror /></RequireVerified>
            </Route>
            <Route path={"/war-report"}>
              <RequireAdmin>
                <RequireVerified><WarReport /></RequireVerified>
              </RequireAdmin>
            </Route>
            <Route path={"/overview"}>
              <RequireVerified><PortfolioOverview /></RequireVerified>
            </Route>
            <Route path={"/portfolio/:type"}>
              {(params) => {
                const type = params.type as "h1" | "h2-tase" | "h2-usa" | "h2-crypto";
                const detail = <PortfolioDetail type={type} />;
                if (type === "h1") {
                  return <RequireVerified>{detail}</RequireVerified>;
                }
                return (
                  <RequireFullViewer>
                    <RequireVerified>{detail}</RequireVerified>
                  </RequireFullViewer>
                );
              }}
            </Route>
            <Route path={"/money-transfers"}>
              <RequireFullViewer>
                <RequireVerified><MoneyTransfers /></RequireVerified>
              </RequireFullViewer>
            </Route>
            <Route path={"/favorites"}>
              <RequireVerified><Favorites /></RequireVerified>
            </Route>
            <Route path={"/deep-analysis/:ticker"}>
              {(params) => (
                <RequireVerified>
                  <DeepAnalysisPage />
                </RequireVerified>
              )}
            </Route>
            <Route path={"/404"} component={NotFound} />
            <Route component={NotFound} />
          </Switch>
        </Suspense>
      </IbkrSessionGuard>
    </RootLayout>
  );
}

function App() {
  useServiceWorkerUpdate();
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="light">
        <TooltipProvider>
          <Toaster />
          <Router />
          <PWAInstallPrompt />
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
