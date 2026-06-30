import { Link } from "wouter";
import { useAuth } from "@/_core/hooks/useAuth";
import {
  TrendingUp, Brain, Zap, BarChart2, BookOpen, FlaskConical,
  ArrowRight, CheckCircle2, Star, Trophy, Target, Shield,
  Youtube, ChevronDown
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";

// ─── Image CDN URLs ───────────────────────────────────────────────────────────
const IMG_HERO    = "https://d2xsxph8kpxj0f.cloudfront.net/310519663398668463/MmWmJbH77mYYXTZazVYpbM/landing-hero-7TkJq8WMkjsrtN5YY72iyx.webp";
const IMG_SUCCESS = "https://d2xsxph8kpxj0f.cloudfront.net/310519663398668463/MmWmJbH77mYYXTZazVYpbM/landing-success-PvPpF22XYX4qgbHrTCnfo2.webp";
const IMG_AI      = "https://d2xsxph8kpxj0f.cloudfront.net/310519663398668463/MmWmJbH77mYYXTZazVYpbM/landing-ai-jUkjmBKK9wGxJWk35wLUoV.webp";
const IMG_CHART   = "https://d2xsxph8kpxj0f.cloudfront.net/310519663398668463/MmWmJbH77mYYXTZazVYpbM/landing-chart-Gd336EYLtdGE9aUhbDqqDN.webp";
const IMG_VICTORY = "https://d2xsxph8kpxj0f.cloudfront.net/310519663398668463/MmWmJbH77mYYXTZazVYpbM/landing-victory-YYPHcoKX9yMRAChXkQ8mtv.webp";

// ─── Animated counter ─────────────────────────────────────────────────────────
function AnimatedCounter({ target, suffix = "", prefix = "" }: { target: number; suffix?: string; prefix?: string }) {
  const [count, setCount] = useState(0);
  const ref = useRef<HTMLSpanElement>(null);
  const started = useRef(false);

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !started.current) {
          started.current = true;
          const duration = 1800;
          const steps = 60;
          const increment = target / steps;
          let current = 0;
          const timer = setInterval(() => {
            current += increment;
            if (current >= target) { setCount(target); clearInterval(timer); }
            else setCount(Math.floor(current));
          }, duration / steps);
        }
      },
      { threshold: 0.5 }
    );
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, [target]);

  return <span ref={ref}>{prefix}{count.toLocaleString()}{suffix}</span>;
}

// ─── Feature card ─────────────────────────────────────────────────────────────
function FeatureCard({
  icon, title, desc, href, img, badge
}: {
  icon: React.ReactNode; title: string; desc: string; href: string; img: string; badge?: string;
}) {
  return (
    <Link href={href}>
      <div className="group relative overflow-hidden rounded-2xl border border-white/10 bg-white/5 backdrop-blur-sm hover:bg-white/10 transition-all duration-300 hover:scale-[1.02] hover:shadow-2xl hover:shadow-blue-500/10 cursor-pointer h-full">
        {badge && (
          <div className="absolute top-3 right-3 z-10 bg-gradient-to-r from-amber-400 to-orange-500 text-white text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wide">
            {badge}
          </div>
        )}
        <div className="relative h-44 overflow-hidden">
          <img src={img} alt={title} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" />
          <div className="absolute inset-0 bg-gradient-to-t from-slate-900 via-slate-900/40 to-transparent" />
          <div className="absolute bottom-3 left-4 p-2 rounded-xl bg-[#2563EB]/20 backdrop-blur-sm border border-[#2563EB]/30">
            {icon}
          </div>
        </div>
        <div className="p-5">
          <h3 className="text-white font-bold text-base mb-2 group-hover:text-blue-300 transition-colors">{title}</h3>
          <p className="text-slate-400 text-sm leading-relaxed">{desc}</p>
          <div className="mt-4 flex items-center gap-1 text-[#2563EB] text-xs font-semibold group-hover:gap-2 transition-all">
            Enter <ArrowRight className="w-3 h-3" />
          </div>
        </div>
      </div>
    </Link>
  );
}

// ─── Main LandingPage ─────────────────────────────────────────────────────────
// This page is only a router — authenticated users go to /splash, others go to /login
export default function LandingPage() {
  const { isAuthenticated, user, loading } = useAuth();
  const [, navigate] = useLocation();
  const featuresRef = useRef<HTMLDivElement>(null);

  // Immediately redirect: logged-in → splash, not logged-in → login
  useEffect(() => {
    if (loading) return; // wait for auth state
    if (isAuthenticated && user) {
      navigate("/splash");
    } else if (!isAuthenticated) {
      navigate("/login");
    }
  }, [isAuthenticated, user, loading, navigate]);

  // Show nothing while redirecting
  if (loading || isAuthenticated) return null;

  const scrollToFeatures = () => {
    featuresRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  const features = [
    {
      icon: <Youtube className="w-5 h-5 text-blue-300" />,
      title: "YouTube Analyzer",
      desc: "הכנס קישור לסרטון מסחר ב-YouTube — ה-AI יתמלל, ינתח ויחלץ עד 10 מניות עם אזורי כניסה, Stop Loss, קטליזטורים ואסטרטגיה.",
      href: "/",
      img: IMG_AI,
      badge: "AI Powered",
    },
    {
      icon: <TrendingUp className="w-5 h-5 text-emerald-300" />,
      title: "Trade Manager",
      desc: "נהל את כל הפוזיציות שלך במקום אחד. מעקב P&L בזמן אמת, התראות כניסה, ניהול סיכונים ויומן מסחר מקצועי.",
      href: "/trade",
      img: IMG_SUCCESS,
    },
    {
      icon: <FlaskConical className="w-5 h-5 text-violet-300" />,
      title: "Trading Lab",
      desc: "הרץ סימולציות Backtest על אסטרטגיות מסחר שלמות. מנוע Ziv Score מדרג כל נכס 1-10 ומזהה הזדמנויות לפני כולם.",
      href: "/lab",
      img: IMG_CHART,
      badge: "Pro",
    },
    {
      icon: <Zap className="w-5 h-5 text-amber-300" />,
      title: "Asset Catalogue",
      desc: "קטלוג הנכסים שלך עם ציוני Ziv, אותות מסחר ו-Market Scan שסורק 200+ נכסים מכל הסקטורים ומחזיר את ה-Top 10.",
      href: "/catalogue",
      img: IMG_VICTORY,
    },
    {
      icon: <BookOpen className="w-5 h-5 text-cyan-300" />,
      title: "Knowledge Base",
      desc: "בסיס הידע שלך — כל הסרטונים שנותחו, תובנות מסחר, Master JSON עם כל הנכסים ואסטרטגיות שנאספו לאורך זמן.",
      href: "/knowledge",
      img: IMG_AI,
    },
    {
      icon: <BarChart2 className="w-5 h-5 text-pink-300" />,
      title: "Master JSON",
      desc: "מאגר הנכסים המרכזי — כל המניות, הסחורות וה-ETFs שנסרקו, עם ציונים, אסטרטגיות ומחירי כניסה מומלצים.",
      href: "/master",
      img: IMG_CHART,
    },
  ];

  const stats = [
    { value: 200, suffix: "+", label: "נכסים בסריקה" },
    { value: 10, suffix: "/10", label: "ציון Ziv מקסימלי" },
    { value: 6, suffix: "", label: "מודולים מובנים" },
    { value: 100, suffix: "%", label: "מבוסס AI" },
  ];

  const benefits = [
    "ניתוח סרטוני YouTube אוטומטי עם חילוץ מניות",
    "מנוע Ziv Score — דירוג מניות 1-10 בזמן אמת",
    "Backtest מלא על אסטרטגיות מסחר",
    "Market Scan — 200+ נכסים מכל הסקטורים",
    "Trade Manager עם מעקב P&L ו-Stop Loss",
    "בסיס ידע מצטבר מכל הניתוחים",
  ];

  return (
    <div className="min-h-screen bg-slate-950 text-white overflow-x-hidden">

      {/* ── Hero Section ── */}
      <section className="relative min-h-screen flex flex-col items-center justify-center overflow-hidden">
        {/* Background image */}
        <div className="absolute inset-0">
          <img src={IMG_HERO} alt="Trading Hero" className="w-full h-full object-cover opacity-30" />
          <div className="absolute inset-0 bg-gradient-to-b from-slate-950/60 via-slate-950/40 to-slate-950" />
        </div>

        {/* Animated grid overlay */}
        <div className="absolute inset-0 opacity-10"
          style={{
            backgroundImage: "linear-gradient(rgba(59,130,246,0.3) 1px, transparent 1px), linear-gradient(90deg, rgba(59,130,246,0.3) 1px, transparent 1px)",
            backgroundSize: "60px 60px"
          }}
        />

        {/* Glow orbs */}
        <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-[#2563EB]/20 rounded-full blur-3xl animate-pulse" />
        <div className="absolute bottom-1/3 right-1/4 w-80 h-80 bg-violet-600/15 rounded-full blur-3xl animate-pulse" style={{ animationDelay: "1s" }} />
        <div className="absolute top-1/2 left-1/2 w-64 h-64 bg-emerald-600/10 rounded-full blur-3xl animate-pulse" style={{ animationDelay: "2s" }} />

        {/* Hero content */}
        <div className="relative z-10 text-center px-4 max-w-5xl mx-auto">
          {/* Badge */}
          <div className="inline-flex items-center gap-2 bg-[#2563EB]/10 border border-[#2563EB]/30 rounded-full px-4 py-1.5 text-blue-300 text-xs font-semibold mb-8 backdrop-blur-sm">
            <Star className="w-3.5 h-3.5 fill-current" />
            tradesnow.vip — פלטפורמת המסחר החכמה ביותר
          </div>

          {/* Main headline */}
          <h1 className="text-4xl sm:text-5xl md:text-7xl font-black mb-6 leading-tight">
            <span className="text-white">תסחר</span>
            <span className="bg-gradient-to-r from-blue-400 via-cyan-300 to-emerald-400 bg-clip-text text-transparent"> חכם יותר.</span>
            <br />
            <span className="text-white">תרוויח</span>
            <span className="bg-gradient-to-r from-amber-400 via-orange-400 to-yellow-300 bg-clip-text text-transparent"> יותר.</span>
          </h1>

          {/* Sub-headline */}
          <p className="text-slate-300 text-base md:text-xl max-w-3xl mx-auto mb-10 leading-relaxed px-2">
            מערכת AI מתקדמת שמנתחת סרטוני YouTube, סורקת 200+ נכסים, מריצה Backtest ומנהלת את הפוזיציות שלך —
            <span className="text-white font-semibold"> הכל במקום אחד.</span>
          </p>

          {/* CTA buttons */}
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3 mb-12 w-full">
            {isAuthenticated ? (
              <Link href="/trade">
                <button className="group flex items-center gap-2 bg-gradient-to-r from-blue-600 to-cyan-500 hover:from-blue-500 hover:to-cyan-400 text-white font-bold px-8 py-4 rounded-2xl text-base shadow-2xl shadow-blue-500/30 transition-all duration-200 hover:scale-105 hover:shadow-blue-500/50">
                  <TrendingUp className="w-5 h-5" />
                  כנס לפלטפורמה
                  <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
                </button>
              </Link>
            ) : (
              <Link href="/login" className="w-full sm:w-auto">
                <button className="group w-full sm:w-auto flex items-center justify-center gap-2 bg-gradient-to-r from-blue-600 to-cyan-500 hover:from-blue-500 hover:to-cyan-400 text-white font-bold px-8 py-4 rounded-2xl text-base shadow-2xl shadow-blue-500/30 transition-all duration-200 hover:scale-105 hover:shadow-blue-500/50">
                  <Zap className="w-5 h-5" />
                  התחל עכשיו — בחינם
                  <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
                </button>
              </Link>
            )}
            <button
              onClick={scrollToFeatures}
              className="w-full sm:w-auto flex items-center justify-center gap-2 border border-white/20 hover:border-white/40 text-slate-300 hover:text-white font-semibold px-8 py-4 rounded-2xl text-base backdrop-blur-sm transition-all duration-200 hover:bg-white/5"
            >
              גלה את הפלטפורמה
              <ChevronDown className="w-4 h-4 animate-bounce" />
            </button>
          </div>

          {/* Stats row */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 max-w-2xl mx-auto w-full">
            {stats.map((s, i) => (
              <div key={i} className="bg-white/5 backdrop-blur-sm border border-white/10 rounded-2xl p-4 text-center">
                <div className="text-2xl font-black text-white mb-1">
                  <AnimatedCounter target={s.value} suffix={s.suffix} />
                </div>
                <div className="text-slate-400 text-xs">{s.label}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Scroll indicator */}
        <button onClick={scrollToFeatures} className="absolute bottom-8 left-1/2 -translate-x-1/2 text-slate-500 hover:text-slate-300 transition-colors animate-bounce">
          <ChevronDown className="w-6 h-6" />
        </button>
      </section>

      {/* ── Features Grid ── */}
      <section ref={featuresRef} className="py-24 px-4">
        <div className="max-w-7xl mx-auto">
          {/* Section header */}
          <div className="text-center mb-16">
            <div className="inline-flex items-center gap-2 bg-violet-500/10 border border-violet-500/30 rounded-full px-4 py-1.5 text-violet-300 text-xs font-semibold mb-4">
              <Brain className="w-3.5 h-3.5" />
              6 מודולים עוצמתיים
            </div>
            <h2 className="text-4xl md:text-5xl font-black text-white mb-4">
              כל מה שסוחר מקצועי
              <span className="bg-gradient-to-r from-violet-400 to-blue-400 bg-clip-text text-transparent"> צריך</span>
            </h2>
            <p className="text-slate-400 text-lg max-w-2xl mx-auto">
              מניתוח תוכן ועד ביצוע עסקאות — מערכת שלמה שחוסכת לך שעות של עבודה ידנית
            </p>
          </div>

          {/* Features grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {features.map((f, i) => (
              <FeatureCard key={i} {...f} />
            ))}
          </div>
        </div>
      </section>

      {/* ── Split section: Success image + Benefits ── */}
      <section className="py-24 px-4 bg-gradient-to-b from-transparent via-blue-950/20 to-transparent">
        <div className="max-w-7xl mx-auto grid grid-cols-1 lg:grid-cols-2 gap-16 items-center">
          {/* Image side */}
          <div className="relative">
            <div className="absolute -inset-4 bg-gradient-to-r from-blue-600/20 to-cyan-600/20 rounded-3xl blur-2xl" />
            <img
              src={IMG_SUCCESS}
              alt="Trading Success"
              className="relative rounded-3xl shadow-2xl shadow-blue-500/20 w-full object-cover"
            />
            {/* Floating badge */}
            <div className="absolute -bottom-4 -right-4 bg-gradient-to-r from-emerald-500 to-teal-500 rounded-2xl p-4 shadow-xl shadow-emerald-500/30">
              <div className="flex items-center gap-2">
                <Trophy className="w-5 h-5 text-white" />
                <div>
                  <div className="text-white font-black text-sm">Ziv Score</div>
                  <div className="text-emerald-100 text-xs">9.8 / 10</div>
                </div>
              </div>
            </div>
          </div>

          {/* Text side */}
          <div>
            <div className="inline-flex items-center gap-2 bg-emerald-500/10 border border-emerald-500/30 rounded-full px-4 py-1.5 text-emerald-300 text-xs font-semibold mb-6">
              <Target className="w-3.5 h-3.5" />
              למה tradesnow.vip?
            </div>
            <h2 className="text-4xl font-black text-white mb-6 leading-tight">
              הפסק לנחש.
              <br />
              <span className="bg-gradient-to-r from-emerald-400 to-teal-300 bg-clip-text text-transparent">
                תתחיל לדעת.
              </span>
            </h2>
            <p className="text-slate-400 text-base mb-8 leading-relaxed">
              המערכת שלנו לא רק מציגה נתונים — היא מנתחת, מדרגת ומחליטה בשבילך.
              מנוע ה-AI שלנו עובד 24/7 כדי שאתה תהיה תמיד צעד אחד לפני השוק.
            </p>
            <div className="space-y-3">
              {benefits.map((b, i) => (
                <div key={i} className="flex items-start gap-3">
                  <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
                  <span className="text-slate-300 text-sm">{b}</span>
                </div>
              ))}
            </div>
            <div className="mt-10">
              {isAuthenticated ? (
                <Link href="/lab">
                  <button className="group flex items-center gap-2 bg-gradient-to-r from-emerald-600 to-teal-500 hover:from-emerald-500 hover:to-teal-400 text-white font-bold px-6 py-3.5 rounded-xl text-sm shadow-xl shadow-emerald-500/20 transition-all duration-200 hover:scale-105">
                    <FlaskConical className="w-4 h-4" />
                    נסה את Trading Lab
                    <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
                  </button>
                </Link>
              ) : (
                <a href="/login">
                  <button className="group flex items-center gap-2 bg-gradient-to-r from-emerald-600 to-teal-500 hover:from-emerald-500 hover:to-teal-400 text-white font-bold px-6 py-3.5 rounded-xl text-sm shadow-xl shadow-emerald-500/20 transition-all duration-200 hover:scale-105">
                    <Zap className="w-4 h-4" />
                    התחל עכשיו בחינם
                    <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
                  </button>
                </a>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* ── Victory / CTA section ── */}
      <section className="py-24 px-4">
        <div className="max-w-7xl mx-auto">
          <div className="relative overflow-hidden rounded-3xl">
            {/* Background */}
            <img src={IMG_VICTORY} alt="Victory" className="absolute inset-0 w-full h-full object-cover opacity-20" />
            <div className="absolute inset-0 bg-gradient-to-r from-slate-950 via-slate-950/90 to-slate-950/70" />

            <div className="relative z-10 p-6 sm:p-10 md:p-16 grid grid-cols-1 lg:grid-cols-2 gap-8 items-center">
              <div>
                <div className="flex items-center gap-2 mb-6">
                  {[...Array(5)].map((_, i) => (
                    <Star key={i} className="w-5 h-5 text-amber-400 fill-current" />
                  ))}
                </div>
                <h2 className="text-3xl md:text-5xl font-black text-white mb-6 leading-tight">
                  הניצחון הבא שלך
                  <br />
                  <span className="bg-gradient-to-r from-amber-400 to-orange-400 bg-clip-text text-transparent">
                    מתחיל כאן.
                  </span>
                </h2>
                <p className="text-slate-300 text-lg mb-8 leading-relaxed">
                  הצטרף לסוחרים שכבר משתמשים ב-tradesnow.vip כדי לזהות הזדמנויות,
                  לנהל סיכונים ולהשיג תשואות עקביות — בכל שוק, בכל מצב.
                </p>
                <div className="flex flex-col sm:flex-row flex-wrap gap-3">
                  {isAuthenticated ? (
                    <>
                      <Link href="/trade">
                        <button className="group flex items-center gap-2 bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-400 hover:to-orange-400 text-white font-bold px-6 py-3.5 rounded-xl text-sm shadow-xl shadow-amber-500/20 transition-all duration-200 hover:scale-105">
                          <TrendingUp className="w-4 h-4" />
                          Trade Manager
                          <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
                        </button>
                      </Link>
                      <Link href="/catalogue">
                        <button className="flex items-center gap-2 border border-white/20 hover:border-amber-400/50 text-slate-300 hover:text-white font-semibold px-6 py-3.5 rounded-xl text-sm backdrop-blur-sm transition-all duration-200 hover:bg-amber-500/10">
                          <Zap className="w-4 h-4" />
                          Asset Catalogue
                        </button>
                      </Link>
                    </>
                  ) : (
                    <a href="/login">
                      <button className="group flex items-center gap-2 bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-400 hover:to-orange-400 text-white font-bold px-8 py-4 rounded-xl text-base shadow-xl shadow-amber-500/20 transition-all duration-200 hover:scale-105">
                        <Trophy className="w-5 h-5" />
                        הצטרף עכשיו — חינם
                        <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
                      </button>
                    </a>
                  )}
                </div>
              </div>

              {/* Right: feature pills */}
              <div className="grid grid-cols-2 gap-3">
                {[
                  { icon: <Youtube className="w-4 h-4" />, label: "YouTube Analyzer", color: "from-blue-600/30 to-blue-500/10 border-[#2563EB]/30" },
                  { icon: <TrendingUp className="w-4 h-4" />, label: "Trade Manager", color: "from-emerald-600/30 to-emerald-500/10 border-emerald-500/30" },
                  { icon: <FlaskConical className="w-4 h-4" />, label: "Trading Lab", color: "from-violet-600/30 to-violet-500/10 border-violet-500/30" },
                  { icon: <Zap className="w-4 h-4" />, label: "Asset Catalogue", color: "from-amber-600/30 to-amber-500/10 border-amber-500/30" },
                  { icon: <Brain className="w-4 h-4" />, label: "AI Analysis", color: "from-pink-600/30 to-pink-500/10 border-pink-500/30" },
                  { icon: <Shield className="w-4 h-4" />, label: "Risk Management", color: "from-cyan-600/30 to-cyan-500/10 border-cyan-500/30" },
                ].map((item, i) => (
                  <div key={i} className={`flex items-center gap-2.5 bg-gradient-to-r ${item.color} border rounded-xl p-3.5 backdrop-blur-sm`}>
                    <div className="text-white/80">{item.icon}</div>
                    <span className="text-white text-xs font-semibold">{item.label}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Footer ── */}
      <footer className="border-t border-white/5 py-8 px-4">
        <div className="max-w-7xl mx-auto flex flex-col items-center gap-4 text-center md:flex-row md:justify-between md:text-left">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg bg-[#2563EB]/20 flex items-center justify-center">
              <TrendingUp className="w-4 h-4 text-[#2563EB]" />
            </div>
            <span className="font-bold text-white text-sm">tradesnow.vip</span>
            <span className="text-slate-500 text-xs">AI-Powered Trading Intelligence</span>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-4 text-slate-500 text-xs">
            <Link href="/trade" className="hover:text-slate-300 transition-colors">Trade Manager</Link>
            <Link href="/lab" className="hover:text-slate-300 transition-colors">Trading Lab</Link>
            <Link href="/catalogue" className="hover:text-slate-300 transition-colors">Asset Catalogue</Link>
            <Link href="/knowledge" className="hover:text-slate-300 transition-colors">Knowledge</Link>
          </div>
          <div className="text-slate-600 text-xs">
            © 2026 tradesnow.vip — All rights reserved
          </div>
        </div>
      </footer>
    </div>
  );
}
