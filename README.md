# BedFlow Backend

Node + Express + TypeScript API with WebSockets, JWT auth, an alarm/reminder
scheduler, web-push, and an immutable audit trail. Database is SQLite now,
isolated behind an adapter so PostgreSQL is a drop-in swap.

## Run locally
```bash
npm install
cp .env.example .env        # set JWT_SECRET at minimum
npm run seed                # creates DB in ./database, 12 users, 16 wards, 163 beds
npm run dev                 # http://localhost:4000
```

## Accounts (default)
- PRE: pre1..pre10 / preN123 (e.g. pre1 / pre1123)
- Manager: manager / manager123
- COO: coo / coo123

## Database location
SQLite file lives in `backend/database/bedflow.db` (its own folder, per spec).
Override the path with `SQLITE_PATH` in `.env`.

## Swapping to PostgreSQL later
The database engine is isolated in `src/db/`:
- `adapter.ts` — the `Db` interface (run/get/all/transaction)
- `sqlite.ts` — current implementation (Node built-in SQLite)
- `index.ts` — single export; change this one import to switch engines

To migrate: create `src/db/postgres.ts` implementing the same `Db` interface
(e.g. using `pg`), then point `index.ts` at it. Convert `schema.sql` types
(INTEGER timestamps stay as BIGINT; CHECK constraints become Postgres ENUMs if
desired). No service or route code changes.

## API
- POST /api/auth/login
- GET  /api/pre/me · POST /api/pre/shift · POST /api/pre/ward · POST /api/pre/submit
- GET  /api/manager/wards · POST /api/manager/wards · POST /api/manager/assign · GET /api/manager/users
- GET  /api/coo/overview · GET /api/coo/audit · GET /api/coo/snapshots
- GET  /api/meta · POST /api/push/subscribe
- GET  /api/health

## WebSocket
Socket.IO on the same port, JWT-authenticated via `handshake.auth.token`.
Events: `bed:update`, `round:submit`, `alarm:active`. COO/Manager join the
`overview` room; each PRE joins `pre:{code}`.

## Scheduler
Runs every 30s: pushes overdue PRE reminders (works whether or not the user is
logged in), fires COO reminders at 9/12/15/18, and snapshots occupancy hourly.

## Web push (optional)
```bash
npx web-push generate-vapid-keys   # paste into .env as VAPID_PUBLIC / VAPID_PRIVATE
```

## Alarm limitations (must document)
1. Web apps cannot guarantee alarm sound if the browser is fully terminated.
2. Exact alarm timing varies by browser/OS.
3. Chrome on Android gives the best PWA push support.
4. Push notifications are the best web-based background solution.
5. Service workers handle background notification display.
True ring-through-silent/closed-phone behavior requires a native app.
