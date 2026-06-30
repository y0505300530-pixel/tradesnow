/**
 * kronosEngine.ts — Kronos forecast integration for catalogue scoring
 *
 * Ziv score (userAssets.score) stays the SSOT for Elsa entry gates.
 * Kronos adds a bias (-2..+2) for catalogue ranking / second opinion only.
 *
 * compositeScore = clamp(zivScore + kronosBias, 1, 10)
 */

import { spawn } from "node:child_process";
import path from "node:path";

export type KronosDirection = "UP" | "DOWN" | "FLAT";

export interface KronosForecast {
  ticker: string;
  direction: KronosDirection;
  lastClose: number;
  meanPredClose: number;
  pctChange: number;
  bandLo: number;
  bandHi: number;
  bandWidthPct: number;
  predLen: number;
  period: string;
  interval: string;
}

export interface KronosBiasResult {
  bias: number;
  compositeScore: number;
  forecast: KronosForecast;
}

const KRONOS_SCRIPT = path.join(
  process.env.HOME ?? "/root",
  ".cursor/skills/kronos/scripts/run_kronos.py",
);

const RUN_TIMEOUT_MS = 180_000; // 3 min per ticker (first run may download model)

/** Confidence scaler from band width — narrow = stronger conviction */
function confidenceFromBand(bandWidthPct: number): number {
  if (bandWidthPct < 6) return 1.0;
  if (bandWidthPct < 12) return 0.55;
  if (bandWidthPct < 20) return 0.3;
  return 0.15;
}

/** Map forecast → bias in [-2, +2] */
export function computeKronosBias(forecast: KronosForecast): number {
  const conf = confidenceFromBand(forecast.bandWidthPct);
  const magnitude = 1.35 * conf;
  if (forecast.direction === "UP") return +magnitude;
  if (forecast.direction === "DOWN") return -magnitude;
  return 0;
}

export function computeCompositeScore(zivScore: number, kronosBias: number | null | undefined): number {
  const bias = kronosBias ?? 0;
  return Math.min(10, Math.max(1, Math.round((zivScore + bias) * 10) / 10));
}

function parseDirection(pctChange: number): KronosDirection {
  if (Math.abs(pctChange) < 0.5) return "FLAT";
  return pctChange > 0 ? "UP" : "DOWN";
}

/** Run Kronos CLI with --json and parse result */
export async function runKronosForecast(
  ticker: string,
  opts?: { period?: string; interval?: string; predLen?: number },
): Promise<KronosForecast | null> {
  const period = opts?.period ?? "6mo";
  const interval = opts?.interval ?? "1d";
  const predLen = opts?.predLen ?? 24;

  return new Promise((resolve) => {
    const args = [
      KRONOS_SCRIPT,
      ticker.toUpperCase(),
      period,
      interval,
      String(predLen),
      "--json",
    ];

    // DEFENSE-IN-DEPTH (live engine): spawn() can throw SYNCHRONOUSLY in rare cases
    // (bad options, EMFILE). An async ENOENT (missing python3 / stale .cursor script
    // path on the droplet) surfaces via child.on("error") below. Either way we
    // resolve(null) — fail-open — so a kronos failure can NEVER throw/crash Node.
    let child;
    try {
      child = spawn("python3", args, {
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err: any) {
      console.warn(`[Kronos] spawn threw for ${ticker}:`, err?.message ?? err);
      resolve(null);
      return;
    }

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => { stdout += d.toString(); });
    child.stderr?.on("data", (d) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      console.warn(`[Kronos] Timeout for ${ticker}`);
      resolve(null);
    }, RUN_TIMEOUT_MS);

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        console.warn(`[Kronos] ${ticker} exit ${code}: ${stderr.slice(0, 200)}`);
        resolve(null);
        return;
      }
      try {
        const line = stdout.trim().split("\n").find((l) => l.startsWith("{"));
        if (!line) {
          console.warn(`[Kronos] ${ticker}: no JSON in output`);
          resolve(null);
          return;
        }
        const raw = JSON.parse(line);
        const lastClose = Number(raw.last_close);
        const meanPred = Number(raw.mean_pred_close);
        const pctChange = Number(raw.pct_change);
        const bandLo = Number(raw.band_lo);
        const bandHi = Number(raw.band_hi);
        const bandWidthPct = lastClose > 0 ? ((bandHi - bandLo) / lastClose) * 100 : 99;

        const forecast: KronosForecast = {
          ticker: ticker.toUpperCase(),
          direction: (raw.direction as KronosDirection) ?? parseDirection(pctChange),
          lastClose,
          meanPredClose: meanPred,
          pctChange,
          bandLo,
          bandHi,
          bandWidthPct,
          predLen: Number(raw.pred_len ?? predLen),
          period: String(raw.period ?? period),
          interval: String(raw.interval ?? interval),
        };
        resolve(forecast);
      } catch (e) {
        console.warn(`[Kronos] ${ticker} parse error:`, e);
        resolve(null);
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      console.warn(`[Kronos] spawn error for ${ticker}:`, err.message);
      resolve(null);
    });
  });
}

export async function scoreWithKronos(
  ticker: string,
  zivScore: number,
  opts?: { period?: string; interval?: string; predLen?: number },
): Promise<KronosBiasResult | null> {
  const forecast = await runKronosForecast(ticker, opts);
  if (!forecast) return null;
  const bias = computeKronosBias(forecast);
  return {
    bias: Math.round(bias * 100) / 100,
    compositeScore: computeCompositeScore(zivScore, bias),
    forecast,
  };
}

/** Skip .TA and crypto for Kronos (yfinance mapping unreliable) */
export function isKronosEligible(ticker: string): boolean {
  const t = ticker.toUpperCase();
  if (t.endsWith(".TA")) return false;
  if (t.endsWith("-USD")) return false;
  return /^[A-Z][A-Z0-9.\-]{0,10}$/.test(t);
}

const KRONOS_STALE_MS = 48 * 60 * 60 * 1000; // refresh every 48h

export function isKronosStale(scannedAt: Date | string | null | undefined): boolean {
  if (!scannedAt) return true;
  const ts = new Date(scannedAt).getTime();
  return Date.now() - ts > KRONOS_STALE_MS;
}
