/**
 * Dynamic VIP — daily refresh CLI. Dry-run by default (logs, writes NOTHING); pass --write to
 * persist the snapshot to systemSettings.dynamic_vip (exactly what the 17:00 IL cron will do).
 * Never touches the trading engine or dynamicVipEnabled.
 *   node --env-file=.env --import tsx scripts/refresh-dynamic-vip.ts [--write]
 * Spec: docs/superpowers/specs/2026-07-01-dynamic-vip-weekly-priority-spec.md (+ handoff v2)
 */
import { computeVipSnapshot } from "../server/dynamicVipRefresh";

async function main() {
  const persist = process.argv.includes("--write");
  const snap = await computeVipSnapshot(Date.now(), { persist });
  const { tiers, reasons, dayId } = snap;
  console.log(`[VIP-DRYRUN] dayId=${dayId} persist=${persist}`);
  console.log(`[VIP-DRYRUN] ⭐⭐ VIP-A (${tiers["VIP-A"].length}): ${tiers["VIP-A"].join(", ")}`);
  console.log(`[VIP-DRYRUN] ⭐ VIP-B (${tiers["VIP-B"].length}): ${tiers["VIP-B"].join(", ")}`);
  console.log(`[VIP-DRYRUN] 🪑 BENCH (${tiers.BENCH.length}): ${tiers.BENCH.slice(0, 40).join(", ")}${tiers.BENCH.length > 40 ? " …" : ""}`);
  for (const t of ["MTSI", "RIOT"]) {
    const tier = (["VIP-A", "VIP-B", "BENCH"] as const).find((k) => tiers[k].includes(t));
    console.log(`[VIP-DRYRUN] DV-G1 ${t} → ${tier ?? "-"} ${tier === "BENCH" ? "✅" : tier ? "⚠️ expected BENCH" : "(not in universe)"}  reasons=[${(reasons[t] || []).join(",")}]`);
  }
  console.log(`[VIP-DRYRUN] ${persist ? "PERSISTED to systemSettings.dynamic_vip" : "DRY-RUN — wrote nothing"}. dynamicVipEnabled unchanged, engine untouched.`);
  process.exit(0);
}
main().catch((e) => { console.error("[VIP-DRYRUN] error:", e); process.exit(1); });
