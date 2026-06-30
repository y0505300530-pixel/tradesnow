/**
 * RequireVerified — 2FA gate for all protected routes.
 *
 * Renders children ONLY when:
 *  1. User is authenticated (has a session)
 *  2. The session has been TOTP-verified (needs2fa === false)
 *
 * If needs2fa === true → redirect to /verify-2fa
 * If not authenticated at all → redirect to login.
 *
 * This is a RENDER-LEVEL block, not just a redirect effect.
 * Even if the user navigates via SPA links, the page content
 * will never render until 2FA is cleared.
 */

import { useEffect } from "react";

import { trpc } from "@/lib/trpc";
import { Loader2 } from "lucide-react";

type Props = {
  children: React.ReactNode;
};

export function RequireVerified({ children }: Props) {
  const meQuery = trpc.auth.me.useQuery(undefined, {
    retry: false,
    refetchOnWindowFocus: true,
    staleTime: 10_000,
  });

  const data = meQuery.data as
    | (typeof meQuery.data & { needs2fa?: boolean })
    | null
    | undefined;

  const isLoading = meQuery.isLoading;
  const isAuthenticated = Boolean(data);
  const needs2fa = Boolean(data?.needs2fa);

  useEffect(() => {
    if (isLoading) return;
    if (typeof window === "undefined") return;

    if (!isAuthenticated) {
      window.location.href = "/login";
      return;
    }

    if (needs2fa) {
      if (window.location.pathname !== "/verify-2fa") {
        window.location.href = "/verify-2fa";
      }
    }
  }, [isLoading, isAuthenticated, needs2fa]);

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!isAuthenticated || needs2fa) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return <>{children}</>;
}
