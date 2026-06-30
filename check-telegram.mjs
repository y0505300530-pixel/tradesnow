import 'dotenv/config';
import mysql from 'mysql2/promise';

const conn = await mysql.createConnection(process.env.DATABASE_URL);

const [localUsers] = await conn.execute('SELECT id, name, email, telegramChatId, linkedUserId FROM localUsers');
console.log('\n=== localUsers ===');
console.table(localUsers);

const [settings] = await conn.execute('SELECT userId, telegramEnabled, telegramChatId FROM userSettings');
console.log('\n=== userSettings (telegram) ===');
console.table(settings);

const [users] = await conn.execute('SELECT id, name, email FROM users WHERE id IN (1740142, 6213506, 7620254)');
console.log('\n=== relevant users ===');
console.table(users);

await conn.end();
