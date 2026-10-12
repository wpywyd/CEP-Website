import { openStore, provisionTeacher } from './store.js';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';

const [username, scope] = process.argv.slice(2);
if (!username || !scope) {
  console.error('Usage: npm run teacher -- <username> <school-1 … school-9 | admin>');
  console.error('Interactive password input is hidden. For automation, supply TEACHER_PASSWORD securely.');
  process.exit(1);
}
let password = process.env.TEACHER_PASSWORD;
if (!password) {
  if (!process.stdin.isTTY) { console.error('An interactive terminal or TEACHER_PASSWORD is required.'); process.exit(1); }
  let mute = false;
  const output = new Writable({ write(chunk, encoding, done) { if (!mute) process.stdout.write(chunk, encoding); done(); } });
  output.isTTY = true;
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  process.stdout.write('New password (8+ characters, including a letter and number): ');
  mute = true;
  password = await rl.question('');
  mute = false;
  process.stdout.write('\n');
  rl.close();
}
const db = openStore(resolve(process.env.DATA_DIR || 'data', 'portal.sqlite'));
try {
  provisionTeacher(db, username, password, scope === 'admin' ? null : scope);
  console.log(`Account ${username} saved with ${scope === 'admin' ? 'all-school administrator' : scope} access. Existing sessions were revoked.`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { db.close(); }
