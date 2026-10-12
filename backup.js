import { backup } from 'node:sqlite';
import { openStore } from './store.js';
import { resolve, dirname } from 'node:path';
import { mkdirSync, existsSync, chmodSync } from 'node:fs';

process.umask(0o077);
const target = process.argv[2];
if (!target) { console.error('Usage: npm run backup -- /private/path/portal-backup.sqlite'); process.exit(1); }
const source = resolve(process.env.DATA_DIR || 'data', 'portal.sqlite');
const destination = resolve(target);
if (!existsSync(source)) { console.error('No live database exists at the configured DATA_DIR.'); process.exit(1); }
if (existsSync(destination)) { console.error('Choose a new backup path; existing files are never overwritten.'); process.exit(1); }
mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
const db = openStore(source);
try { await backup(db, destination); chmodSync(destination, 0o600); console.log('Complete database backup saved. Keep it private.'); }
finally { db.close(); }
