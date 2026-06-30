
import { Router, Request, Response } from "express";
import { getDb } from "./db";
import { systemSettings } from "../drizzle/schema";
import { eq } from "drizzle-orm";

const warEngineRouter = Router();

warEngineRouter.get("/candidates", async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    if (!db) {
      return res.status(500).json({ error: "DB unavailable" });
    }

    const rows = await db.select().from(systemSettings)
      .where(eq(systemSettings.key, "war_upcoming_signals"))
      .limit(1);

    if (!rows || !rows[0]) {
      return res.json({ items: [], ts: 0 });
    }

    const data = rows[0].value ? JSON.parse(rows[0].value as string) : { items: [], ts: 0 };
    return res.json(data);
  } catch (err) {
    console.error("[/api/war-engine/candidates] Error:", err);
    return res.status(500).json({ error: String(err).slice(0, 100) });
  }
});

warEngineRouter.get("/status", async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    if (!db) {
      return res.status(500).json({ error: "DB unavailable" });
    }

    // Read candidates
    const rows = await db.select().from(systemSettings)
      .where(eq(systemSettings.key, "war_upcoming_signals"))
      .limit(1);

    const candidates = rows && rows[0]?.value 
      ? JSON.parse(rows[0].value as string)
      : { items: [], ts: 0 };

    // Simple status
    return res.json({
      ok: true,
      candidates: candidates.items || [],
      timestamp: candidates.ts || Date.now(),
    });
  } catch (err) {
    console.error("[/api/war-engine/status] Error:", err);
    return res.status(500).json({ error: String(err).slice(0, 100) });
  }
});

export default warEngineRouter;
