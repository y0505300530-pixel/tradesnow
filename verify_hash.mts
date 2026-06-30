
import bcrypt from "bcryptjs";
const hash = await bcrypt.hash("Tradesnow2026!", 12);
const stored = await import("mysql2/promise").then(m => 
  m.createConnection("mysql://tradesnow:TsV2026_LocalDb@127.0.0.1:3306/tradesnow")
).then(async conn => {
  const [rows] = await conn.query("SELECT passwordHash FROM localUsers WHERE id=120001");
  await conn.end();
  return (rows as any)[0]?.passwordHash;
});
console.log("STORED:", stored?.substring(0,30));
console.log("NEW:", hash.substring(0,30));
const ok = await bcrypt.compare("Tradesnow2026!", stored);
console.log("COMPARE:", ok);
