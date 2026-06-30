import { useState, useRef, useEffect } from "react";
import { Shield, CheckCircle, AlertCircle, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";

export default function Verify2FA() {
  const [code, setCode] = useState("");
  const [rememberDevice, setRememberDevice] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  async function handleVerify() {
    if (code.length !== 6) {
      setError("Please enter the 6-digit code from Google Authenticator.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/2fa/verify-existing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ code, rememberDevice }),
      });
      const data = await res.json() as { success?: boolean; error?: string };
      if (res.ok && data.success) {
        setSuccess(true);
        setTimeout(() => {
          window.location.href = "/";
        }, 800);
      } else {
        setError(data.error ?? "Incorrect code. Please try again.");
        setCode("");
        inputRef.current?.focus();
      }
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        {/* Brand */}
        <div className="text-center mb-8">
          <span className="text-2xl font-bold text-foreground">tradesnow</span>
          <span className="text-2xl font-bold text-primary">.vip</span>
        </div>

        <Card className="border border-border shadow-xl">
          <CardHeader className="text-center pb-4">
            <div className="mx-auto mb-4 w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
              {success ? (
                <CheckCircle className="w-8 h-8 text-green-500" />
              ) : (
                <Shield className="w-8 h-8 text-primary" />
              )}
            </div>
            <CardTitle className="text-xl">
              {success ? "Verified!" : "Two-Factor Authentication"}
            </CardTitle>
            <CardDescription>
              {success
                ? "Redirecting to the platform..."
                : "Enter the 6-digit code from Google Authenticator"}
            </CardDescription>
          </CardHeader>

          {!success && (
            <CardContent className="space-y-4">
              {/* Google Authenticator hint */}
              <div className="flex items-center gap-3 p-3 rounded-lg bg-primary/5 border border-primary/20">
                <Lock className="w-5 h-5 text-primary shrink-0" />
                <div>
                  <p className="text-sm font-medium text-foreground">Google Authenticator</p>
                  <p className="text-xs text-muted-foreground">Open the app and find tradesnow.vip</p>
                </div>
              </div>

              {/* Code input */}
              <div className="space-y-2">
                <Input
                  ref={inputRef}
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={6}
                  value={code}
                  onChange={(e) => {
                    const val = e.target.value.replace(/\D/g, "").slice(0, 6);
                    setCode(val);
                    setError(null);
                    if (val.length === 6) {
                      setTimeout(() => {
                        document.getElementById("verify-btn")?.click();
                      }, 100);
                    }
                  }}
                  onKeyDown={(e) => { if (e.key === "Enter") handleVerify(); }}
                  placeholder="000000"
                  className="text-center text-3xl tracking-[0.6em] font-mono h-16 bg-background border-border"
                  autoComplete="one-time-code"
                  disabled={loading}
                />
              </div>

              {/* Remember device */}
              <div className="flex items-center gap-2 py-1">
                <Checkbox
                  id="remember-device"
                  checked={rememberDevice}
                  onCheckedChange={(checked) => setRememberDevice(checked === true)}
                  disabled={loading}
                />
                <Label
                  htmlFor="remember-device"
                  className="text-sm text-muted-foreground cursor-pointer select-none"
                >
                  Remember this device (30 days — uncheck for 4 hours)
                </Label>
              </div>

              {/* Error */}
              {error && (
                <div className="flex items-center gap-2 p-3 rounded-lg bg-destructive/10 border border-destructive/20">
                  <AlertCircle className="w-4 h-4 text-destructive shrink-0" />
                  <p className="text-sm text-destructive">{error}</p>
                </div>
              )}

              {/* Verify button */}
              <Button
                id="verify-btn"
                onClick={handleVerify}
                disabled={loading || code.length !== 6}
                className="w-full h-12 text-base font-semibold btn-gold-shimmer"
              >
                {loading ? "Verifying..." : "Verify"}
              </Button>

              <p className="text-xs text-muted-foreground text-center">
                Code refreshes every 30 seconds. If it fails, wait for the next code.
              </p>
            </CardContent>
          )}
        </Card>
      </div>
    </div>
  );
}
