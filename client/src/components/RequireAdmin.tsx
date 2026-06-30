import { useAuth } from "@/_core/hooks/useAuth";
import { Redirect } from "wouter";
import { Loader2 } from "lucide-react";

/**
 * RequireAdmin — wraps admin-only pages.
 * - While auth is loading: shows spinner
 * - Not authenticated: redirects to /login
 * - Authenticated but NOT admin: redirects to / (home)
 * - Admin: renders children
 */
export function RequireAdmin({ children }: { children: React.ReactNode }) {
  const { user, isAuthenticated, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-background">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Redirect to="/login" />;
  }

  if ((user as any)?.role !== "admin") {
    return <Redirect to="/" />;
  }

  return <>{children}</>;
}
