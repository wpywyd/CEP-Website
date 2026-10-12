# CEP Student Project Showcase — online platform

The online platform provides a public showcase, school-scoped teacher accounts, and student registration with one final vote per voting round. The original offline HTML portal and its instructions are retained unchanged.

## Run locally

Use Node.js 24 or newer (the server uses Node's built-in SQLite module). No runtime packages or external database service are required.

```sh
npm ci
npm run teacher -- coordinator admin
npm run teacher -- school1.teacher school-1
npm start
```

Teacher creation prompts for a hidden password containing 8–128 characters, at least one letter and at least one number; symbols are optional. Running the command again changes that account's password and access scope and revokes existing sessions. `admin` means programme-wide access; `school-1` through `school-9` limit a teacher to that school. The command supports a securely supplied `TEACHER_PASSWORD` for noninteractive provisioning; do not put passwords in shell history, source files, or command arguments.

The server defaults to port 3000 and binds to loopback. Use the **Teacher workspace** to sign in, set real school names, add each school's real classes under **Schools & import**, and create projects. Set a project to **Published** to show it publicly and make it available for voting. A fresh database has nine placeholder schools, an open initial voting round, no classes, no accounts, and no sample projects. Students cannot register until their school has classes configured.

## Student registration and voting

- Students choose a configured school and class, enter their full name as recorded by the school, choose a username/password, and confirm their name.
- The server normalises Unicode compatibility characters, capitalisation, and repeated whitespace for a unique **school + class + full name** database key. Display names retain spelling and capitalisation. Legitimate single-word names and non-Latin names are supported.
- A username is unique across student accounts. Passwords are salted and hashed with scrypt. Only hashed session tokens are stored; browser cookies are HttpOnly and SameSite=Strict.
- The database enforces one vote per student account per voting round. Votes cannot be replaced, even from another device or in concurrent requests. Student passwords can be reset by a teacher with access to that school, without removing the vote.
- Programme administrators can close a round and then open a new one. Students get one new vote in a new round. Prior votes stay stored; public totals show the latest round, and only published projects.
- Names, usernames and classes are visible only to authorised teachers and the signed-in student. Public endpoints expose published project information and aggregate vote counts, never student records or teacher feedback.
- Open registration checks matching details; it cannot verify that a claimed name is real or stop a person registering under different details. Two students with the same full name in the same class are blocked by the duplicate rule and must contact the programme administrator for review. There is no automatic bypass.
- There is no verified student-to-team mapping in this registration model, so students can vote for any published project. Own-team exclusion would require a trusted team assignment.

## Import existing offline work

Export JSON from the original offline portal, then upload it under **Schools & import**. Imports are transactional, restricted to the teacher's school scope, and skip previously imported IDs. A school teacher should use a school-specific backup; an all-school administrator can import the full master backup. Offline votes, voter codes and thumbnails are not imported. Students must register online; each project uses the included original SVG artwork until a separate image-upload feature is added.

**Export project records** provides a scoped JSON export of project records. It is not a complete database backup and does not include student accounts, password hashes or voting history.

## Tests

```sh
npm test
npm run test:browser
```

The API tests use isolated temporary databases and cover identity duplicates, concurrent registrations and votes, permissions, privacy, server restart persistence, password recovery, project conflicts, round transitions, import behaviour and production cookies. The browser smoke test uses a fresh temporary database and Chromium to exercise the teacher and student workflows. Set `CHROMIUM_PATH` if Chromium is elsewhere. Chromium is available in the prepared cloud environment; on other machines install a trusted Chromium build separately. Browser test screenshots are written to the OS temporary directory. Test accounts and votes are never written to your live database.

## Hosting

This is a persistent Node application, not a static site. Deploy one application instance on a host with Node 24+, an HTTPS reverse proxy and a persistent disk. A static-only hosting service will not run this backend. SQLite supports this initial single-instance school workflow; do not run multiple replicas with separate disks.

Environment configuration:

| Variable | Purpose | Default |
| --- | --- | --- |
| `PORT` | Server port | `3000` |
| `HOST` | Listen interface; use `0.0.0.0` behind the hosting proxy | `127.0.0.1` |
| `DATA_DIR` | Persistent private directory holding `portal.sqlite` | `data` relative to the working directory |
| `NODE_ENV` | Set to `production` on hosting | unset |
| `PUBLIC_ORIGIN` | Exact HTTPS origin, e.g. `https://showcase.example.org`, no trailing slash | required in production |

Use `npm ci --omit=dev` for production; the server has no runtime dependencies. Run the same teacher provisioning command on the host with the same `DATA_DIR`, then start with `npm start`. Do not put the database or backups under `public/`. Production uses Secure cookies, HTTPS origin checks, security headers and same-origin request protection. Keep the full persistent data directory private. Rate limits use the actual socket address rather than trusting user-supplied proxy headers; on hosting with a reverse proxy, users share those limits, which may need tuning for your actual traffic.

For a consistent full backup while running:

```sh
npm run backup -- /private/backups/portal-backup.sqlite
```

The backup command uses SQLite's online backup API and includes students, credentials, sessions and all rounds. Restrict access to backups accordingly. To restore, stop the application, preserve the existing database, replace it with the backup, remove only the old matching `-wal` and `-shm` sidecars, then restart with the same `DATA_DIR`. A restored snapshot also restores sessions present at backup time; revoke sessions if recovering from an access incident.

The cloud development environment is not public hosting. A live deployment still requires choosing and configuring your hosting account, domain and persistent storage.
