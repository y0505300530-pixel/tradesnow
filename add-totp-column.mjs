import mysql from "mysql2/promise";

const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL not set"); process.exit(1); }

const conn = await mysql.createConnection(url);
try {
  await conn.execute(
    "ALTER TABLE `users` ADD COLUMN IF NOT EXISTS `totpSecret` VARCHAR(64) NULL"
  );
  console.log("✅ totpSecret column added (or already exists)");
} catch (e) {
  // MySQL 5.x doesn't support IF NOT EXISTS on ALTER — try without it
  if (e.code === "ER_PARSE_ERROR") {
    try {
      await conn.execute("ALTER TABLE `users` ADD COLUMN `totpSecret` VARCHAR(64) NULL");
      console.log("✅ totpSecret column added");
    } catch (e2) {
      if (e2.code === "ER_DUP_FIELDNAME") {
        console.log("✅ totpSecret column already exists");
      } else {
        throw e2;
      }
    }
  } else {
    throw e;
  }
} finally {
  await conn.end();
}
