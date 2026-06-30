import { useState, useEffect } from "react";
import { Download, X } from "lucide-react";
import { useLocation } from "wouter";
import { Z } from "@/lib/zIndex";

/** Trading surfaces — PWA banner covers chart / positions */
const TRADING_PATH_RE = /^\/(war-room-live|deep-analysis|trade|login|dev\/mobile-trading-preview)/;

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let _capturedPrompt: BeforeInstallPromptEvent | null = null;
if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    _capturedPrompt = e as BeforeInstallPromptEvent;
  });
}

export function PWAInstallPrompt() {
  const [location] = useLocation();
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [showBanner, setShowBanner] = useState(false);
  const [isIOS, setIsIOS] = useState(false);
  const [showIOSInstructions, setShowIOSInstructions] = useState(false);

  useEffect(() => {
    if (TRADING_PATH_RE.test(location)) {
      setShowBanner(false);
      return;
    }
  }, [location]);

  useEffect(() => {
    if (TRADING_PATH_RE.test(location)) return;

    const isStandalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      (window.navigator as any).standalone === true;
    if (isStandalone) return;

    const dismissedAt = localStorage.getItem("pwa-install-dismissed-v2");
    if (dismissedAt) {
      const sevenDays = 7 * 24 * 60 * 60 * 1000;
      if (Date.now() - parseInt(dismissedAt) < sevenDays) return;
      localStorage.removeItem("pwa-install-dismissed-v2");
    }

    const ua = navigator.userAgent;
    const isIOSDevice = /iphone|ipad|ipod/i.test(ua);
    const isSafari = /safari/i.test(ua) && !/chrome|crios|fxios/i.test(ua);

    if (isIOSDevice && isSafari) {
      setIsIOS(true);
      setTimeout(() => setShowBanner(true), 3000);
      return;
    }

    const tryShow = (prompt: BeforeInstallPromptEvent) => {
      setDeferredPrompt(prompt);
      setTimeout(() => setShowBanner(true), 1500);
    };

    if (_capturedPrompt) { tryShow(_capturedPrompt); return; }

    const handler = (e: Event) => {
      e.preventDefault();
      _capturedPrompt = e as BeforeInstallPromptEvent;
      tryShow(_capturedPrompt);
    };
    window.addEventListener("beforeinstallprompt", handler);

    const forceTimer = setTimeout(() => {
      if (!_capturedPrompt) setTimeout(() => setShowBanner(true), 0);
    }, 2000);

    return () => {
      window.removeEventListener("beforeinstallprompt", handler);
      clearTimeout(forceTimer);
    };
  }, [location]);

  const handleInstall = async () => {
    if (isIOS) { setShowIOSInstructions(true); return; }
    if (!deferredPrompt) { setShowIOSInstructions(true); return; }
    await deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    _capturedPrompt = null;
    if (outcome === "accepted") setShowBanner(false);
    setDeferredPrompt(null);
  };

  const handleDismiss = () => {
    setShowBanner(false);
    localStorage.setItem("pwa-install-dismissed-v2", String(Date.now()));
  };

  if (!showBanner) return null;
  if (TRADING_PATH_RE.test(location)) return null;

  return (
    <>
      {/* ── Galaxy Install Banner ── */}
      <div className="fixed bottom-4 left-3 right-3 md:left-auto md:right-4 md:w-80 animate-in slide-in-from-bottom-4 duration-300" style={{ zIndex: Z.header }}>
        <div
          className="relative rounded-2xl shadow-2xl overflow-hidden p-4 flex items-center gap-3"
          style={{
            background: "linear-gradient(135deg, #0f0c29 0%, #1a1060 40%, #24243e 100%)",
            border: "1px solid rgba(139,92,246,0.4)",
            boxShadow: "0 0 30px rgba(139,92,246,0.25), 0 8px 32px rgba(0,0,0,0.6)"
          }}
        >
          {/* Stars bg */}
          <div className="absolute inset-0 pointer-events-none" style={{
            backgroundImage: "radial-gradient(1px 1px at 20% 30%, rgba(255,255,255,0.6) 0%, transparent 100%), radial-gradient(1px 1px at 80% 10%, rgba(255,255,255,0.5) 0%, transparent 100%), radial-gradient(1px 1px at 50% 70%, rgba(255,255,255,0.4) 0%, transparent 100%), radial-gradient(1px 1px at 10% 80%, rgba(255,255,255,0.5) 0%, transparent 100%), radial-gradient(1px 1px at 90% 60%, rgba(255,255,255,0.4) 0%, transparent 100%)"
          }} />

          {/* Elsa avatar */}
          <div className="relative shrink-0 w-12 h-12 rounded-xl overflow-hidden" style={{ border: "1.5px solid rgba(139,92,246,0.7)", boxShadow: "0 0 12px rgba(139,92,246,0.5)" }}>
            <img
              src="/pwa-192.png"
              alt="TS"
              className="w-full h-full object-cover"
            />
          </div>

          <div className="flex-1 min-w-0">
            <p className="text-sm font-bold" style={{ color: "#e0d7ff" }}>התקן את TS</p>
            <p className="text-[11px] mt-0.5" style={{ color: "rgba(196,181,253,0.75)" }}>
              {isIOS ? "הוסף למסך הבית לגישה מהירה" : "גישה מהירה, ללא דפדפן"}
            </p>
            <div className="flex items-center gap-2 mt-2">
              <button
                onClick={handleInstall}
                className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg transition-all active:scale-95"
                style={{
                  background: "linear-gradient(135deg, #7c3aed, #4f46e5)",
                  color: "#fff",
                  boxShadow: "0 0 12px rgba(124,58,237,0.5)"
                }}
              >
                <Download size={12} />
                {isIOS ? "הוראות" : "התקן"}
              </button>
              <button
                onClick={handleDismiss}
                className="text-[11px] px-2 py-1.5 rounded-lg transition-all"
                style={{ color: "rgba(196,181,253,0.6)" }}
              >
                אחר כך
              </button>
            </div>
          </div>

          {/* Close */}
          <button
            onClick={handleDismiss}
            className="absolute top-2 right-2 p-1 rounded-full transition-colors"
            style={{ color: "rgba(196,181,253,0.5)" }}
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* iOS instructions modal */}
      {showIOSInstructions && (
        <div className="fixed inset-0 flex items-end justify-center p-4" style={{ zIndex: Z.dialog, background: "rgba(0,0,0,0.7)" }} onClick={() => setShowIOSInstructions(false)}>
          <div
            className="w-full max-w-sm rounded-2xl p-5 mb-2"
            style={{ background: "linear-gradient(135deg, #0f0c29, #1a1060)", border: "1px solid rgba(139,92,246,0.4)" }}
            onClick={e => e.stopPropagation()}
          >
            <h3 className="text-base font-bold mb-3 text-center" style={{ color: "#e0d7ff" }}>התקנת TS</h3>
            <ol className="space-y-2 text-sm" style={{ color: "rgba(196,181,253,0.85)" }}>
              <li>1. לחץ על כפתור <strong style={{color:"#c4b5fd"}}>שתף</strong> בתחתית הדפדפן</li>
              <li>2. בחר <strong style={{color:"#c4b5fd"}}>"הוסף למסך הבית"</strong></li>
              <li>3. לחץ <strong style={{color:"#c4b5fd"}}>הוסף</strong> — זהו!</li>
            </ol>
            <button onClick={() => setShowIOSInstructions(false)} className="w-full mt-4 py-2 rounded-xl text-sm font-semibold" style={{ background: "linear-gradient(135deg, #7c3aed, #4f46e5)", color: "#fff" }}>
              סגור
            </button>
          </div>
        </div>
      )}
    </>
  );
}
