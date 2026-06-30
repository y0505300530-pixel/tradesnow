import { useState } from "react";
import { useLocation } from "wouter";

export default function ChangePasswordPage() {
  const [, navigate] = useLocation();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (newPassword.length < 10) {
      setError("הסיסמה החדשה חייבת להכיל לפחות 10 תווים");
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("הסיסמאות אינן תואמות");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/local-auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error || "שגיאה בשינוי הסיסמה");
        setLoading(false);
        return;
      }
      setSuccess(true);
      setLoading(false);
      setTimeout(() => navigate("/login"), 2500);
    } catch {
      setError("שגיאת תקשורת. נסה שוב.");
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#F4F6F8] text-[#4A5568] flex items-center justify-center p-4" dir="rtl">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-lg p-8">
        <h1 className="text-2xl font-black text-[#65A30D] mb-1">שינוי סיסמה</h1>
        <p className="text-sm text-gray-500 mb-6">trade-snow2.vip</p>
        {success ? (
          <div className="text-green-600 font-semibold text-center py-8">
            הסיסמה שונתה בהצלחה! מעביר למסך ההתחברות...
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-1">סיסמה נוכחית</label>
              <input type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-[#65A30D]" required />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">סיסמה חדשה (לפחות 10 תווים)</label>
              <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-[#65A30D]" required />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">אימות סיסמה חדשה</label>
              <input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-[#65A30D]" required />
            </div>
            {error && <div className="text-red-600 text-sm">{error}</div>}
            <button type="submit" disabled={loading}
              className="w-full bg-[#65A30D] text-white font-semibold rounded-lg py-2.5 hover:bg-[#4d7a0a] disabled:opacity-50 transition">
              {loading ? "מעדכן..." : "שנה סיסמה"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
