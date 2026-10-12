import { openStore, provisionTeacher } from './store.js';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';

const [username, scope] = process.argv.slice(2);
if (!username || !scope) {
  console.error('Usage: npm run teacher -- <username> <school ID | exact school name | admin>');
  console.error(
    'Interactive password input is hidden. For automation, supply TEACHER_PASSWORD securely.'
  );
  process.exit(1);
}
let password = process.env.TEACHER_PASSWORD;
if (!password) {
  if (!process.stdin.isTTY) {
    console.error('An interactive terminal or TEACHER_PASSWORD is required.');
    process.exit(1);
  }
  let mute = false;
  const output = new Writable({
    write(chunk, encoding, done) {
      if (!mute) process.stdout.write(chunk, encoding);
      done();
    }
  });
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
  const school =
    scope === 'admin'
      ? null
      : db
          .prepare(
            'SELECT id, name FROM schools WHERE is_active=1 AND (id=? OR lower(name)=lower(?))'
          )
          .get(scope, scope);
  if (scope !== 'admin' && !school)
    throw new Error('Unknown school. Use its exact name from the website or its sg- school ID.');
  provisionTeacher(db, username, password, school?.id || null);
  console.log(
    `Account ${username} saved with ${school ? school.name : 'all-school administrator'} access. Existing sessions were revoked.`
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  db.close();
}
