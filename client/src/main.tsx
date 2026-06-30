import { trpc } from "@/lib/trpc";
import { UNAUTHED_ERR_MSG } from '@shared/const';
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink, httpLink, splitLink, TRPCClientError } from "@trpc/client";
import { createRoot } from "react-dom/client";
import superjson from "superjson";
import App from "./App";
import "./index.css";
import { IbkrTickleProvider } from "./contexts/IbkrTickleContext";
import { IbkrRefreshProvider } from "./contexts/IbkrRefreshContext";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Cache data for 30 seconds before re-fetching — reduces redundant API calls on navigation
      staleTime: 30_000,
      // Keep unused data in cache for 5 minutes
      gcTime: 5 * 60_000,
      // Don't retry on 4xx errors (auth, not found)
      retry: (failureCount, error) => {
        if (error instanceof TRPCClientError) {
          const status = (error as any)?.data?.httpStatus;
          if (status && status >= 400 && status < 500) return false;
        }
        return failureCount < 2;
      },
      // Don't refetch on window focus for better UX (can be overridden per-query)
      refetchOnWindowFocus: false,
    },
  },
});

const redirectToLoginIfUnauthorized = (error: unknown) => {
  if (!(error instanceof TRPCClientError)) return;
  if (typeof window === "undefined") return;

  const isUnauthorized = error.message === UNAUTHED_ERR_MSG;
  if (!isUnauthorized) return;

  const path = window.location.pathname;
  if (path === "/login" || path === "/verify-2fa" || path === "/change-password") return;

  window.location.href = "/login";
};

queryClient.getQueryCache().subscribe(event => {
  if (event.type === "updated" && event.action.type === "error") {
    const error = event.query.state.error;
    redirectToLoginIfUnauthorized(error);
    console.error("[API Query Error]", error);
  }
});

queryClient.getMutationCache().subscribe(event => {
  if (event.type === "updated" && event.action.type === "error") {
    const error = event.mutation.state.error;
    redirectToLoginIfUnauthorized(error);
    console.error("[API Mutation Error]", error);
  }
});

const trpcFetch: typeof fetch = (input, init) =>
  globalThis.fetch(input, { ...(init ?? {}), credentials: "include" });

const trpcLinkOptions = {
  url: "/api/trpc",
  transformer: superjson,
  fetch: trpcFetch,
} as const;

/** Order-status polling — never batch (War Room has many parallel queries). */
const POLLING_PATHS = new Set(["liveEngine.getExitProgress", "ibkr.getOrderStatus"]);

const trpcClient = trpc.createClient({
  links: [
    splitLink({
      condition(op) {
        return op.type === "query" && POLLING_PATHS.has(op.path);
      },
      true: httpLink({ ...trpcLinkOptions, methodOverride: "POST" }),
      false: httpBatchLink({
        ...trpcLinkOptions,
        methodOverride: "POST",
        maxItems: 8,
      }),
    }),
  ],
});

createRoot(document.getElementById("root")!).render(
  <trpc.Provider client={trpcClient} queryClient={queryClient}>
    <QueryClientProvider client={queryClient}>
      <IbkrTickleProvider>
        <IbkrRefreshProvider>
          <App />
        </IbkrRefreshProvider>
      </IbkrTickleProvider>
    </QueryClientProvider>
  </trpc.Provider>
);
