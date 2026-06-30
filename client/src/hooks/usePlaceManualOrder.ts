/**
 * Bridge hook for liveEngine.placeManualOrder (Claude backend).
 * Uses typed client proxy until AppRouter includes the procedure.
 */
import { useCallback } from "react";
import { trpc } from "@/lib/trpc";
import type { PlaceManualOrderInput, PlaceManualOrderResult } from "@/lib/manualOrderContract";

type MutateOptions = {
  onSuccess?: (data: PlaceManualOrderResult, input: PlaceManualOrderInput) => void;
  onError?: (err: { message: string }) => void;
  onMutate?: () => void;
};

/**
 * Calls liveEngine.placeManualOrder when merged; surfaces clear error if missing.
 */
export function usePlaceManualOrder(options?: MutateOptions) {
  const utils = trpc.useUtils();

  const mutate = useCallback(
    async (input: PlaceManualOrderInput) => {
      options?.onMutate?.();
      const client = utils.client as {
        liveEngine?: {
          placeManualOrder?: {
            mutate: (i: PlaceManualOrderInput) => Promise<PlaceManualOrderResult>;
          };
        };
      };
      const proc = client.liveEngine?.placeManualOrder;
      if (!proc?.mutate) {
        const err = {
          message:
            "placeManualOrder עדיין לא זמין — ממתין ל-merge של Claude לשרת",
        };
        options?.onError?.(err);
        throw err;
      }
      try {
        const data = await proc.mutate(input);
        options?.onSuccess?.(data, input);
        return data;
      } catch (e: unknown) {
        const err = { message: e instanceof Error ? e.message : String(e) };
        options?.onError?.(err);
        throw err;
      }
    },
    [utils.client, options],
  );

  return {
    mutate,
    mutateAsync: mutate,
    isPending: false,
  };
}
