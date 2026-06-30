import { TRPCClientError } from "@trpc/client";
import { NOT_ADMIN_ERR_MSG } from "@shared/const";
import { toast } from "sonner";

export const ACCESS_DENIED_TOAST = "Access Denied — admin permission required";

/** True when tRPC rejected the call due to missing admin role. */
export function isAccessDeniedError(err: unknown): boolean {
  if (!(err instanceof TRPCClientError)) return false;
  if (err.data?.code === "FORBIDDEN" && err.message === NOT_ADMIN_ERR_MSG) return true;
  if (err.message === NOT_ADMIN_ERR_MSG || err.message.includes("10002")) return true;
  return false;
}

/** Standard mutation onError — surfaces admin FORBIDDEN as a clear toast. */
export function toastMutationError(err: unknown, fallback = "Operation failed"): void {
  if (isAccessDeniedError(err)) {
    toast.error(ACCESS_DENIED_TOAST);
    return;
  }
  const message = err instanceof TRPCClientError ? err.message : String(err);
  toast.error(message || fallback);
}
