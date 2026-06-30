import { useEffect, useState, useRef } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";  
import { TrendingUp, TrendingDown, ArrowRight } from "lucide-react";


// ── Fear & Greed colours ───────────────────────────────────────────────────────
function fngLabel(value: number): string {
  if (value <= 25) return "פחד קיצוני";
  if (value <= 45) return "פחד";
  if (value <= 55) return "ניטרלי";
  if (value <= 75) return "חמדנות";
  return "חמדנות קיצונית";
}


// ── VIX Gauge (Splash) — with needle animation ───────────────────────────────
function VixGaugeSplash({ value, week52Low, week52High }: { value: number; week52Low: number; week52High: number }) {
  const [animatedValue, setAnimatedValue] = useState(0);
  const animRef = useRef<number | null>(null);
  const startTimeRef = useRef<number | null>(null);
  const DURATION = 1200;
  useEffect(() => {
    if (value === 0) return;
    startTimeRef.current = null;
    const animate = (timestamp: number) => {
      if (startTimeRef.current === null) startTimeRef.current = timestamp;
      const elapsed = timestamp - startTimeRef.current;
      const progress = Math.min(elapsed / DURATION, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      setAnimatedValue(eased * value);
      if (progress < 1) {
        animRef.current = requestAnimationFrame(animate);
      } else {
        setAnimatedValue(value);
      }
    };
    animRef.current = requestAnimationFrame(animate);
    return () => { if (animRef.current) cancelAnimationFrame(animRef.current); };
  }, [value]);

  const MIN_VIX = 10, MAX_VIX = 40;
  const clamp = (v: number) => Math.max(MIN_VIX, Math.min(MAX_VIX, v));
  const toPercent = (v: number) => ((clamp(v) - MIN_VIX) / (MAX_VIX - MIN_VIX)) * 100;
  const pct = toPercent(value);
  const animPct = toPercent(animatedValue);
  const zone1End = toPercent(20);
  const zone2End = toPercent(30);
  const zones = [
    { from: 0,        to: zone1End, baseColor: "#e5e7eb", activeColor: "#22c55e" },
    { from: zone1End, to: zone2End, baseColor: "#e5e7eb", activeColor: "#f59e0b" },
    { from: zone2End, to: 100,      baseColor: "#e5e7eb", activeColor: "#ef4444" },
  ];
  const safeIdx = pct < zone1End ? 0 : pct < zone2End ? 1 : 2;
  const animSafeIdx = animPct < zone1End ? 0 : animPct < zone2End ? 1 : 2;
  const activeColor = zones[safeIdx].activeColor;
  const animActiveColor = zones[animSafeIdx].activeColor;
  // Compact SVG: smaller viewBox
  const cx = 160, cy = 145;
  const rOuter = 120, rInner = 68;
  const GAP_DEG = 1.5;
  function valToRad(v: number) {
    return ((-180 + (v / 100) * 180) * Math.PI) / 180;
  }
  function donutArc(fromV: number, toV: number, ro: number, ri: number, gapDeg = 0) {
    const gapRad = (gapDeg * Math.PI) / 180;
    const a1 = valToRad(fromV) + gapRad;
    const a2 = valToRad(toV) - gapRad;
    const large = (toV - fromV) > 50 ? 1 : 0;
    const ox1 = cx + ro * Math.cos(a1), oy1 = cy + ro * Math.sin(a1);
    const ox2 = cx + ro * Math.cos(a2), oy2 = cy + ro * Math.sin(a2);
    const ix1 = cx + ri * Math.cos(a2), iy1 = cy + ri * Math.sin(a2);
    const ix2 = cx + ri * Math.cos(a1), iy2 = cy + ri * Math.sin(a1);
    return `M ${ox1} ${oy1} A ${ro} ${ro} 0 ${large} 1 ${ox2} ${oy2} L ${ix1} ${iy1} A ${ri} ${ri} 0 ${large} 0 ${ix2} ${iy2} Z`;
  }
  const needleRad = valToRad(animPct);
  const needleLen = rOuter - 6;
  const nx = cx + needleLen * Math.cos(needleRad);
  const ny = cy + needleLen * Math.sin(needleRad);
  const tickVixValues = [10, 20, 30, 40];
  const vixLabel = value < 20 ? "נמוך (רגוע)" : value < 30 ? "בינוני (ממוצע)" : "גבוה (מתוח)";
  return (
    <div className="flex flex-col items-center w-full">
      <svg viewBox="0 0 320 165" className="w-full" style={{ overflow: "visible", maxWidth: "180px" }}>
        {zones.map((zone, i) => (
          <path key={zone.from} d={donutArc(zone.from, zone.to, rOuter, rInner, GAP_DEG)}
            fill={i === animSafeIdx ? zone.activeColor : zone.baseColor}
            opacity={i === animSafeIdx ? 1 : 0.7} />
        ))}
        {tickVixValues.map(v => {
          const p = toPercent(v);
          const a = valToRad(p);
          const lr = rOuter + 20;
          return (
            <text key={v} x={cx + lr * Math.cos(a)} y={cy + lr * Math.sin(a)}
              textAnchor="middle" dominantBaseline="middle"
              fontSize="11" fill="#4b5563" fontFamily="sans-serif" fontWeight="600">{v}</text>
          );
        })}
        <line x1={cx} y1={cy} x2={nx} y2={ny} stroke={animActiveColor} strokeWidth={3} strokeLinecap="round" />
        <circle cx={cx} cy={cy} r={8} fill="#374151" />
        <circle cx={cx} cy={cy} r={4} fill="#9ca3af" />
      </svg>
      {/* Value + label — compact */}
      <div className="flex flex-col items-center -mt-1">
        <div className="text-xl font-black tabular-nums" style={{ color: activeColor, transition: "color 0.3s" }}>{value.toFixed(2)}</div>
        <div className="text-[11px] font-bold mt-0.5" style={{ color: activeColor }}>{vixLabel}</div>
        <div className="text-[9px] font-semibold text-gray-400 uppercase tracking-widest">מד VIX</div>
        <div className="text-[9px] text-gray-400">{week52Low.toFixed(0)}–{week52High.toFixed(0)}</div>
      </div>
    </div>
  );
}

// ── SVG half-circle gauge (CNN-style, white bg) ───────────────────────────────
function FearGreedGauge({ value, lastUpdated }: { value: number; lastUpdated?: string | null }) {
  // Animate needle from 0 → value over ~1.2s using easeOutCubic
  const [animatedValue, setAnimatedValue] = useState(0);
  const animRef = useRef<number | null>(null);
  const startTimeRef = useRef<number | null>(null);
  const DURATION = 1200; // ms

  useEffect(() => {
    if (value === 0) return;
    startTimeRef.current = null;
    const animate = (timestamp: number) => {
      if (startTimeRef.current === null) startTimeRef.current = timestamp;
      const elapsed = timestamp - startTimeRef.current;
      const progress = Math.min(elapsed / DURATION, 1);
      // easeOutCubic
      const eased = 1 - Math.pow(1 - progress, 3);
      setAnimatedValue(Math.round(eased * value));
      if (progress < 1) {
        animRef.current = requestAnimationFrame(animate);
      } else {
        setAnimatedValue(value);
      }
    };
    animRef.current = requestAnimationFrame(animate);
    return () => { if (animRef.current) cancelAnimationFrame(animRef.current); };
  }, [value]);

  const zones = [
    { from: 0,  to: 25,  label: ["EXTREME", "FEAR"],  baseColor: "#e5e7eb", activeColor: "#ef4444" },
    { from: 25, to: 45,  label: ["FEAR"],              baseColor: "#e5e7eb", activeColor: "#f97316" },
    { from: 45, to: 55,  label: ["NEUTRAL"],           baseColor: "#e5e7eb", activeColor: "#eab308" },
    { from: 55, to: 75,  label: ["GREED"],             baseColor: "#e5e7eb", activeColor: "#22c55e" },
    { from: 75, to: 100, label: ["EXTREME", "GREED"],  baseColor: "#e5e7eb", activeColor: "#16a34a" },
  ];

  const cx = 200, cy = 185;
  const rOuter = 155, rInner = 88;
  const GAP_DEG = 1.5;
  // Use animatedValue for needle + active zone highlight; use real value for label/color
  const activeZoneIdx = zones.findIndex(z => value >= z.from && value <= z.to);
  const animActiveZoneIdx = zones.findIndex(z => animatedValue >= z.from && animatedValue <= z.to);

  function valToRad(v: number) {
    return ((-180 + (v / 100) * 180) * Math.PI) / 180;
  }

  function donutArc(fromV: number, toV: number, ro: number, ri: number, gapDeg = 0) {
    const gapRad = (gapDeg * Math.PI) / 180;
    const a1 = valToRad(fromV) + gapRad;
    const a2 = valToRad(toV) - gapRad;
    const large = (toV - fromV) > 50 ? 1 : 0;
    const ox1 = cx + ro * Math.cos(a1), oy1 = cy + ro * Math.sin(a1);
    const ox2 = cx + ro * Math.cos(a2), oy2 = cy + ro * Math.sin(a2);
    const ix1 = cx + ri * Math.cos(a2), iy1 = cy + ri * Math.sin(a2);
    const ix2 = cx + ri * Math.cos(a1), iy2 = cy + ri * Math.sin(a1);
    return `M ${ox1} ${oy1} A ${ro} ${ro} 0 ${large} 1 ${ox2} ${oy2} L ${ix1} ${iy1} A ${ri} ${ri} 0 ${large} 0 ${ix2} ${iy2} Z`;
  }

  // Needle follows animatedValue
  const needleRad = valToRad(animatedValue);
  const needleLen = rOuter - 8;
  const nx = cx + needleLen * Math.cos(needleRad);
  const ny = cy + needleLen * Math.sin(needleRad);

  const ticks = [0, 25, 50, 75, 100];
  const label = fngLabel(value);
  const activeColor = zones[activeZoneIdx]?.activeColor ?? "#6b7280";
  const animActiveColor = zones[animActiveZoneIdx]?.activeColor ?? "#6b7280";

  return (
    <div className="flex flex-col items-center w-full">
      <svg viewBox="0 0 400 215" className="w-full" style={{ overflow: "visible", maxWidth: "200px" }}>
        {/* Zone arcs */}
        {zones.map((zone, i) => (
          <path
            key={zone.from}
            d={donutArc(zone.from, zone.to, rOuter, rInner, GAP_DEG)}
            fill={i === animActiveZoneIdx ? zone.activeColor : zone.baseColor}
            opacity={i === animActiveZoneIdx ? 1 : 0.7}
          />
        ))}

        {/* Tick dots at zone boundaries */}
        {ticks.map(v => {
          const a = valToRad(v);
          const tr = rOuter + 10;
          return <circle key={v} cx={cx + tr * Math.cos(a)} cy={cy + tr * Math.sin(a)} r={3} fill="#9ca3af" />;
        })}

        {/* Tick number labels */}
        {ticks.map(v => {
          const a = valToRad(v);
          const lr = rOuter + 26;
          return (
            <text key={v} x={cx + lr * Math.cos(a)} y={cy + lr * Math.sin(a)}
              textAnchor="middle" dominantBaseline="middle"
              fontSize="12" fill="#4b5563" fontFamily="sans-serif" fontWeight="600">
              {v}
            </text>
          );
        })}

        {/* Zone labels outside arc */}
        {zones.map((zone, i) => {
          const isActive = i === activeZoneIdx;
          const mid = (zone.from + zone.to) / 2;
          const a = valToRad(mid);
          const lr = rOuter + 54;
          const lx = cx + lr * Math.cos(a);
          const ly = cy + lr * Math.sin(a);
          return (
            <text key={zone.from} textAnchor="middle" fontSize="10"
              fill={isActive ? zones[i].activeColor : "#9ca3af"} fontFamily="sans-serif"
              fontWeight={isActive ? "800" : "600"}
              style={{ textTransform: "uppercase", letterSpacing: "0.06em" }}>
              {zone.label.map((line, li) => (
                <tspan key={li} x={lx} y={ly + (li - (zone.label.length - 1) / 2) * 13}>{line}</tspan>
              ))}
            </text>
          );
        })}

        {/* Needle */}
        <line x1={cx} y1={cy} x2={nx} y2={ny} stroke={animActiveColor} strokeWidth={4} strokeLinecap="round" />
        <circle cx={cx} cy={cy} r={11} fill="#374151" />
        <circle cx={cx} cy={cy} r={5} fill="#111827" />

      </svg>
      <div className="text-xl font-black -mt-1 tabular-nums" style={{ color: activeColor, transition: 'color 0.3s' }}>{animatedValue}</div>
      <div className="text-[11px] font-bold tracking-wide mt-0.5" style={{ color: activeColor }}>{label}</div>
      <div className="text-[9px] text-gray-400 mt-0.5 uppercase tracking-widest font-semibold">Fear &amp; Greed</div>
      {lastUpdated && (
        <div className="text-[9px] text-gray-400">{lastUpdated}</div>
      )}
    </div>
  );
}

// ── Index card ────────────────────────────────────────────────────────────────
type MarketState = "PRE" | "POST" | "REGULAR" | "CLOSED";

function IndexCard({
  name,
  price,
  changePercent,
  marketState = "CLOSED",
  isToday = false,
  preMarketPrice,
  preMarketChangePercent,
  postMarketPrice,
  postMarketChangePercent,
  isHoliday = false,
  isHalfDay = false,
  secondaryLabel,
  secondaryChangePercent,
}: {
  name: string;
  price: number | null;
  changePercent: number | null;
  marketState?: MarketState;
  isToday?: boolean;
  preMarketPrice?: number | null;
  preMarketChangePercent?: number | null;
  postMarketPrice?: number | null;
  postMarketChangePercent?: number | null;
  isHoliday?: boolean;
  isHalfDay?: boolean;
  secondaryLabel?: string;
  secondaryChangePercent?: number | null;
}) {
  const displayPrice =
    marketState === "PRE" && preMarketPrice != null ? preMarketPrice :
    marketState === "POST" && postMarketPrice != null ? postMarketPrice :
    price;

  const displayChangePct =
    marketState === "PRE" && preMarketChangePercent != null ? preMarketChangePercent :
    marketState === "POST" && postMarketChangePercent != null ? postMarketChangePercent :
    changePercent;

  const isPos = (displayChangePct ?? 0) >= 0;
  const changeColor = isPos ? "#16a34a" : "#dc2626";

  const isStale = !isToday && marketState === "CLOSED";

  const stateLabel =
    marketState === "PRE" ? "טרום" :
    marketState === "POST" ? "אחרי" :
    isHalfDay ? "חצי" :
    isStale ? "סגור" : null;

  return (
    <div
      className="flex-1 rounded-xl p-3 min-w-0 border"
      style={{
        background: "#ffffff",
        borderColor: isHoliday ? "#fde68a" : isStale ? "#e5e7eb" : "#dbeafe",
        boxShadow: "0 1px 4px rgba(0,0,0,0.07)",
      }}
    >
      {/* Header row: name + state badge */}
      <div className="flex items-center justify-between mb-1.5">
        <div className="text-[10px] font-bold text-gray-500 uppercase tracking-wider truncate">
          {name}
        </div>
        {stateLabel && (
          <div className={`text-[8px] font-bold px-1.5 py-0.5 rounded-full uppercase tracking-wide flex-shrink-0 ml-1 ${
            marketState === "PRE" ? "bg-blue-100 text-blue-700" :
            marketState === "POST" ? "bg-purple-100 text-purple-700" :
            isStale ? "bg-gray-100 text-gray-500" :
            "bg-amber-100 text-amber-700"
          }`}>
            {stateLabel}
          </div>
        )}
      </div>

      {displayPrice != null ? (
        <>
          <div className={`text-sm font-extrabold leading-tight tabular-nums ${isStale ? "text-gray-400" : "text-gray-900"}`}>
            {displayPrice.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
          </div>
          <div
            className="flex items-center gap-0.5 mt-1"
            style={{ color: isStale ? "#9ca3af" : changeColor }}
          >
            {isPos ? (
              <TrendingUp className="w-3 h-3 flex-shrink-0" />
            ) : (
              <TrendingDown className="w-3 h-3 flex-shrink-0" />
            )}
            <span className="text-xs font-bold">
              {isPos ? "+" : ""}
              {(displayChangePct ?? 0).toFixed(2)}%
            </span>
          </div>
          {secondaryChangePercent != null && secondaryLabel && (
            <div className="flex items-center gap-0.5 mt-0.5">
              <span className="text-[9px] text-gray-400 font-semibold">{secondaryLabel}</span>
              <span
                className="text-[10px] font-bold"
                style={{ color: isStale ? "#9ca3af" : secondaryChangePercent >= 0 ? "#16a34a" : "#dc2626" }}
              >
                {secondaryChangePercent >= 0 ? "+" : ""}{secondaryChangePercent.toFixed(2)}%
              </span>
            </div>
          )}
        </>
      ) : isHoliday ? (
        <div className="text-amber-500 text-[10px] font-bold mt-1 uppercase tracking-wide">🎌 חג</div>
      ) : (
        <div className="text-gray-300 text-sm mt-1">—</div>
      )}
    </div>
  );
}

// ── Progress bar for countdown ────────────────────────────────────────────────
function CountdownBar({ total, remaining }: { total: number; remaining: number }) {
  const pct = ((total - remaining) / total) * 100;
  return (
    <div className="w-full h-1 rounded-full bg-gray-200 overflow-hidden">
      <div
        className="h-full rounded-full transition-all duration-1000 ease-linear"
        style={{
          width: `${pct}%`,
          background: "linear-gradient(90deg, #2563EB, #60a5fa)",
        }}
      />
    </div>
  );
}

// ── Main SplashScreen ─────────────────────────────────────────────────────────
const REDIRECT_SECONDS = 7;

export default function SplashScreen() {
  const [, navigate] = useLocation();
  const [countdown, setCountdown] = useState(REDIRECT_SECONDS);
  const [visible, setVisible] = useState(false);
  const redirected = useRef(false);
  const utils = trpc.useUtils();

  // Fade-in on mount
  useEffect(() => {
    const t = setTimeout(() => setVisible(true), 50);
    return () => clearTimeout(t);
  }, []);

  const { data, isLoading } = trpc.splash.getMarketData.useQuery(undefined, {
    staleTime: 60_000,
    retry: 1,
  });

  // ── Prefetch IBKR + portfolio data in background while splash is showing ──
  useEffect(() => {
    // 1. Start IBKR session in background (fire-and-forget)
    fetch("/api/ibind/session/start", { method: "POST" }).catch(() => {});

    // 2. Prefetch portfolio data so Overview loads instantly
    utils.portfolio.getState.prefetch(undefined, { staleTime: 30_000 }).catch(() => {});
    utils.holding2.list.prefetch(undefined, { staleTime: 30_000 }).catch(() => {});
    utils.forex.getRate.prefetch(undefined, { staleTime: 60 * 60_000 }).catch(() => {});
    utils.forex.getFxPnl24h.prefetch(undefined, { staleTime: 5 * 60_000 }).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Countdown + auto-redirect
  useEffect(() => {
    const interval = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(interval);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  // Redirect when countdown reaches 0
  useEffect(() => {
    if (countdown === 0 && !redirected.current) {
      redirected.current = true;
      navigate("/overview");
    }
  }, [countdown, navigate]);

  const handleContinue = () => {
    if (!redirected.current) {
      redirected.current = true;
      navigate("/overview");
    }
  };

  const fng    = data?.fearAndGreed;
  const vixData = data?.vix;
  const ta35   = data?.ta35;
  const sp500  = data?.sp500;
  const nasdaq = data?.nasdaq;
  const qqq    = data?.qqq;
  const flags  = data?.marketFlags;

  return (
    <div
      className="h-screen overflow-hidden flex flex-col items-center justify-between px-4 py-3"
      style={{ background: "linear-gradient(160deg, #f0f4ff 0%, #f9fafb 60%, #fff 100%)" }}
    >
      <div
        className="w-full max-w-sm flex flex-col items-center gap-3 flex-1 justify-between"
        style={{
          opacity: visible ? 1 : 0,
          transform: visible ? "translateY(0)" : "translateY(16px)",
          transition: "opacity 0.6s ease, transform 0.6s ease",
        }}
      >
        {/* ── Logo + Elza header ── */}
        <div className="flex flex-col items-center gap-1 pt-1 pb-0.5">
          <div className="flex items-center gap-2">
            <div
              className="flex items-center justify-center rounded-2xl font-black text-white shadow-lg"
              style={{
                width: 48, height: 48,
                background: "linear-gradient(135deg, #1e3a8a 0%, #1d4ed8 60%, #3b82f6 100%)",
                fontSize: 20, letterSpacing: "-1px",
                boxShadow: "0 4px 20px rgba(37,99,235,0.4)",
              }}
            >
              TS
            </div>
            <div className="flex flex-col">
              <span className="font-black text-gray-900 leading-tight" style={{ fontSize: 18 }}>TradeSnow</span>
              <span className="text-[10px] font-semibold text-blue-500 uppercase tracking-widest leading-tight">Powered by Elza ✦</span>
            </div>
          </div>
        </div>

        {/* ── Market index cards — 3 columns ── */}
        <div className="grid grid-cols-3 gap-2 w-full">
          <IndexCard
            name="TA-35"
            price={ta35?.price ?? null}
            changePercent={ta35?.changePercent ?? null}
            marketState={ta35?.marketState ?? "CLOSED"}
            isToday={ta35?.isToday ?? false}
            isHoliday={flags?.taseIsHoliday}
          />
          <IndexCard
            name="S&P 500"
            price={sp500?.price ?? null}
            changePercent={sp500?.changePercent ?? null}
            marketState={sp500?.marketState ?? "CLOSED"}
            isToday={sp500?.isToday ?? false}
            preMarketPrice={sp500?.preMarketPrice}
            preMarketChangePercent={sp500?.preMarketChangePercent}
            postMarketPrice={sp500?.postMarketPrice}
            postMarketChangePercent={sp500?.postMarketChangePercent}
            isHoliday={flags?.usIsHoliday}
            isHalfDay={flags?.usIsHalfDay}
          />
          <IndexCard
            name="NASDAQ"
            price={nasdaq?.price ?? null}
            changePercent={nasdaq?.changePercent ?? null}
            marketState={nasdaq?.marketState ?? "CLOSED"}
            isToday={nasdaq?.isToday ?? false}
            preMarketPrice={nasdaq?.preMarketPrice}
            preMarketChangePercent={nasdaq?.preMarketChangePercent}
            postMarketPrice={nasdaq?.postMarketPrice}
            postMarketChangePercent={nasdaq?.postMarketChangePercent}
            isHoliday={flags?.usIsHoliday}
            isHalfDay={flags?.usIsHalfDay}
            secondaryLabel="QQQ"
            secondaryChangePercent={qqq?.changePercent ?? null}
          />
        </div>

        {/* ── Divider ── */}
        <div className="w-full h-px" style={{ background: "#E5E7EB" }} />

        {/* ── Fear & Greed + VIX side-by-side ── */}
        <div className="flex w-full items-start justify-center gap-2">
          {/* Fear & Greed */}
          <div className="flex-1 flex flex-col items-center">
            {isLoading || !fng ? (
              <div className="flex flex-col items-center gap-2 py-4">
                <div
                  className="w-8 h-8 border-2 border-t-transparent rounded-full animate-spin"
                  style={{ borderColor: "#2563EB", borderTopColor: "transparent" }}
                />
                <span className="text-[10px] font-medium" style={{ color: "#6B7280" }}>טוען...</span>
              </div>
            ) : (
              <FearGreedGauge value={fng.value} lastUpdated={fng.lastUpdated} />
            )}
          </div>
          {/* Vertical divider */}
          <div className="w-px self-stretch" style={{ background: "#E5E7EB" }} />
          {/* VIX */}
          <div className="flex-1 flex flex-col items-center">
            {vixData ? (
              <VixGaugeSplash value={vixData.value} week52Low={vixData.week52Low} week52High={vixData.week52High} />
            ) : (
              <div className="flex flex-col items-center gap-2 py-4">
                <div className="w-8 h-8 border-2 border-t-transparent rounded-full animate-spin"
                  style={{ borderColor: "#2563EB", borderTopColor: "transparent" }} />
              </div>
            )}
          </div>
        </div>

        {/* ── Countdown bar ── */}
        <div className="w-full">
          <CountdownBar total={REDIRECT_SECONDS} remaining={countdown} />
        </div>

        {/* ── Continue button ── */}
        <button
          onClick={handleContinue}
          className="w-full flex items-center justify-center gap-2 font-bold rounded-2xl transition-all duration-150 active:scale-95 hover:opacity-90"
          style={{
            background: "linear-gradient(135deg, #2563EB 0%, #1d4ed8 100%)",
            color: "white",
            boxShadow: "0 4px 24px rgba(37,99,235,0.30)",
            minHeight: "52px",
            fontSize: "18px",
          }}
        >
          <span>המשך ל-Overview</span>
          <ArrowRight className="w-5 h-5" />
          <span className="font-normal" style={{ color: "rgba(219,234,254,0.9)", fontSize: "14px" }}>({countdown})</span>
        </button>

      </div>
    </div>
  );
}
