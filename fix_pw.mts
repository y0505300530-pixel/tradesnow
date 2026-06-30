
import bcrypt from "bcryptjs";
import mysql from "mysql2/promise";

const conn = await mysql.createConnection("mysql://tradesnow:TsV2026_LocalDb@127.0.0.1:3306/tradesnow");

const hash = await bcrypt.hash("Tradesnow2026!", 12);
console.log("Generated hash:", hash.substring(0, 30) + "...");

await conn.execute("UPDATE localUsers SET passwordHash=? WHERE id=120001", [hash]);
console.log("Updated OK");

// Verify
const [rows] = await conn.query("SELECT passwordHash FROM localUsers WHERE id=120001") as any;
const stored = rows[0]?.passwordHash;
const ok = await bcrypt.compare("Tradesnow2026!", stored);
console.log("Verify compare:", ok);
console.log("FULL_HASH:" + hash);

await conn.end();
