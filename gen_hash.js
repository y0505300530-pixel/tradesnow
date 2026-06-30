const bcrypt = require('bcryptjs');
async function main() {
  const hash = await bcrypt.hash('Tradesnow2026!', 12);
  console.log('HASH:' + hash);
}
main().catch(console.error);
