import { useAuth } from "@/_core/hooks/useAuth";
import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import {
  TrendingUp, Zap, Shield, BarChart2, Brain, ArrowRight, Star, CheckCircle2, Mail, Lock, Eye, EyeOff, LogIn
} from "lucide-react";

const IMG_ICON = "/pwa-192.png";
const IMG_ICON_CDN = "https://d2xsxph8kpxj0f.cloudfront.net/310519663398668463/MmWmJbH77mYYXTZazVYpbM/pwa-icon-512-m26LYgtSqSRJ2wY8fubWek.png";
const IMG_HERO = "/pwa-192.png";
const IMG_HERO_CDN = "https://d2xsxph8kpxj0f.cloudfront.net/310519663398668463/MmWmJbH77mYYXTZazVYpbM/landing-hero-7TkJq8WMkjsrtN5YY72iyx.webp";

function BrandIcon({ className = "w-10 h-10" }: { className?: string }) {
  const [src, setSrc] = useState(IMG_ICON);
  return (
    <img
      src={src}
      alt="TradeSnow"
      className={`${className} rounded-xl object-cover`}
      onError={() => {
        if (src !== IMG_ICON_CDN) setSrc(IMG_ICON_CDN);
      }}
    />
  );
}

const FEATURES = [
  { icon: <TrendingUp className="w-4 h-4 text-[#2563EB]" />, text: "Trade Manager עם מעקב P&L בזמן אמת" },
  { icon: <Zap className="w-4 h-4 text-[#2563EB]" />, text: "Market Scan — 200+ נכסים מכל הסקטורים" },
  { icon: <Brain className="w-4 h-4 text-[#2563EB]" />, text: "ניתוח סרטוני YouTube עם AI מתקדם" },
  { icon: <BarChart2 className="w-4 h-4 text-[#2563EB]" />, text: "מנוע Ziv Score — דירוג נכסים 1-10" },
  { icon: <Shield className="w-4 h-4 text-[#2563EB]" />, text: "Backtest מלא על אסטרטגיות מסחר" },
];

export default function LoginPage() {
  const { isAuthenticated, loading, refresh } = useAuth();
  const [, navigate] = useLocation();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [localError, setLocalError] = useState("");
  const [localLoading, setLocalLoading] = useState(false);

  useEffect(() => {
    if (!loading && isAuthenticated) {
      navigate("/trade");
    }
  }, [isAuthenticated, loading, navigate]);

  const handleLocalLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError("");
    setLocalLoading(true);
    try {
      const res = await fetch("/api/local-auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password }),
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok) {
        setLocalError(data.error ?? "שגיאה בכניסה");
      } else {
        if (refresh) await refresh();
        navigate("/trade");
      }
    } catch {
      setLocalError("שגיאת רשת — נסה שוב");
    } finally {
      setLocalLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#F4F6F8] text-[#4A5568] flex overflow-hidden" dir="rtl">

      {/* ── Left panel: Branding ── */}
      <div className="hidden lg:flex flex-col flex-1 relative overflow-hidden bg-[#2563EB]">
        {/* Background image with blue overlay */}
        <div className="absolute inset-0">
          <img src={IMG_HERO} alt="" className="w-full h-full object-cover opacity-15"
            onError={(e) => { (e.target as HTMLImageElement).src = IMG_HERO_CDN; }} />
          <div className="absolute inset-0 bg-gradient-to-l from-[#2563EB] via-[#2563EB]/80 to-transparent" />
          <div className="absolute inset-0 bg-gradient-to-b from-[#1d4ed8]/40 via-transparent to-[#1e3a8a]/60" />
        </div>

        {/* Subtle grid overlay */}
        <div className="absolute inset-0 opacity-10"
          style={{
            backgroundImage: "linear-gradient(rgba(255,255,255,0.3) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.3) 1px, transparent 1px)",
            backgroundSize: "50px 50px"
          }}
        />

        {/* Glow orbs */}
        <div className="absolute top-1/3 left-1/4 w-80 h-80 bg-white/10 rounded-full blur-3xl animate-pulse" />
        <div className="absolute bottom-1/4 right-1/3 w-64 h-64 bg-[#65A30D]/20 rounded-full blur-3xl animate-pulse" style={{ animationDelay: "1.5s" }} />

        {/* Content */}
        <div className="relative z-10 flex flex-col h-full p-12">
          {/* Logo */}
          <div className="flex items-center gap-3 mb-auto">
            <BrandIcon className="w-10 h-10 shadow-lg ring-2 ring-white/30" />
            <div>
              <p className="font-black text-lg text-white leading-none">tradesnow.vip</p>
              <p className="text-blue-200 text-xs font-medium">פלטפורמת המסחר החכמה</p>
            </div>
          </div>

          {/* Main copy */}
          <div className="mb-12">
            <div className="inline-flex items-center gap-2 bg-white/15 border border-white/30 rounded-full px-4 py-1.5 text-white text-xs font-semibold mb-6">
              <Star className="w-3.5 h-3.5 fill-current text-yellow-300" />
              AI-Powered Trading Intelligence
            </div>

            <h2 className="text-4xl xl:text-5xl font-black leading-tight mb-4">
              <span className="text-white">תסחר</span>
              <span className="text-[#65A30D]"> חכם יותר.</span>
              <br />
              <span className="text-white">תרוויח</span>
              <span className="text-yellow-300"> יותר.</span>
            </h2>

            <p className="text-blue-100 text-base leading-relaxed max-w-md">
              מערכת AI מתקדמת שמנתחת סרטוני YouTube, סורקת 200+ נכסים ומנהלת את הפוזיציות שלך — הכל במקום אחד.
            </p>
          </div>

          {/* Feature list */}
          <div className="space-y-3 mb-8">
            {FEATURES.map((f, i) => (
              <div key={i} className="flex items-center gap-3">
                <div className="w-7 h-7 rounded-lg bg-white/15 border border-white/25 flex items-center justify-center shrink-0">
                  <span className="text-white [&>svg]:text-white">{f.icon}</span>
                </div>
                <span className="text-blue-100 text-sm">{f.text}</span>
                <CheckCircle2 className="w-4 h-4 text-[#65A30D] shrink-0 mr-auto" />
              </div>
            ))}
          </div>

          {/* Stats row */}
          <div className="flex items-center gap-6 border-t border-white/20 pt-6">
            {[
              { value: "200+", label: "נכסים" },
              { value: "10/10", label: "Ziv Score" },
              { value: "6", label: "מודולים" },
            ].map((s) => (
              <div key={s.label} className="text-center">
                <p className="text-xl font-black text-yellow-300">{s.value}</p>
                <p className="text-xs text-blue-200">{s.label}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Right panel: Login form ── */}
      <div className="flex flex-col items-center justify-center w-full lg:w-[420px] xl:w-[480px] shrink-0 p-8 relative bg-white">
        {/* Subtle top accent */}
        <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-[#2563EB] via-[#65A30D] to-[#2563EB]" />

        <div className="relative z-10 w-full max-w-sm">
          {/* Mobile logo */}
          <div className="flex items-center justify-center gap-3 mb-10 lg:hidden">
            <BrandIcon className="w-10 h-10 shadow-lg" />
            <div>
              <p className="font-black text-lg text-[#2563EB] leading-none">tradesnow.vip</p>
              <p className="text-[#4A5568] text-xs font-medium">פלטפורמת המסחר החכמה</p>
            </div>
          </div>

          {/* Card */}
          <div className="bg-white border border-gray-200 rounded-3xl p-8 shadow-xl">
            {/* Header */}
            <div className="text-center mb-8">
              <div className="w-16 h-16 rounded-2xl overflow-hidden mx-auto mb-4 shadow-lg ring-2 ring-[#2563EB]/20 flex items-center justify-center bg-[#2563EB]/10">
                <BrandIcon className="w-full h-full" />
              </div>
              <h1 className="text-2xl font-black text-[#1a202c] mb-1">ברוך הבא</h1>
              <p className="text-[#4A5568] text-sm">הזן אימייל וסיסמא כדי להיכנס</p>
            </div>

            {/* ── Local user login form ── */}
            <form onSubmit={handleLocalLogin} className="space-y-3">
              <div className="relative">
                <Mail className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
                <input
                  type="email"
                  placeholder="כתובת אימייל"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  className="w-full bg-[#F4F6F8] border border-gray-200 rounded-xl px-4 py-3 pr-10 text-sm text-[#1a202c] placeholder-gray-400 focus:outline-none focus:border-[#2563EB] focus:ring-2 focus:ring-[#2563EB]/20 transition-all"
                  dir="ltr"
                />
              </div>
              <div className="relative">
                <Lock className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none z-10" />
                <input
                  type={showPw ? "text" : "password"}
                  placeholder="סיסמה"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  className="w-full bg-[#F4F6F8] border border-gray-200 rounded-xl py-3 pr-10 pl-12 text-sm text-right placeholder:text-right text-[#1a202c] placeholder-gray-400 focus:outline-none focus:border-[#2563EB] focus:ring-2 focus:ring-[#2563EB]/20 transition-all"
                  dir="ltr"
                  autoComplete="current-password"
                />
                <button
                  type="button"
                  tabIndex={-1}
                  aria-label={showPw ? "הסתר סיסמה" : "הצג סיסמה"}
                  className="absolute left-2 top-1/2 -translate-y-1/2 z-10 p-1.5 text-gray-400 hover:text-[#2563EB] transition-colors"
                  onClick={() => setShowPw(!showPw)}
                >
                  {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>

              {localError && (
                <p className="text-[#FF6B6B] text-xs text-center bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                  {localError}
                </p>
              )}

              <button
                type="submit"
                disabled={localLoading || !email || !password}
                className="w-full flex items-center justify-center gap-2 bg-[#2563EB] hover:bg-[#1d4ed8] disabled:opacity-50 disabled:cursor-not-allowed text-white font-bold py-3 px-6 rounded-2xl text-sm transition-all duration-200 hover:scale-[1.01] active:scale-[0.99] shadow-md shadow-[#2563EB]/30"
              >
                {localLoading ? (
                  <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                ) : (
                  <LogIn className="w-4 h-4" />
                )}
                {localLoading ? "מתחבר..." : "כנס"}
              </button>
            </form>



            {/* Security note */}
            <div className="flex items-center justify-center gap-2 mt-4">
              <Shield className="w-3.5 h-3.5 text-gray-400" />
              <p className="text-gray-400 text-xs">כניסה מאובטחת</p>
            </div>

            {/* Features mini-list (mobile) */}
            <div className="mt-6 pt-6 border-t border-gray-100 lg:hidden space-y-2">
              {FEATURES.slice(0, 3).map((f, i) => (
                <div key={i} className="flex items-center gap-2 text-[#4A5568] text-xs">
                  {f.icon}
                  <span>{f.text}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Back to home */}
          <div className="text-center mt-6">
            <a href="/" className="text-gray-400 hover:text-[#2563EB] text-sm transition-colors inline-flex items-center gap-1">
              <ArrowRight className="w-3.5 h-3.5 rotate-180" />
              חזרה לדף הבית
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
