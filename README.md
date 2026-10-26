# Project Showcase

Project Showcase is a year-round platform where Singapore students form teams, build project pages, receive private teacher feedback, publish approved work, and vote in administrator-created rounds.

## Run locally

Install Node.js 24 or newer, then run:

```sh
npm ci
npm run teacher -- coordinator admin
npm start
```

The teacher command creates or resets the first programme administrator. It prompts for a hidden password containing 8–128 characters with at least one letter and one number.

Open these addresses after the server starts:

| Address                         | Purpose                                      |
| ------------------------------- | -------------------------------------------- |
| `http://localhost:3000`         | Public year-round project showcase           |
| `http://localhost:3000/student` | Student dashboard, teams, and project editor |
| `http://localhost:3000/vote`    | Current student ballot                       |
| `http://localhost:3000/results` | Live voting results                          |
| `http://localhost:3000/teacher` | School teacher review workspace              |
| `http://localhost:3000/admin`   | Programme administrator workspace            |

## Main workflow

1. The programme administrator signs in at `/admin`, creates school teacher accounts, and maintains schools and categories.
2. Students register immediately using a school, freely typed class, full name, username, and password.
3. A student creates a same-school team and shares its private join code. Teams support up to five students, and each student can belong to one active team.
4. The team edits one active project. Every project field is required for review. The browser crops JPG, PNG, or WebP cover images to 16:9 (up to 5 MB), and accepts an MP4 or WebM demo video up to 50 MB.
5. Submitting locks the revision. A school teacher reviews the public preview, leaves private feedback, and either requests changes or approves publication.
6. Published projects appear publicly. Later edits create a separate revision while the approved version stays online.
7. An administrator selects published projects and opens a named voting round for all or selected schools. The ballot locks when opened.
8. Each active student can cast one final vote per round. Projects belonging to that student’s own team are excluded. Live results use shared ranks for tied totals.

Student names, classes, usernames, team membership, teacher feedback, and account history never appear on public project pages. Teachers can access only their school; programme administrators can manage the complete platform. Passwords use salted scrypt hashes, session tokens are hashed, cookies are HttpOnly and SameSite=Strict, and important changes create audit events.

The original interface remains temporarily available at `/legacy` for rollback comparison. The approved static design prototype remains at `/prototype`; neither is linked from the production navigation.

## Tests

```sh
npm test
npm run test:browser
```

The API suite covers the original migration-compatible workflows and the redesigned team, review, selected-ballot, own-team exclusion, and final-vote workflow. The Chromium test covers student registration, team creation, image processing, project submission, teacher approval, public publication, privacy headers, and mobile rendering. Tests use temporary databases and do not change live data.

## Data and hosting

SQLite data is stored in `data/portal.sqlite` by default, with project videos in `data/project-videos`. Existing installations are migrated automatically when the server starts. Make a full online backup with:

```sh
npm run backup -- /private/backups/portal-backup.sqlite
```

When videos exist, the backup command also creates a matching `portal-backup.sqlite.videos` directory. Keep both together. When restoring, place the database at `DATA_DIR/portal.sqlite` and copy the contents of the `.videos` directory into `DATA_DIR/project-videos`.

Production requires one persistent Node.js 24+ application instance, HTTPS, and private persistent storage. Configure:

| Variable        | Purpose                                                           | Default     |
| --------------- | ----------------------------------------------------------------- | ----------- |
| `PORT`          | Server port                                                       | `3000`      |
| `HOST`          | Listen interface                                                  | `127.0.0.1` |
| `DATA_DIR`      | Private persistent directory                                      | `data`      |
| `NODE_ENV`      | Set to `production` on the host                                   | unset       |
| `PUBLIC_ORIGIN` | Exact HTTPS origin with no trailing slash; required in production | unset       |

Use `npm ci --omit=dev` in production. Keep the database, backups, and environment configuration outside the public directory.
