import React from "react";
import { GlobalNav } from "./GlobalNav";
import { useLocation } from "wouter";
// ─── RootLayout (app shell wrapper) ───────────────────────────────────────────
export function RootLayout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const isSplash = location === "/splash";
  return (
    <div className="min-h-screen" style={{ background: '#F4F6F8' }}>
      <GlobalNav />
      {/* pt-16 compensates for the fixed GlobalNav height (h-16 = 4rem). Skip on splash. */}
      <main className={isSplash ? "" : "pb-24 pt-16"}>
        {children}
      </main>
    </div>
  );
}
