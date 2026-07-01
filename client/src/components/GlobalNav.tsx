import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import {
  Activity,
  BarChart2,
  Brain,
  History,
  Home,
  LogIn,
  LogOut,
  Settings,
  TrendingUp,
  TrendingDown,
  Video,
  Loader2,
  BookOpen,
  ChevronDown,
  Zap,
  Menu,
  X,
  ScrollText,
  Bookmark,
  PieChart,
  MessageSquare,
  LayoutList,
  ArrowLeftRight,
  Database,
  Star,
} from "lucide-react";
import { Link, useLocation } from "wouter";
import { useState, useRef, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { APP_VERSION } from "../../../shared/version";
import { Z } from "@/lib/zIndex";
import { useTradingViewerContext } from "@/hooks/useTradingViewerContext";

// ── Prefetch map: route → dynamic import for hover-prefetch ──────────────────
const PREFETCH_MAP: Record<string, () => Promise<any>> = {
  "/trade":       () => import("../pages/TradeManager"),
  "/h1h2":        () => import("../pages/H1H2Dashboard"),
  "/catalogue":   () => import("../pages/AssetCatalogue"),
  "/overview":    () => import("../pages/PortfolioOverview"),
  "/knowledge":   () => import("../pages/KnowledgeBase"),
  "/war-room-live": () => import("../pages/WarRoomLive"),
  "/war-report":  () => import("../pages/WarReport"),
  "/ai-insights": () => import("../pages/AIInsightsPage"),
  "/favorites":   () => import("../pages/Favorites"),
};
const prefetched = new Set<string>();
function prefetchRoute(href: string) {
  const key = href.split("?")[0]; // strip query params
  if (prefetched.has(key) || !PREFETCH_MAP[key]) return;
  prefetched.add(key);
  PREFETCH_MAP[key]().catch(() => { /* silent */ });
}

// ── 2026 Institutional Light design tokens ────────────────────────────────────────────
const BLUE = "#4F46E5";
const BLUE_DIM = "rgba(79,70,229,0.10)";
const BLUE_BORDER = "rgba(79,70,229,0.18)";
const NAV_BG = "rgba(255,255,255,0.95)";
const CARD_BG = "rgba(255,255,255,0.98)";
const TEXT_INACTIVE = "rgba(51,65,85,0.92)";
const TEXT_ACTIVE = "#4F46E5";
const MINT = "#0F766E";

// ─── TradeDropdown ───────────────────────────────────────────────────────────
function TradeDropdown({ isActive, dropdownItem, showH1H2 = true }: {
  isActive: (href: string) => boolean;
  dropdownItem: (href: string) => string;
  showH1H2?: boolean;
}) {
  const [location] = useLocation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, []);
  useEffect(() => { setOpen(false); }, [location]);

  const tradeRoutes = showH1H2 ? ["/trade", "/h1h2"] : ["/trade"];
  const isTradeActive = tradeRoutes.some(r => location === r || location.startsWith(r));

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(v => !v)}
        className="relative flex items-center gap-2 px-3.5 py-2 rounded-lg text-sm font-semibold transition-all duration-200 border"
        style={isTradeActive ? {
          color: TEXT_ACTIVE, background: BLUE_DIM, borderColor: BLUE_BORDER,
          boxShadow: `0 0 12px rgba(37,99,235,0.15)`,
        } : {
          color: TEXT_INACTIVE, background: "transparent", borderColor: "transparent",
        }}
      >
        <TrendingUp className="w-4 h-4" />
        <span>Trade</span>
        <ChevronDown className={`w-3.5 h-3.5 transition-transform duration-200 ${open ? "rotate-180" : ""}`} />
        {isTradeActive && <span className="absolute -bottom-px left-2 right-2 h-0.5 rounded-full" style={{ background: BLUE, opacity: 0.8 }} />}
      </button>
      {open && (
        <div
          className="absolute start-0 top-full mt-2 w-56 rounded-2xl overflow-hidden z-50 animate-in fade-in slide-in-from-top-2 duration-150"
          style={{
            background: CARD_BG,
            border: `1px solid ${BLUE_BORDER}`,
            boxShadow: `0 8px 32px rgba(37,99,235,0.12), 0 2px 8px rgba(0,0,0,0.08)`,
            backdropFilter: "blur(24px)",
          }}
        >
          <div className="px-4 py-2.5 border-b" style={{ borderColor: BLUE_BORDER }}>
            <p className="text-[10px] font-bold uppercase tracking-widest" style={{ color: BLUE }}>Trade</p>
          </div>
          <div className="p-2 flex flex-col gap-0.5">
            {[
              { href: "/trade",         icon: <TrendingUp className="w-4 h-4 shrink-0" />,   label: "Trade Manager",       color: BLUE },
              ...(showH1H2 ? [{ href: "/h1h2", icon: <PieChart className="w-4 h-4 shrink-0" />, label: "H1H2 Holding", color: "#34d399" }] : []),
            ].map(({ href, icon, label, color }) => (
              <Link key={href} href={href} className={dropdownItem(href)}>
                <span style={{ color: isActive(href) ? BLUE : color }}>{icon}</span>
                {label}
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── ToolsDropdown ───────────────────────────────────────────────────────────
function ToolsDropdown({ isActive, dropdownItem, showTransfers = true }: {
  isActive: (href: string) => boolean;
  dropdownItem: (href: string) => string;
  showTransfers?: boolean;
}) {
  const [location] = useLocation();
  const [toolsOpen, setToolsOpen] = useState(false);
  const toolsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (toolsRef.current && !toolsRef.current.contains(e.target as Node)) setToolsOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => { setToolsOpen(false); }, [location]);

  const toolsRoutes = [
    "/catalogue", "/dip-analysis", "/ai-insights", "/favorites",
    ...(showTransfers ? ["/money-transfers"] : []),
  ];
  const isToolsActive = toolsRoutes.some(r => location === r || location.startsWith(r));

  return (
    <div className="relative" ref={toolsRef}>
      <button
        onClick={() => setToolsOpen(v => !v)}
        className="relative flex items-center gap-2 px-3.5 py-2 rounded-lg text-sm font-semibold transition-all duration-200 border"
        style={isToolsActive ? {
          color: TEXT_ACTIVE, background: BLUE_DIM, borderColor: BLUE_BORDER,
          boxShadow: `0 0 12px rgba(37,99,235,0.15)`,
        } : {
          color: TEXT_INACTIVE, background: "transparent", borderColor: "transparent",
        }}
      >
        <Zap className="w-4 h-4" />
        <span>Tools</span>
        <ChevronDown className={`w-3.5 h-3.5 transition-transform duration-200 ${toolsOpen ? "rotate-180" : ""}`} />
        {isToolsActive && <span className="absolute -bottom-px left-2 right-2 h-0.5 rounded-full" style={{ background: BLUE, opacity: 0.8 }} />}
      </button>
      {toolsOpen && (
        <div
          className="absolute start-0 top-full mt-2 w-52 rounded-2xl overflow-hidden z-50 animate-in fade-in slide-in-from-top-2 duration-150"
          style={{
            background: CARD_BG,
            border: `1px solid ${BLUE_BORDER}`,
            boxShadow: `0 8px 32px rgba(37,99,235,0.12), 0 2px 8px rgba(0,0,0,0.08)`,
            backdropFilter: "blur(24px)",
          }}
        >
          <div className="px-4 py-2.5 border-b" style={{ borderColor: BLUE_BORDER }}>
            <p className="text-[10px] font-bold uppercase tracking-widest" style={{ color: BLUE }}>Trading Tools</p>
          </div>
          <div className="p-2 flex flex-col gap-0.5">
            {[
              { href: "/catalogue", icon: <Zap className="w-4 h-4 shrink-0" />, label: "Asset Catalogue", color: BLUE },
              { href: "/dip-analysis", icon: <TrendingDown className="w-4 h-4 shrink-0" />, label: "Deep Analysis", color: "#60A5FA" },
              { href: "/ai-insights", icon: <Brain className="w-4 h-4 shrink-0" />, label: "AI Insights 🧠", color: "#8b5cf6" },
              { href: "/favorites", icon: <Star className="w-4 h-4 shrink-0" />, label: "Favorites ⭐", color: "#f59e0b" },
              ...(showTransfers ? [{ href: "/money-transfers", icon: <ArrowLeftRight className="w-4 h-4 shrink-0" />, label: "Transfer Ledger", color: "#2563EB" }] : []),
            ].map(({ href, icon, label, color }) => (
              <Link key={href} href={href} className={dropdownItem(href)}>
                <span style={{ color: isActive(href) ? BLUE : color }}>{icon}</span>
                {label}
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── GlobalNav ────────────────────────────────────────────────────────────────
export function GlobalNav() {
  const { user, isAuthenticated, loading: authLoading } = useAuth();
  const isAdmin = (user as any)?.role === 'admin';
  const { nav, warRoomPath } = useTradingViewerContext();
  const [location] = useLocation();
  const [knowledgeOpen, setKnowledgeOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const settingsRef = useRef<HTMLDivElement>(null);
  const logoutMutation = trpc.auth.logout.useMutation({
    onSuccess: () => { window.location.href = "/"; },
    onError: () => toast.error("Logout failed"),
  });

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) setKnowledgeOpen(false);
      if (settingsRef.current && !settingsRef.current.contains(e.target as Node)) setSettingsOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    setKnowledgeOpen(false);
    setSettingsOpen(false);
    setMobileOpen(false);
  }, [location]);

  useEffect(() => {
    document.body.style.overflow = mobileOpen ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  }, [mobileOpen]);

  const isLoginPage = location === "/login";

  const isActive = (href: string) =>
    href === "/" ? location === "/" : location === href || location.startsWith(href);

  const knowledgeRoutes = ["/master", "/knowledge"];
  const settingsRoutes = ["/settings", "/ibkr-account", "/logs"];
  const isSettingsActive = settingsRoutes.some((r) => location === r || location.startsWith(r));
  const isKnowledgeActive = knowledgeRoutes.some((r) => location === r || (r !== "/" && location.startsWith(r)));

  // ── Nav link styles ──────────────────────────────────────────────────────────
  const navLink = (href: string) => {
    const active = isActive(href);
    return {
      className: "relative flex items-center gap-2 px-3.5 py-2 rounded-lg text-sm font-semibold transition-all duration-200 border",
      style: active ? {
        color: TEXT_ACTIVE, background: BLUE_DIM, borderColor: BLUE_BORDER,
      } : {
        color: TEXT_INACTIVE, background: "transparent", borderColor: "transparent",
      },
    };
  };

  const dropdownItem = (href: string) => {
    const active = isActive(href);
    return `flex items-center gap-3 px-3.5 py-2.5 rounded-lg text-sm font-medium transition-all duration-150 border ${
      active ? "text-indigo-600 bg-indigo-50 border-indigo-200" : "text-slate-700 hover:bg-slate-50 hover:text-indigo-600 border-transparent"
    }`;
  };

  const dropdownItemStyle = (_href: string) => ({}); // colours handled by dropdownItem className (light theme)

  // Hide nav entirely on the splash screen
  if (location === "/splash") return null;

  return (
    <>
      {/* ── Desktop Header ─────────────────────────────────────────────────────── */}
      <header
        className="fixed top-0 left-0 right-0 border-b overflow-visible"
        style={{
          zIndex: Z.navShell,
          background: NAV_BG,
          borderColor: "transparent",
          borderBottom: `1px solid rgba(15,23,42,0.08)`,
          backgroundClip: "padding-box",
          backdropFilter: "blur(16px) saturate(140%)",
          WebkitBackdropFilter: "blur(16px) saturate(140%)",
          boxShadow: `0 1px 2px rgba(15,23,42,0.05), 0 1px 0 rgba(15,23,42,0.03)`,
        }}
      >
        {/* Gradient border bottom */}
        <div className="absolute bottom-0 left-0 right-0 h-px" style={{ background: `linear-gradient(90deg, transparent 0%, rgba(79,70,229,0.14) 50%, transparent 100%)` }} />
        <div className="container flex items-center justify-between h-16">

          {/* Logo */}
          <Link href={isAuthenticated ? "/overview" : "/"} className="flex items-center gap-2.5 shrink-0 group">
            <div
              className="w-14 h-14 rounded-2xl overflow-hidden transition-all duration-300 group-hover:scale-110 shrink-0"
              style={{
                boxShadow: `0 1px 3px rgba(15,23,42,0.12)`,
                border: "1px solid rgba(15,23,42,0.08)",
              }}
            >
              <img src="/pwa-192.png" alt="TS" className="w-full h-full object-cover" />
            </div>
            <div className="flex flex-col leading-none">
              <span className="font-bold text-base tracking-tight text-slate-900">TS</span>
              <span className="text-[10px] font-mono" style={{ color: MINT }}>TradeSnow</span>
            </div>
            <span
              className="text-[12px] font-bold font-mono px-2 py-0.5 rounded-md ml-1 tracking-wide"
              style={{
                background: `rgba(32,201,151,0.12)`,
                color: MINT,
                border: `1px solid rgba(32,201,151,0.30)`,
              }}
            >
              {APP_VERSION}
            </span>
          </Link>

          {/* Desktop nav */}
          <nav className="hidden lg:flex items-center gap-1 overflow-visible">
            <Link href={isAuthenticated ? "/overview" : "/login"} {...navLink("/")}>
              <Home className="w-4 h-4" />
              <span>Home</span>
            </Link>

            {isAuthenticated && (
              <>
                <Link href={warRoomPath} {...navLink(warRoomPath)} onMouseEnter={() => prefetchRoute("/war-room-live")}>
                  <Zap className="w-4 h-4" style={{ color: isActive(warRoomPath) ? BLUE : "#f59e0b" }} />
                  <span>War Room ⚡</span>
                  {isActive(warRoomPath) && (
                    <span className="absolute -bottom-px left-2 right-2 h-0.5 rounded-full" style={{ background: BLUE, opacity: 0.8 }} />
                  )}
                </Link>

                {nav.showWarReport && (
                <Link href="/war-report" {...navLink("/war-report")} onMouseEnter={() => prefetchRoute("/war-report")}>
                  <BarChart2 className="w-4 h-4" style={{ color: isActive("/war-report") ? BLUE : "#10b981" }} />
                  <span>War Report 📊</span>
                  {isActive("/war-report") && (
                    <span className="absolute -bottom-px left-2 right-2 h-0.5 rounded-full" style={{ background: BLUE, opacity: 0.8 }} />
                  )}
                </Link>
                )}

                {/* Trade Dropdown */}
                <TradeDropdown isActive={isActive} dropdownItem={dropdownItem} showH1H2={nav.showH1H2} />

                {/* Tools Dropdown */}
                <ToolsDropdown isActive={isActive} dropdownItem={dropdownItem} showTransfers={nav.showTransfers} />

                {/* Knowledge Dropdown — CEO / full viewers only */}
                {nav.showKnowledge && (
                <div className="relative" ref={dropdownRef}>
                  <button
                    onClick={() => setKnowledgeOpen((v) => !v)}
                    className="relative flex items-center gap-2 px-3.5 py-2 rounded-lg text-sm font-semibold transition-all duration-200 border"
                    style={isKnowledgeActive ? {
                      color: TEXT_ACTIVE, background: BLUE_DIM, borderColor: BLUE_BORDER,
                      boxShadow: `0 0 12px rgba(37,99,235,0.15)`,
                    } : {
                      color: TEXT_INACTIVE, background: "transparent", borderColor: "transparent",
                    }}
                  >
                    <BookOpen className="w-4 h-4" />
                    <span>Knowledge</span>
                    <ChevronDown className={`w-3.5 h-3.5 transition-transform duration-200 ${knowledgeOpen ? "rotate-180" : ""}`} />
                  </button>

                  {knowledgeOpen && (
                    <div
                      className="absolute end-0 top-full mt-2 w-52 rounded-2xl overflow-hidden z-50 animate-in fade-in slide-in-from-top-2 duration-150"
                      style={{
                        background: CARD_BG,
                        border: `1px solid ${BLUE_BORDER}`,
                        boxShadow: `0 8px 32px rgba(37,99,235,0.12), 0 2px 8px rgba(0,0,0,0.08)`,
                        backdropFilter: "blur(24px)",
                      }}
                    >
                      <div className="px-4 py-2.5 border-b" style={{ borderColor: BLUE_BORDER }}>
                        <p className="text-[10px] font-bold uppercase tracking-widest" style={{ color: BLUE }}>Knowledge Hub</p>
                      </div>
                      <div className="p-2 flex flex-col gap-0.5">
                        {[
                          { href: "/knowledge", icon: <Brain className="w-4 h-4 shrink-0" />,  label: "Knowledge Base" },
                          { href: "/videos",    icon: <Video className="w-4 h-4 shrink-0" />,  label: "Video Watch" },
                          { href: "/watchlist", icon: <Bookmark className="w-4 h-4 shrink-0" />, label: "Watchlist" },
                        ].map(({ href, icon, label }) => (
                          <Link
                            key={href}
                            href={href}
                            className={dropdownItem(href)}
                            style={dropdownItemStyle(href)}
                          >
                            <span>{icon}</span>
                            {label}
                          </Link>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
                )}

                {isAdmin && (<>
                {/* Settings Dropdown */}
                <div className="relative" ref={settingsRef}>
                  <button
                    onClick={() => setSettingsOpen((v) => !v)}
                    className="relative flex items-center gap-2 px-3.5 py-2 rounded-lg text-sm font-semibold transition-all duration-200 border"
                    style={isSettingsActive ? {
                      color: TEXT_ACTIVE, background: BLUE_DIM, borderColor: BLUE_BORDER,
                    } : {
                      color: TEXT_INACTIVE, background: "transparent", borderColor: "transparent",
                    }}
                  >
                    <Settings className="w-4 h-4" />
                    <span>Settings</span>
                    <ChevronDown className={`w-3.5 h-3.5 transition-transform duration-200 ${settingsOpen ? "rotate-180" : ""}`} />
                  </button>

                  {settingsOpen && (
                    <div
                      className="absolute end-0 top-full mt-2 w-52 rounded-2xl overflow-hidden z-50 animate-in fade-in slide-in-from-top-2 duration-150"
                      style={{
                        background: CARD_BG,
                        border: `1px solid ${BLUE_BORDER}`,
                        boxShadow: `0 8px 32px rgba(37,99,235,0.12), 0 2px 8px rgba(0,0,0,0.08)`,
                        backdropFilter: "blur(24px)",
                      }}
                    >
                      <div className="px-4 py-2.5 border-b" style={{ borderColor: BLUE_BORDER }}>
                        <p className="text-[10px] font-bold uppercase tracking-widest" style={{ color: BLUE }}>System</p>
                      </div>
                      <div className="p-2 flex flex-col gap-0.5">
                        {[
                          { href: "/settings", icon: <Settings className="w-4 h-4 shrink-0" />, label: "General Settings" },
                          { href: "/ibkr-account", icon: <Activity className="w-4 h-4 shrink-0" />, label: "IBKR Account" },
                          { href: "/logs", icon: <ScrollText className="w-4 h-4 shrink-0" />, label: "System Logs" },
                        ].map(({ href, icon, label }) => (
                          <Link
                            key={href}
                            href={href}
                            className={dropdownItem(href)}
                            style={dropdownItemStyle(href)}
                          >
                            <span>{icon}</span>
                            {label}
                          </Link>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
                </>)}{/* end admin-only settings */}
              </>
            )}
          </nav>

          {/* Auth — desktop */}
          <div className="hidden lg:flex items-center gap-3">
            {!authLoading && !isAuthenticated && !isLoginPage && (
              <Link
                href="/login"
                className="flex items-center gap-2 text-sm font-semibold px-4 py-2 rounded-lg transition-all duration-200"
                style={{
                  background: `linear-gradient(135deg, #2563EB 0%, #60A5FA 50%, #65A30D 100%)`,
                  color: "white",
                  boxShadow: `0 0 20px rgba(96,165,250,0.40), 0 0 40px rgba(32,201,151,0.15)`,
                }}
              >
                <LogIn className="w-4 h-4" />כניסה
              </Link>
            )}
            {isAuthenticated && user && (
              <div className="flex items-center gap-2.5 pl-3 border-l" style={{ borderColor: "rgba(96,165,250,0.20)" }}>
                <div
                  className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold shrink-0"
                  style={{
                    background: `linear-gradient(135deg, #2563EB, #65A30D)`,
                    color: "white",
                    boxShadow: `0 0 14px rgba(96,165,250,0.40)`,
                  }}
                >
                  {user.name?.[0]?.toUpperCase() ?? "U"}
                </div>
                <span className="hidden xl:inline text-sm max-w-[100px] truncate font-medium" style={{ color: "rgba(71,85,105,0.95)" }}>{user.name}</span>

                <button
                  onClick={() => logoutMutation.mutate()}
                  className="p-1.5 rounded-lg transition-all duration-150 hover:bg-white/10"
                  style={{ color: TEXT_INACTIVE }}
                  title="Sign out"
                >
                  <LogOut className="w-4 h-4" />
                </button>
              </div>
            )}
          </div>

          {/* Mobile: right side */}
          <div className="flex lg:hidden items-center gap-2">
            {isAuthenticated && user && (
              <div
                className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold shrink-0"
                style={{
                  background: `linear-gradient(135deg, #2563EB, #1D4ED8)`,
                  color: "white",
                  boxShadow: `0 0 10px rgba(37,99,235,0.30)`,
                }}
              >
                {user.name?.[0]?.toUpperCase() ?? "U"}
              </div>
            )}
            {!authLoading && !isAuthenticated && !isLoginPage && (
              <Link
                href="/login"
                className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg"
                style={{
                  background: `linear-gradient(135deg, #2563EB, #1D4ED8)`,
                  color: "white",
                }}
              >
                <LogIn className="w-3.5 h-3.5" />כניסה
              </Link>
            )}
            <button
              onClick={() => setMobileOpen((v) => !v)}
              className="p-2 rounded-lg transition-all duration-150"
              style={{ color: "#334155" }}
              aria-label="Toggle menu"
            >
              {mobileOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
            </button>
          </div>
        </div>
      </header>

      {/* ── Mobile Drawer ─────────────────────────────────────────────────────── */}
      {mobileOpen && (
        <div className="fixed inset-0 lg:hidden" onClick={() => setMobileOpen(false)} style={{ zIndex: Z.navShell - 1 }}>
          <div className="absolute inset-0 bg-slate-900/30 backdrop-blur-sm" />
          <div
            dir="rtl"
            className="absolute top-16 left-0 right-0 max-h-[calc(100vh-4rem)] overflow-y-auto animate-in slide-in-from-top-2 duration-200"
            style={{
              background: "rgba(255,255,255,0.99)",
              borderBottom: `1px solid rgba(15,23,42,0.08)`,
              boxShadow: `0 20px 60px rgba(15,23,42,0.18)`,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <nav className="p-4 flex flex-col gap-1">

              {/* ── HOME ── */}
              <MobileLink href={isAuthenticated ? "/overview" : "/login"} isActive={isActive("/overview") || location === "/"} icon={<Home className="w-5 h-5" />} label="Home" />

              {isAuthenticated ? (
                <>
                  <MobileLink href={warRoomPath} isActive={isActive(warRoomPath)} icon={<Zap className="w-5 h-5" style={{color:"#f59e0b"}} />} label="War Room LIVE ⚡" />

                  {/* ── TRADE section ── */}
                  <div className="mt-3 mb-1 px-2">
                    <p className="text-[10px] font-bold uppercase tracking-widest" style={{ color: "#f59e0b" }}>⚡ Trade</p>
                  </div>
                  <MobileLink href="/trade" isActive={isActive("/trade")} icon={<TrendingUp className="w-5 h-5" />} label="Trade Manager" />
                  {nav.showH1H2 && (
                    <MobileLink href="/h1h2" isActive={isActive("/h1h2")} icon={<PieChart className="w-5 h-5" />} label="H1H2 Holding" />
                  )}

                  {/* ── TOOLS section ── */}
                  <div className="mt-3 mb-1 px-2">
                    <p className="text-[10px] font-bold uppercase tracking-widest" style={{ color: BLUE }}>🛠 Tools</p>
                  </div>
                  <MobileLink href="/overview" isActive={isActive("/overview")} icon={<LayoutList className="w-5 h-5" />} label="Portfolio Overview" />
                  <MobileLink href="/catalogue" isActive={isActive("/catalogue")} icon={<Database className="w-5 h-5" />} label="Asset Catalogue" />
                  <MobileLink href="/dip-analysis" isActive={isActive("/dip-analysis")} icon={<TrendingDown className="w-5 h-5" />} label="Deep Analysis" />
                  <MobileLink href="/ai-insights" isActive={isActive("/ai-insights")} icon={<Brain className="w-5 h-5" style={{color:"#8b5cf6"}} />} label="AI Insights 🧠" />
                  <MobileLink href="/favorites" isActive={isActive("/favorites")} icon={<Star className="w-5 h-5" style={{color:"#f59e0b"}} />} label="Favorites ⭐" />
                  {nav.showTransfers && (
                    <MobileLink href="/money-transfers" isActive={isActive("/money-transfers")} icon={<ArrowLeftRight className="w-5 h-5" style={{color:"#2563EB"}} />} label="Transfer Ledger" />
                  )}

                  {/* ── KNOWLEDGE section ── */}
                  {nav.showKnowledge && (
                  <>
                  <div className="mt-3 mb-1 px-2">
                    <p className="text-[10px] font-bold uppercase tracking-widest" style={{ color: "#34d399" }}>📚 Knowledge</p>
                  </div>
                  <MobileLink href="/videos" isActive={isActive("/videos")} icon={<Video className="w-5 h-5" style={{color:"#34d399"}} />} label="Videos" />
                  <MobileLink href="/watchlist" isActive={isActive("/watchlist")} icon={<Bookmark className="w-5 h-5" style={{color:"#34d399"}} />} label="Watchlist" />
                  <MobileLink href="/knowledge" isActive={isActive("/knowledge")} icon={<BookOpen className="w-5 h-5" style={{color:"#34d399"}} />} label="Knowledge Base" />
                  </>
                  )}

                  {/* ── SYSTEM ── */}
                  {isAdmin && (
                    <>
                      <div className="mt-3 mb-1 px-2">
                        <p className="text-[10px] font-bold uppercase tracking-widest" style={{ color: "rgba(100,116,139,0.95)" }}>System</p>
                      </div>
                      <MobileLink href="/settings" isActive={isActive("/settings")} icon={<Settings className="w-5 h-5" />} label="Settings" />
                    </>
                  )}

                  {/* ── LOGOUT ── */}
                  <div className="mt-4 pt-4 border-t" style={{ borderColor: "rgba(96,165,250,0.15)" }}>
                    <button
                      onClick={() => { logoutMutation.mutate(); setMobileOpen(false); }}
                      className="w-full flex flex-row-reverse items-center justify-end gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-colors"
                      style={{ color: "#f87171", background: "rgba(239,68,68,0.08)" }}
                    >
                      {logoutMutation.isPending ? <Loader2 className="w-5 h-5 animate-spin" /> : <LogOut className="w-5 h-5" />}
                      Sign Out
                    </button>
                  </div>
                </>
              ) : (
                <MobileLink href="/login" isActive={isActive("/login")} icon={<LogIn className="w-5 h-5" />} label="Sign In" />
              )}
            </nav>
          </div>
        </div>
      )}
    </>
  );
}

// ─── MobileLink ───────────────────────────────────────────────────────────────
function MobileLink({ href, isActive, icon, label }: {
  href: string; isActive: boolean; icon: React.ReactNode; label: string;
}) {
  return (
    <Link
      href={href}
      className="flex flex-row-reverse items-center justify-end gap-3 px-3 py-2.5 rounded-xl text-sm font-semibold transition-all duration-150 border"
      style={isActive ? {
        color: "#60A5FA",
        background: "rgba(96,165,250,0.15)",
        borderColor: "rgba(96,165,250,0.25)",
      } : {
      color: "#334155",
      background: "transparent",
      borderColor: "transparent",
      }}
    >
      {icon}
      {label}
    </Link>
  );
}

// Re-export RootLayout for backward-compat with any cached tsserver state
export { RootLayout } from "./RootLayout";

// ─── RootLayout (app shell wrapper) ──────────────────────────────────────────
function _RootLayoutInline({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen" style={{ background: '#F4F6F8' }}>
      <GlobalNav />
      <main className="pb-24">
        {children}
      </main>
    </div>
  );
}
