
const jose = require('jose');

async function main() {
  const secret = new TextEncoder().encode('a2DUsbDtmfk2Pt7pTNgDWc');
  const token = await new jose.SignJWT({
    openId: 'local:120001',
    appId: 'jaDEMUoCJyxDvKw6XvdrrS',
    name: 'Yehuda'
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setExpirationTime(Math.floor(Date.now() / 1000) + 365 * 24 * 3600)
    .sign(secret);
  console.log(token);
}
main().catch(e => { console.error('ERR:', e.message); process.exit(1); });
