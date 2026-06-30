/**
 * Catalogue status gates for Elza / kinetic scoring.
 * IPO_INCUBATOR — newborn listings (<60 bars); no live entries until hydrated.
 * DATA_BLIP_BYPASS — transient data gap; excluded from kinetic universe but stays in catalogue.
 */

export type CatalogStatus = "IPO_INCUBATOR" | "DATA_BLIP_BYPASS" | null;

export const IPO_INCUBATOR = "IPO_INCUBATOR" as const;
export const DATA_BLIP_BYPASS = "DATA_BLIP_BYPASS" as const;

export const KINETIC_MIN_BARS = 60;

export function blocksElzaEntry(status: CatalogStatus | string | null | undefined, barCount?: number): boolean {
  if (status === IPO_INCUBATOR) {
    if (barCount != null && barCount >= KINETIC_MIN_BARS) return false;
    return true;
  }
  return false;
}

export function isKineticScorable(status: CatalogStatus | string | null | undefined): boolean {
  return status !== IPO_INCUBATOR && status !== DATA_BLIP_BYPASS;
}

export function elzaEntryBlockReason(
  ticker: string,
  status: CatalogStatus | string | null | undefined,
  barCount?: number,
): string | null {
  if (status === IPO_INCUBATOR) {
    if (barCount != null && barCount >= KINETIC_MIN_BARS) return null;
    return `${ticker} IPO_INCUBATOR — ${barCount ?? 0}/${KINETIC_MIN_BARS} bars; live entry blocked until vector is hydrated`;
  }
  return null;
}
