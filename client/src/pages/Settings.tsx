import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  BarChart2,
  CheckCircle2,
  Download,
  FileText,
  Link2,
  RefreshCw,
  Settings as SettingsIcon,
  Shield,
  Terminal,
  Webhook,
  Building2,
  AlertTriangle,
  ShieldCheck,
  ShieldOff,
  LogOut,
  Users,
  UserPlus,
  Trash2,
  KeyRound,
  Eye,
  EyeOff,
  Send,
  Smartphone,
} from "lucide-react";
import { IBINDPanel } from "@/components/IBINDPanel";
import React, { useState, useEffect } from "react";
import ElzaLogsPanel from "@/components/ElzaLogsPanel";
import { toast } from "sonner";
import { useAuth } from "@/_core/hooks/useAuth";
import { useIbkrInactivityExpired } from "@/components/IbkrSessionGuard";

// ─── Types ────────────────────────────────────────────────────────────────────

interface UserSettings {
  tradingviewWebhookUrl: string;
  tradingviewApiKey: string;
  platform: "tradingview" | "interactive_brokers" | "paper";
  startingBalance: number;
  riskPerTrade: number;
  stopLossBuffer: number;
}

const DEFAULT_SETTINGS: UserSettings = {
  tradingviewWebhookUrl: "",
  tradingviewApiKey: "",
  platform: "tradingview",
  startingBalance: 10000,
  riskPerTrade: 2,
  stopLossBuffer: 0.5,
};

// ─── Section Card ─────────────────────────────────────────────────────────────

function SectionCard({
  icon,
  title,
  description,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="p-5 border-b border-border/50 flex items-start gap-3">
        <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
          {icon}
        </div>
        <div>
          <h3 className="font-semibold text-foreground text-sm">{title}</h3>
          <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{description}</p>
        </div>
      </div>
      <div className="p-5 space-y-4">{children}</div>
    </div>
  );
}

function FieldRow({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-[200px_1fr] gap-3 items-start">
      <div>
        <p className="text-sm font-medium text-foreground">{label}</p>
        {hint && <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{hint}</p>}
      </div>
      <div>{children}</div>
    </div>
  );
}

// ─── Main Settings Page ───────────────────────────────────────────────────────

export default function Settings() {
  const { isAuthenticated, loading, user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [settings, setSettings] = useState<UserSettings>(DEFAULT_SETTINGS);
  const [saved, setSaved] = useState(false);
  const { expired: ibkrExpired, clearExpired } = useIbkrInactivityExpired();

  const { data: savedSettings } = trpc.settings.get.useQuery(undefined, {
    enabled: isAuthenticated,
  });

  const saveMutation = trpc.settings.save.useMutation({
    onSuccess: () => {
      setSaved(true);
      toast.success("Settings saved");
      setTimeout(() => setSaved(false), 3000);
    },
    onError: (err: any) => toast.error(err.message),
  });

  useEffect(() => {
    if (savedSettings) {
      setSettings({
        tradingviewWebhookUrl: savedSettings.tradingviewWebhookUrl ?? "",
        tradingviewApiKey: savedSettings.tradingviewApiKey ?? "",
        platform: (savedSettings.platform as UserSettings["platform"]) ?? "tradingview",
        startingBalance: savedSettings.startingBalance ?? 10000,
        riskPerTrade: savedSettings.riskPerTrade ?? 2,
        stopLossBuffer: savedSettings.stopLossBuffer ?? 0.5,
      });
    }
  }, [savedSettings]);

  if (loading) {
    return (
      <div className="container py-16 flex items-center justify-center">
        <div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="container py-16 text-center">
        <p className="text-muted-foreground mb-4">Sign in to access settings.</p>
        <a href="/login" className="text-primary underline text-sm">Sign In</a>
      </div>
    );
  }

  const update = (key: keyof UserSettings, value: string | number) =>
    setSettings((prev) => ({ ...prev, [key]: value }));

  const handleSave = () => saveMutation.mutate(settings);

  const platforms: Array<{ id: UserSettings["platform"]; label: string; desc: string }> = [
    { id: "tradingview", label: "TradingView", desc: "Use TradingView for charting and alerts" },
    { id: "interactive_brokers", label: "Interactive Brokers", desc: "Connect to IBKR for live execution" },
    { id: "paper", label: "Paper Trading", desc: "Simulate trades without real money" },
  ];

  return (
    <div className="container py-10">
      <div className="max-w-3xl mx-auto space-y-8">
        {/* Inactivity expiry banner */}
        {ibkrExpired && (
          <div className="flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5 text-amber-600" />
            <div className="flex-1">
              <p className="font-semibold">Session expired due to inactivity</p>
              <p className="text-xs mt-0.5 text-amber-600">Your IBKR connection was automatically stopped after 60 minutes of inactivity. Click "Connect" in the Session Gate to reconnect.</p>
            </div>
            <button onClick={clearExpired} className="text-amber-500 hover:text-amber-600 text-xs underline shrink-0">Dismiss</button>
          </div>
        )}

        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
              <SettingsIcon className="w-5 h-5 text-primary" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-foreground">Configuration Center</h1>
              <p className="text-sm text-muted-foreground">Connect your trading environment to the AI engine</p>
            </div>
          </div>
          <Button
            onClick={handleSave}
            disabled={saveMutation.isPending}
            className="gap-2"
          >
            {saved ? (
              <><CheckCircle2 className="w-4 h-4" /> Saved</>
            ) : saveMutation.isPending ? (
              <><div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" /> Saving...</>
            ) : (
              "Save Settings"
            )}
          </Button>
        </div>

        <h2 className="text-[11px] font-bold uppercase tracking-[0.14em] text-slate-500 pt-4">Integrations & API Keys</h2>
        {/* Component 1: TradingView Connectivity */}
        <SectionCard
          icon={<Webhook className="w-4 h-4 text-primary" />}
          title="TradingView Connectivity"
          description="Connect your TradingView account to receive automated alerts when the AI identifies trade setups."
        >
          <FieldRow
            label="Webhook URL"
            hint="Your TradingView webhook endpoint for receiving alerts"
          >
            <Input
              placeholder="https://your-tradingview-webhook.com/alerts"
              value={settings.tradingviewWebhookUrl}
              onChange={(e) => update("tradingviewWebhookUrl", e.target.value)}
              className="font-mono text-xs"
            />
          </FieldRow>
          <FieldRow
            label="API Key"
            hint="Optional: used to authenticate webhook requests"
          >
            <Input
              type="password"
              placeholder="tv_api_key_••••••••"
              value={settings.tradingviewApiKey}
              onChange={(e) => update("tradingviewApiKey", e.target.value)}
              className="font-mono text-xs"
            />
          </FieldRow>
          {settings.tradingviewWebhookUrl && (
            <div className="flex items-center gap-2 text-xs text-[#059669] bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-3 py-2">
              <Link2 className="w-3.5 h-3.5 shrink-0" />
              Webhook configured — alerts will fire when trade setups are detected
            </div>
          )}
        </SectionCard>

        <h2 className="text-[11px] font-bold uppercase tracking-[0.14em] text-slate-500 pt-4">Trading Preferences</h2>
        {/* Component 2: Platform Selection */}
        <SectionCard
          icon={<BarChart2 className="w-4 h-4 text-primary" />}
          title="Platform Selection"
          description="Choose which platform the AI uses for charting data and trade execution."
        >
          <div className="flex flex-col sm:grid sm:grid-cols-3 gap-3">
            {platforms.map((p) => (
              <button
                key={p.id}
                onClick={() => update("platform", p.id)}
                className={`rounded-xl border p-4 text-left transition-all ${
                  settings.platform === p.id
                    ? "border-primary bg-primary/10"
                    : "border-border bg-muted/30 hover:border-border/80"
                }`}
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-semibold text-foreground">{p.label}</span>
                  {settings.platform === p.id && (
                    <CheckCircle2 className="w-4 h-4 text-primary shrink-0" />
                  )}
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed">{p.desc}</p>
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground bg-muted/30 border border-border/50 rounded-lg px-3 py-2">
            <Shield className="w-3.5 h-3.5 shrink-0" />
            Active platform: <Badge variant="outline" className="text-xs ml-1">{settings.platform.replace("_", " ")}</Badge>
          </div>
        </SectionCard>

        <h2 className="text-[11px] font-bold uppercase tracking-[0.14em] text-slate-500 pt-4">Notifications & App</h2>
        {/* Component 3: Telegram Notifications — all users */}
        <TelegramSettingsSection />

        {/* Component 3b: PWA Install */}
        <PWAInstallSection />

        {/* Component 4: Interactive Brokers — admin only */}
        {isAdmin && (
          <div id="ibkr">
            <SectionCard
              icon={<Building2 className="w-4 h-4 text-primary" />}
              title="Interactive Brokers"
              description="Connect to IBKR for live order execution via IBIND (OAuth 1.0a bridge)."
            >
              <IBINDPanel />
            </SectionCard>
          </div>
        )}

        <h2 className="text-[11px] font-bold uppercase tracking-[0.14em] text-slate-500 pt-4">Security & Access</h2>
        {/* Component 5: Security */}
        <SecuritySection />

        {/* Component 6: User Management (admin only) */}
        <UserManagementSection />

        <h2 className="text-[11px] font-bold uppercase tracking-[0.14em] text-slate-500 pt-4">System & Diagnostics</h2>
        {/* Component 7: Elza Live Logs */}
        <SectionCard
          title="⚡ Elza Live Engine Logs"
          description="Real-time structured logs from the War Engine, Live Executor, IBKR Sync, and all guards. Format: [TIMESTAMP] [LEVEL] [COMPONENT] → Message | Context"
          icon={<Terminal className="w-4 h-4" />}
        >
          <ElzaLogsPanel />
        </SectionCard>
      </div>
    </div>
  );
}



// ─── PWA Install Section ──────────────────────────────────────────────────────

function PWAInstallSection() {
  const [installPrompt, setInstallPrompt] = (
    typeof window !== "undefined" && (window as any)._capturedPWAPrompt
  ) ? [true, null] : [false, null];

  const [prompt, setPrompt] = React.useState<any>(null);
  const [installed, setInstalled] = React.useState(false);
  const [showInstructions, setShowInstructions] = React.useState(false);

  const isIOS = /iphone|ipad|ipod/i.test(typeof navigator !== "undefined" ? navigator.userAgent : "");
  const isSafari = /safari/i.test(typeof navigator !== "undefined" ? navigator.userAgent : "") &&
    !/chrome|crios|fxios/i.test(typeof navigator !== "undefined" ? navigator.userAgent : "");

  const isStandalone =
    typeof window !== "undefined" &&
    (window.matchMedia("(display-mode: standalone)").matches ||
      (window.navigator as any).standalone === true);

  React.useEffect(() => {
    // Check if already installed
    if (isStandalone) { setInstalled(true); return; }

    // Try to get captured prompt from global
    const gw = window as any;
    if (gw.__pwaPrompt) { setPrompt(gw.__pwaPrompt); return; }

    const handler = (e: any) => {
      e.preventDefault();
      gw.__pwaPrompt = e;
      setPrompt(e);
    };
    window.addEventListener("beforeinstallprompt", handler);
    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);

  const handleInstall = async () => {
    if (isIOS || !prompt) {
      setShowInstructions(true);
      return;
    }
    await prompt.prompt();
    const { outcome } = await prompt.userChoice;
    if (outcome === "accepted") {
      setInstalled(true);
      toast.success("✅ האפליקציה הותקנה!");
    }
    setPrompt(null);
  };

  return (
    <SectionCard
      icon={<Smartphone className="w-4 h-4 text-primary" />}
      title="התקן כאפליקציה"
      description="הוסף את TradeSnow למסך הבית שלך לגישה מהירה — בלי דפדפן."
    >
      {isStandalone || installed ? (
        <div className="flex items-center gap-2 text-sm text-emerald-500 bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-4 py-3">
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          האפליקציה כבר מותקנת על המכשיר שלך ✓
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between gap-4">
            <div className="text-sm text-muted-foreground leading-relaxed">
              {isIOS && isSafari
                ? "לחץ על כפתור השיתוף ב-Safari ובחר «הוסף למסך הבית»"
                : "לחץ «התקן» כדי להוסיף את האפליקציה ישירות למסך הבית שלך"}
            </div>
            <Button
              onClick={handleInstall}
              className="gap-2 shrink-0 min-h-[44px]"
              variant={prompt ? "default" : "outline"}
            >
              <Download className="w-4 h-4" />
              {isIOS ? "הוראות" : "התקן"}
            </Button>
          </div>

          {showInstructions && (
            <div className="rounded-xl border border-border bg-muted/20 p-4 space-y-3 mt-2">
              <p className="text-sm font-semibold text-foreground">
                {isIOS ? "הוספה ל-iOS (Safari)" : "הוספה ל-Android (Chrome)"}
              </p>
              <ol className="space-y-2 text-sm text-muted-foreground">
                {isIOS ? (
                  <>
                    <li className="flex items-start gap-2"><span className="font-bold text-primary">1.</span> לחץ על כפתור <strong>שתף</strong> (□↑) בסרגל Safari</li>
                    <li className="flex items-start gap-2"><span className="font-bold text-primary">2.</span> גלול ובחר <strong>"הוסף למסך הבית"</strong></li>
                    <li className="flex items-start gap-2"><span className="font-bold text-primary">3.</span> לחץ <strong>"הוסף"</strong></li>
                  </>
                ) : (
                  <>
                    <li className="flex items-start gap-2"><span className="font-bold text-primary">1.</span> לחץ על <strong>⋮ תפריט</strong> בפינה הימנית העליונה של Chrome</li>
                    <li className="flex items-start gap-2"><span className="font-bold text-primary">2.</span> בחר <strong>"הוסף למסך הבית"</strong></li>
                    <li className="flex items-start gap-2"><span className="font-bold text-primary">3.</span> לחץ <strong>"הוסף"</strong></li>
                  </>
                )}
              </ol>
              <Button size="sm" variant="ghost" className="w-full mt-1" onClick={() => setShowInstructions(false)}>
                סגור
              </Button>
            </div>
          )}
        </>
      )}
    </SectionCard>
  );
}

// ─── Telegram Settings Section (all users) ───────────────────────────────────

function TelegramSettingsSection() {
  const { data: tgSettings, refetch } = trpc.priceAlerts.getTelegramSettings.useQuery();
  const [chatId, setChatId] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (tgSettings) {
      setChatId(tgSettings.chatId ?? "");
      setEnabled(tgSettings.enabled);
    }
  }, [tgSettings]);

  const updateMut = trpc.priceAlerts.updateTelegramSettings.useMutation({
    onSuccess: () => {
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
      refetch();
      toast.success("הגדרות Telegram נשמרו");
    },
    onError: (e) => toast.error(e.message),
  });

  const testMut = trpc.priceAlerts.sendTestTelegram.useMutation({
    onSuccess: (d) => d.success ? toast.success("✅ הודעת בדיקה נשלחה!") : toast.error("השליחה נכשלה — ודא שה-Chat ID נכון"),
    onError: (e) => toast.error(e.message),
  });

  return (
    <SectionCard
      icon={<Send className="w-4 h-4 text-primary" />}
      title="התראות Telegram"
      description="קבל התראות SL/TP ואיתותים ישירות ל-Telegram. הזן את ה-Chat ID שלך (ניתן לקבל דרך בוט @userinfobot)."
    >
      <FieldRow label="Telegram Chat ID" hint="ה-ID האישי שלך ב-Telegram (מספר שלילי)">
        <div className="flex gap-2">
          <Input
            placeholder="למשל: 123456789"
            value={chatId}
            onChange={(e) => setChatId(e.target.value)}
            className="font-mono text-sm"
          />
          <Button
            size="sm"
            variant="outline"
            onClick={() => testMut.mutate()}
            disabled={!chatId || testMut.isPending}
            className="shrink-0 gap-1.5 min-h-[44px]"
          >
            {testMut.isPending ? (
              <div className="w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin" />
            ) : (
              <Send className="w-3.5 h-3.5" />
            )}
            בדוק
          </Button>
        </div>
      </FieldRow>
      <FieldRow label="הפעל התראות">
        <div className="flex items-center gap-3">
          <button
            role="switch"
            aria-checked={enabled}
            onClick={() => setEnabled(!enabled)}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
              enabled ? "bg-primary" : "bg-muted"
            }`}
          >
            <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
              enabled ? "translate-x-6" : "translate-x-1"
            }`} />
          </button>
          <span className="text-sm text-muted-foreground">{enabled ? "התראות פעילות" : "התראות כבויות"}</span>
        </div>
      </FieldRow>
      <div className="flex justify-end">
        <Button
          size="sm"
          onClick={() => updateMut.mutate({ enabled, chatId: chatId || undefined })}
          disabled={updateMut.isPending}
          className="gap-1.5 min-h-[44px]"
        >
          {saved ? (
            <><CheckCircle2 className="w-4 h-4" /> נשמר</>
          ) : updateMut.isPending ? (
            <><div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" /> שומר...</>
          ) : (
            "שמור הגדרות"
          )}
        </Button>
      </div>
    </SectionCard>
  );
}

// ─── User Management Section ────────────────────────────────────────────────

function UserManagementSection() {
  const { user } = useAuth();
  const [showForm, setShowForm] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [newName, setNewName] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [resetId, setResetId] = useState<number | null>(null);
  const [resetPw, setResetPw] = useState("");
  const [telegramEditId, setTelegramEditId] = useState<number | null>(null);
  const [telegramInput, setTelegramInput] = useState("");

  const utils = trpc.useUtils();

  const { data: localUsers = [], isLoading } = trpc.localUsers.list.useQuery(undefined, {
    enabled: user?.role === "admin",
  });

  const createMutation = trpc.localUsers.create.useMutation({
    onSuccess: () => {
      toast.success("User created");
      setShowForm(false);
      setNewEmail(""); setNewName(""); setNewPassword("");
      utils.localUsers.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const deleteMutation = trpc.localUsers.delete.useMutation({
    onSuccess: () => { toast.success("User deleted"); utils.localUsers.list.invalidate(); },
    onError: (e) => toast.error(e.message),
  });

  const updateMutation = trpc.localUsers.update.useMutation({
    onSuccess: () => { toast.success("Password updated"); setResetId(null); setResetPw(""); utils.localUsers.list.invalidate(); },
    onError: (e) => toast.error(e.message),
  });

  const toggleActiveMutation = trpc.localUsers.update.useMutation({
    onSuccess: () => { utils.localUsers.list.invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  const telegramMutation = trpc.localUsers.update.useMutation({
    onSuccess: () => { toast.success("טלגרם עודכן"); setTelegramEditId(null); setTelegramInput(""); utils.localUsers.list.invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  const adminTestTelegramMut = trpc.priceAlerts.adminSendTestToUser.useMutation({
    onSuccess: (d) => d.success ? toast.success("✅ Test sent!") : toast.error("Failed to send"),
    onError: (e) => toast.error(e.message),
  });

  if (user?.role !== "admin") return null;

  return (
    <SectionCard
      icon={<Users className="w-4 h-4 text-primary" />}
      title="ניהול משתמשים"
      description="צור וערוך משתמשים עם כניסה עצמאית (email + סיסמה). לכל משתמש תיק Holdings נפרד."
    >
      {/* User list */}
      {isLoading ? (
        <div className="text-xs text-muted-foreground">טוען...</div>
      ) : localUsers.length === 0 ? (
        <div className="text-xs text-muted-foreground py-2">אין משתמשים מקומיים עדיין.</div>
      ) : (
        <div className="space-y-2">
          {localUsers.map((u) => (
            <div key={u.id} className="flex items-center gap-3 rounded-lg border border-border/60 bg-muted/20 px-4 py-3">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-foreground">{u.name}</p>
                <p className="text-xs text-muted-foreground">{u.email}</p>
                {u.lastSignedIn && (
                  <p className="text-[10px] text-muted-foreground/70">כניסה אחרונה: {new Date(u.lastSignedIn).toLocaleString()}</p>
                )}
                {u.telegramChatId && (
                  <p className="text-[10px] text-[#2563EB]/80">📱 Telegram: {u.telegramChatId}</p>
                )}
              </div>
              <Badge variant={u.isActive ? "outline" : "secondary"} className={`text-[10px] shrink-0 ${u.isActive ? "text-[#059669] border-emerald-500/40 bg-emerald-500/10" : ""}`}>
                {u.isActive ? "פעיל" : "מושבת"}
              </Badge>
              {/* Telegram Chat ID inline edit */}
              {telegramEditId === u.id ? (
                <div className="flex items-center gap-2">
                  <Input
                    placeholder="Chat ID (מספר)"
                    value={telegramInput}
                    onChange={(e) => setTelegramInput(e.target.value)}
                    className="h-7 text-xs w-32"
                  />
                  <Button size="sm" className="h-7 text-xs" onClick={() => telegramMutation.mutate({ id: u.id, telegramChatId: telegramInput || null })} disabled={telegramMutation.isPending}>שמור</Button>
                  <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setTelegramEditId(null)}>ביטול</Button>
                </div>
              ) : (
                <div className="flex items-center gap-1">
                  <Button size="sm" variant="ghost" className="h-7 text-xs gap-1 text-[#2563EB]" onClick={() => { setTelegramEditId(u.id); setTelegramInput(u.telegramChatId ?? ""); }}>
                    📱 TG
                  </Button>
                  {u.telegramChatId && (
                    <Button size="sm" variant="ghost" className="h-7 text-xs gap-1 text-[#059669]" title="Send test Telegram" onClick={() => adminTestTelegramMut.mutate({ chatId: u.telegramChatId! })} disabled={adminTestTelegramMut.isPending}>
                      <Send className="w-3 h-3" />
                    </Button>
                  )}
                </div>
              )}
              {/* Reset password inline */}
              {resetId === u.id ? (
                <div className="flex items-center gap-2">
                  <Input
                    type="password"
                    placeholder="סיסמה חדשה"
                    value={resetPw}
                    onChange={(e) => setResetPw(e.target.value)}
                    className="h-7 text-xs w-32"
                  />
                  <Button size="sm" className="h-7 text-xs" onClick={() => updateMutation.mutate({ id: u.id, password: resetPw })} disabled={!resetPw || updateMutation.isPending}>שמור</Button>
                  <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setResetId(null)}>ביטול</Button>
                </div>
              ) : (
                <Button size="sm" variant="ghost" className="h-7 text-xs gap-1" onClick={() => setResetId(u.id)}>
                  <KeyRound className="w-3 h-3" /> סיסמה
                </Button>
              )}
              <Button
                size="sm" variant="ghost"
                className={`h-7 text-xs gap-1 ${u.isActive ? "text-amber-500" : "text-[#059669]"}`}
                onClick={() => toggleActiveMutation.mutate({ id: u.id, isActive: !u.isActive })}
              >
                {u.isActive ? "השבת" : "הפעל"}
              </Button>
              <Button
                size="sm" variant="ghost"
                className="h-7 text-xs gap-1 text-destructive hover:text-destructive"
                onClick={() => { if (confirm(`מחק את ${u.name}?`)) deleteMutation.mutate({ id: u.id }); }}
              >
                <Trash2 className="w-3 h-3" />
              </Button>
            </div>
          ))}
        </div>
      )}

      {/* Add user form */}
      {showForm ? (
        <div className="rounded-lg border border-primary/30 bg-primary/5 p-4 space-y-3">
          <p className="text-sm font-semibold text-foreground">משתמש חדש</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Input placeholder="שם מלא" value={newName} onChange={(e) => setNewName(e.target.value)} className="text-sm" />
            <Input placeholder="כתובת אימייל" type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} className="text-sm" />
          </div>
          <div className="relative">
            <Input
              type={showPw ? "text" : "password"}
              placeholder="סיסמה (לפחות 6 תווים)"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="text-sm pr-10"
            />
            <button type="button" className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground" onClick={() => setShowPw(!showPw)}>
              {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={() => createMutation.mutate({ email: newEmail, name: newName, password: newPassword })}
              disabled={!newEmail || !newName || newPassword.length < 6 || createMutation.isPending}
              className="gap-1.5"
            >
              <UserPlus className="w-3.5 h-3.5" /> צור משתמש
            </Button>
            <Button size="sm" variant="outline" onClick={() => setShowForm(false)}>ביטול</Button>
          </div>
        </div>
      ) : (
        <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setShowForm(true)}>
          <UserPlus className="w-3.5 h-3.5" /> הוסף משתמש
        </Button>
      )}
    </SectionCard>
  );
}

// ─── Security Section ───────────────────────────────────────────────────────

function SecuritySection() {
  const [totpStatus, setTotpStatus] = useState<{ configured: boolean; verified: boolean } | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [revoking, setRevoking] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);

  useEffect(() => {
    fetch("/api/totp/status")
      .then((r) => r.json())
      .then((d) => setTotpStatus(d))
      .catch(() => setTotpStatus(null))
      .finally(() => setStatusLoading(false));
  }, []);

  const handleRevokeAll = async () => {
    if (!confirmRevoke) {
      setConfirmRevoke(true);
      setTimeout(() => setConfirmRevoke(false), 5000);
      return;
    }
    setRevoking(true);
    try {
      const res = await fetch("/api/2fa/revoke-all", { method: "POST" });
      const data = await res.json();
      if (data.success) {
        toast.success("All sessions revoked. Redirecting to login...");
        setTimeout(() => { window.location.href = "/"; }, 1500);
      } else {
        toast.error(data.error ?? "Failed to revoke sessions");
      }
    } catch {
      toast.error("Network error");
    } finally {
      setRevoking(false);
      setConfirmRevoke(false);
    }
  };

  return (
    <SectionCard
      icon={<Shield className="w-4 h-4 text-primary" />}
      title="Security"
      description="Manage two-factor authentication and active sessions for your account."
    >
      {/* TOTP Status */}
      <div className="flex items-center justify-between rounded-lg border border-border/60 bg-muted/20 px-4 py-3">
        <div className="flex items-center gap-3">
          {statusLoading ? (
            <div className="w-8 h-8 rounded-lg bg-muted flex items-center justify-center">
              <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
            </div>
          ) : totpStatus?.configured ? (
            <div className="w-8 h-8 rounded-lg bg-emerald-500/10 flex items-center justify-center">
              <ShieldCheck className="w-4 h-4 text-[#059669]" />
            </div>
          ) : (
            <div className="w-8 h-8 rounded-lg bg-amber-500/10 flex items-center justify-center">
              <ShieldOff className="w-4 h-4 text-amber-500" />
            </div>
          )}
          <div>
            <p className="text-sm font-medium text-foreground">Google Authenticator (TOTP)</p>
            <p className="text-xs text-muted-foreground">
              {statusLoading ? "Checking..." : totpStatus?.configured ? "Configured and active" : "Not configured"}
            </p>
          </div>
        </div>
        {!statusLoading && (
          <Badge
            variant="outline"
            className={`text-xs ${
              totpStatus?.configured
                ? "text-[#059669] border-emerald-500/40 bg-emerald-500/10"
                : "text-amber-600 border-amber-500/40 bg-amber-500/10"
            }`}
          >
            {totpStatus?.configured ? "Active" : "Not set up"}
          </Badge>
        )}
      </div>

      {/* Revoke All Sessions */}
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 space-y-3">
        <div className="flex items-start gap-3">
          <div className="w-8 h-8 rounded-lg bg-destructive/10 flex items-center justify-center shrink-0 mt-0.5">
            <LogOut className="w-4 h-4 text-destructive" />
          </div>
          <div className="flex-1">
            <p className="text-sm font-semibold text-foreground">Revoke All Sessions</p>
            <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
              Immediately invalidates all active sessions across all devices. You will be logged out and required to log in and complete 2FA again.
            </p>
          </div>
        </div>
        {confirmRevoke && (
          <div className="flex items-center gap-2 text-xs text-destructive bg-destructive/10 border border-destructive/20 rounded-lg px-3 py-2">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
            Click again to confirm — this will log you out immediately from all devices.
          </div>
        )}
        <Button
          variant="destructive"
          size="sm"
          onClick={handleRevokeAll}
          disabled={revoking}
          className="gap-2"
        >
          {revoking ? (
            <><div className="w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin" /> Revoking...</>
          ) : confirmRevoke ? (
            <><AlertTriangle className="w-3.5 h-3.5" /> Confirm — Revoke All Sessions</>
          ) : (
            <><LogOut className="w-3.5 h-3.5" /> Revoke All Sessions</>
          )}
        </Button>
      </div>
    </SectionCard>
  );
}

// ─── System Logs Section ──────────────────────────────────────────────────────
type LogMeta = {
  key: string;
  label: string;
  description: string;
  file: string;
  size: number;
  lastModified: string | null;
  available: boolean;
};

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function SystemLogsSection() {
  const [logs, setLogs] = useState<LogMeta[]>([]);
  const [loading, setLoading] = useState(false);
  const [previewing, setPreviewing] = useState<string | null>(null);
  const [previewContent, setPreviewContent] = useState<string>("");
  const [previewLoading, setPreviewLoading] = useState(false);

  const fetchLogList = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/system-logs/list");
      const data = await res.json();
      setLogs(data);
    } catch {
      toast.error("Failed to fetch log list");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchLogList(); }, []);

  const handleDownload = (key: string) => {
    window.open(`/api/system-logs/download/${key}`, "_blank");
  };

  const handleDownloadAll = () => {
    window.open("/api/system-logs/download-all", "_blank");
  };

  const handlePreview = async (key: string) => {
    if (previewing === key) { setPreviewing(null); return; }
    setPreviewing(key);
    setPreviewLoading(true);
    setPreviewContent("");
    try {
      const res = await fetch(`/api/system-logs/preview/${key}`);
      const text = await res.text();
      // Show last ~200 lines for readability
      const lines = text.split("\n");
      setPreviewContent(lines.slice(-200).join("\n"));
    } catch {
      setPreviewContent("Error loading preview");
    } finally {
      setPreviewLoading(false);
    }
  };

  const logIcons: Record<string, React.ReactNode> = {
    persistent: <FileText className="w-4 h-4" />,
    server: <Terminal className="w-4 h-4" />,
    browser: <BarChart2 className="w-4 h-4" />,
    network: <Link2 className="w-4 h-4" />,
    activity: <FileText className="w-4 h-4" />,
  };

  return (
    <SectionCard
      icon={<Download className="w-4 h-4 text-primary" />}
      title="System Logs"
      description="Download server, browser, network, and activity logs to monitor system health and debug issues."
    >
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs text-muted-foreground">{logs.length} log files available</p>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={fetchLogList} disabled={loading} className="gap-1.5 text-xs h-7">
            <RefreshCw className={`w-3 h-3 ${loading ? "animate-spin" : ""}`} /> Refresh
          </Button>
          <Button size="sm" variant="outline" onClick={handleDownloadAll} className="gap-1.5 text-xs h-7">
            <Download className="w-3 h-3" /> Download All
          </Button>
        </div>
      </div>

      <div className="space-y-2">
        {logs.map((log) => (
          <div key={log.key} className="rounded-lg border border-border/60 bg-muted/20 overflow-hidden">
            <div className="flex items-center gap-3 px-4 py-3">
              <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${
                log.available ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"
              }`}>
                {logIcons[log.key] ?? <FileText className="w-4 h-4" />}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium text-foreground">{log.label}</p>
                  {log.available ? (
                    <Badge variant="outline" className="text-[10px] h-4 px-1.5 text-[#059669] border-emerald-500/40 bg-emerald-500/10">
                      {log.key === "persistent" ? `${log.size.toLocaleString()} entries` : formatBytes(log.size)}
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="text-[10px] h-4 px-1.5 text-muted-foreground">empty</Badge>
                  )}
                </div>
                <p className="text-xs text-muted-foreground truncate">{log.description}</p>
                {log.lastModified && (
                  <p className="text-[10px] text-muted-foreground/70 mt-0.5">
                    Last updated: {new Date(log.lastModified).toLocaleString()}
                  </p>
                )}
              </div>
              <div className="flex gap-1.5 shrink-0">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => handlePreview(log.key)}
                  disabled={!log.available}
                  className="h-7 text-xs gap-1"
                >
                  {previewing === log.key ? "Hide" : "Preview"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => handleDownload(log.key)}
                  disabled={!log.available}
                  className="h-7 text-xs gap-1"
                >
                  <Download className="w-3 h-3" /> Download
                </Button>
              </div>
            </div>
            {previewing === log.key && (
              <div className="border-t border-border/60">
                {previewLoading ? (
                  <div className="p-4 flex items-center gap-2 text-xs text-muted-foreground">
                    <div className="w-3 h-3 border border-primary border-t-transparent rounded-full animate-spin" />
                    Loading preview...
                  </div>
                ) : (
                  <pre className="p-4 text-[10px] font-mono text-muted-foreground overflow-x-auto max-h-64 overflow-y-auto bg-white/20 whitespace-pre-wrap break-all">
                    {previewContent || "(empty)"}
                  </pre>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </SectionCard>
  );
}
