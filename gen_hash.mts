
import bcrypt from "bcryptjs";
const hash = await bcrypt.hash("Tradesnow2026!", 12);
console.log("HASH:" + hash);
