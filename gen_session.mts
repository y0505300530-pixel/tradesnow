
import { SignJWT } from "jose";
import mysql from "mysql2/promise";

async function main() {
  const secret = new TextEncoder().encode("a2DUsbDtmfk2Pt7pTNgDWc");
  // Use local:120001 - the actual admin openId in the DB
  const token = await new SignJWT({ 
    openId: "local:120001", 
    appId: "jaDEMUoCJyxDvKw6XvdrrS",
    name: "Yehuda"
  })
  .setProtectedHeader({ alg: "HS256" })
  .setExpirationTime("365d")
  .setIssuedAt()
  .sign(secret);
  
  const expiresAt = Date.now() + 365 * 24 * 60 * 60 * 1000;
  const conn = await mysql.createConnection("mysql://tradesnow:TsV2026_LocalDb@127.0.0.1:3306/tradesnow");
  await conn.execute(
    "INSERT INTO verified_sessions (session_token, open_id, created_at, expires_at) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE expires_at=?",
    [token, "local:120001", Date.now(), expiresAt, expiresAt]
  );
  await conn.end();
  console.log("TOKEN:" + token);
}

main().catch(e => { console.error(e); process.exit(1); });
