#!/usr/bin/env node
/**
 * Provision Dror dormant infrastructure — ZERO impact on CEO live trading.
 *
 * - Applies migration 0146 if missing (schema + seeds, Dror isEnabled=0)
 * - Creates local login (email/password) + links tradingAccounts.linkedLocalUserId
 * - Never enables Dror engine or MULTI_ACCOUNT_LIVE
 *
 * Usage: npm run provision:dror-dormant
 * Optional: DROR_TEMP_PASSWORD='...' DROR_EMAIL='dror@...' npm run provision:dror-dormant
 */
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { getDb } from "../server/db";
import {
  localUsers,
  users,
  tradingAccounts,
  liveEngineConfig,
} from "../drizzle/schema";

const DROR_EMAIL = (process.env.DROR_EMAIL ?? "dror@trade-snow2.vip").toLowerCase().trim();
const DROR_NAME = process.env.DROR_NAME ?? "דרור";
const LOGIN_URL = process.env.PUBLIC_APP_URL ?? "https://trade-snow2.vip/login";
const MIGRATION = join(process.cwd(), "drizzle/0146_multi_trading_accounts.sql");
const FIXUP = join(process.cwd(), "drizzle/0147_multi_account_fixup.sql");

function genPassword(): string {
  if (process.env.DROR_TEMP_PASSWORD?.trim()) return process.env.DROR_TEMP_PASSWORD.trim();
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#";
  let out = "Dr";
  for (let i = 0; i < 10; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out + "26";
}

async function tableExists(db: NonNullable<Awaited<ReturnType<typeof getDb>>>): Promise<boolean> {
  try {
    await db.select({ id: tradingAccounts.id }).from(tradingAccounts).limit(1);
    return true;
  } catch {
    return false;
  }
}

function runMigrationSqlFile(path: string): void {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL missing");
  const parsed = new URL(url);
  const user = decodeURIComponent(parsed.username);
  const pass = decodeURIComponent(parsed.password);
  const host = parsed.hostname;
  const port = parsed.port || "3306";
  const database = parsed.pathname.replace(/^\//, "").split("?")[0];
  execSync(
    `mysql -h ${host} -P ${port} -u ${user} -p${pass} ${database} < ${path}`,
    { stdio: "inherit" },
  );
}

async function ensureLinkedUser(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  localUser: { id: number; email: string; name: string },
): Promise<number> {
  const syntheticOpenId = `local:${localUser.id}`;
  const existing = await db.select({ id: users.id }).from(users).where(eq(users.openId, syntheticOpenId)).limit(1);
  if (existing[0]) return existing[0].id;
  const [res] = await db.insert(users).values({
    openId: syntheticOpenId,
    name: localUser.name,
    email: localUser.email,
    loginMethod: "local",
    role: "user",
  });
  const linkedUserId = res.insertId as number;
  await db.update(localUsers).set({ linkedUserId }).where(eq(localUsers.id, localUser.id));
  return linkedUserId;
}

async function main() {
  console.log("[provision-dror] Dormant setup — CEO live trading untouched.\n");

  const db = await getDb();
  if (!db) throw new Error("DB unavailable");

  if (!(await tableExists(db))) {
    console.log("[provision-dror] Applying 0146_multi_trading_accounts.sql …");
    try {
      runMigrationSqlFile(MIGRATION);
    } catch {
      console.log("[provision-dror] 0146 partial — applying 0147 fixup …");
      runMigrationSqlFile(FIXUP);
    }
  } else {
    console.log("[provision-dror] tradingAccounts exists — ensure Dror config …");
    try {
      runMigrationSqlFile(FIXUP);
    } catch {
      /* fixup idempotent — ignore duplicate index etc. */
    }
  }

  const password = genPassword();
  let localRow = await db
    .select()
    .from(localUsers)
    .where(eq(localUsers.email, DROR_EMAIL))
    .limit(1);

  if (!localRow[0]) {
    const passwordHash = await bcrypt.hash(password, 12);
    const [ins] = await db.insert(localUsers).values({
      email: DROR_EMAIL,
      passwordHash,
      name: DROR_NAME,
      role: "user",
      isActive: true,
    });
    localRow = [{
      id: ins.insertId as number,
      email: DROR_EMAIL,
      passwordHash,
      name: DROR_NAME,
      role: "user" as const,
      isActive: true,
      linkedUserId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: null,
      telegramChatId: null,
    }];
    console.log("[provision-dror] Created local user:", DROR_EMAIL);
  } else {
    console.log("[provision-dror] Local user exists:", DROR_EMAIL);
    if (process.env.DROR_TEMP_PASSWORD?.trim()) {
      const passwordHash = await bcrypt.hash(process.env.DROR_TEMP_PASSWORD.trim(), 12);
      await db.update(localUsers).set({ passwordHash }).where(eq(localUsers.id, localRow[0].id));
      console.log("[provision-dror] Password reset from DROR_TEMP_PASSWORD.");
    }
  }

  const linkedUserId = await ensureLinkedUser(db, {
    id: localRow[0].id,
    email: DROR_EMAIL,
    name: DROR_NAME,
  });

  const drorAcct = await db.select().from(tradingAccounts).where(eq(tradingAccounts.slug, "dror")).limit(1);
  if (!drorAcct[0]) throw new Error("tradingAccounts slug=dror missing — run migration 0146");

  await db
    .update(tradingAccounts)
    .set({ linkedLocalUserId: linkedUserId })
    .where(eq(tradingAccounts.slug, "dror"));

  await db
    .update(liveEngineConfig)
    .set({ isEnabled: 0 })
    .where(eq(liveEngineConfig.tradingAccountId, drorAcct[0].id));

  const credPath = join(process.cwd(), "secrets/dror-dormant-login.txt");
  mkdirSync(join(process.cwd(), "secrets"), { recursive: true });
  const effectivePassword = process.env.DROR_TEMP_PASSWORD?.trim() || password;
  const body = [
    "# Dror dormant login — TEMPORARY — rotate before go-live",
    `# Generated: ${new Date().toISOString()}`,
    "",
    `Login URL: ${LOGIN_URL}`,
    `Email:     ${DROR_EMAIL}`,
    `Password:  ${effectivePassword}`,
    "",
    "Dormant guards:",
    "  - liveEngineConfig.isEnabled = 0 (Dror)",
    "  - alertPoller = CEO cycle only",
    "  - MULTI_ACCOUNT_LIVE_ENABLED unset",
    "",
    "War Room (after deploy): https://trade-snow2.vip/war-room/dror",
    "Overview:               https://trade-snow2.vip/overview",
  ].join("\n");
  writeFileSync(credPath, body, { mode: 0o600 });

  console.log("\n✅ Dror dormant infrastructure ready.");
  console.log(`   linkedLocalUserId=${linkedUserId} → tradingAccounts.dror`);
  console.log(`   Credentials written: ${credPath}`);
  console.log(`   Login: ${LOGIN_URL}`);
  console.log(`   Email: ${DROR_EMAIL}`);
  if (!process.env.DROR_TEMP_PASSWORD) {
    console.log(`   Password: ${effectivePassword}`);
  }
}

main().catch((e) => {
  console.error("[provision-dror] FAILED:", e);
  process.exit(1);
});
