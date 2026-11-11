# Dixel Nexora: employee-only internal messaging

A private, real-time chat application for Dixel Technologies employees.
Node.js + Express, SQLite, WebSockets, and a plain HTML/CSS/JS frontend (no build step).

## What it does
- Sign-up and login restricted to `@dixeltechnologies.com` (checked on the server, exact domain match).
- Administrator approval for new employee accounts; matching admin invites can activate accounts immediately.
- Passwords hashed with bcrypt (cost 12); sessions stored server-side, cookie is `HttpOnly` + `SameSite=Strict`.
- Employee directory (name/department search), private 1:1 chats, real-time delivery, history, timestamps,
  last message in the conversation list, unread counts, read ticks, online/last-seen.
- Admin page: approve/reject sign-ups, invite employees, deactivate/reactivate (deactivation signs the user out instantly).
- Forgot/reset password (one-time, 1-hour link).
- Messages auto-deleted after `RETENTION_DAYS` (default 365).

## Run locally
Requires Node.js 18 or newer.

```bash
npm install
cp .env.example .env            # Windows: copy .env.example .env
# Set ADMIN_EMAIL and ADMIN_PASSWORD in .env to create the initial administrator.
npm start
```
Open http://localhost:3000

On startup, the app creates an active administrator from `ADMIN_EMAIL` and
`ADMIN_PASSWORD` only when that email is not already registered. Keep
`ADMIN_PASSWORD` secret. `DB_PATH` selects the SQLite database file, including
Render's persistent-disk mount path.

**Without SMTP configured** (development), password reset links are printed in the terminal and saved in `data/dev-mail.log`. Copy the link into your browser.

## Creating and approving employee accounts
Two ways, both under **Admin** (button at the top of the chat sidebar, or `/admin`):

1. **Invite list (recommended):** add the employee's company email (optionally Employee ID and department). When they sign up with matching details, they are activated automatically if `AUTO_APPROVE_INVITED=true`. If you set an Employee ID on the invite, they must enter the same ID at sign-up.
2. **Manual approval:** an employee with a company email can sign up and immediately appears as *pending* until you click **Approve** under "Waiting for approval".

Set `AUTO_APPROVE_INVITED=false` to require manual approval for everyone.

Employees sign up at `/signup.html` and can sign in at `/login.html` after an administrator approves their account. Matching invited employees can sign in immediately.

## Production checklist
- Serve over HTTPS (reverse proxy such as nginx/Caddy) and set `APP_URL=https://...`, `COOKIE_SECURE=true`, `TRUST_PROXY=true`, `NODE_ENV=production`.
- Configure SMTP so password reset emails are delivered.
- Back up `data/chat.db` regularly (it contains messages and accounts). Keep the folder out of web roots and version control.
- Run with a process manager (systemd, pm2) and keep Node.js and dependencies patched (`npm audit`).
- Messages are protected by access control and TLS in transit; they are not end-to-end encrypted, and anyone with server/database access can read them.

## Project layout
```
src/server.js        app entry, security headers, page guards, retention job
src/routes/          auth.js, chat.js, admin.js (REST API under /api)
src/realtime.js      authenticated WebSocket (/ws) and presence
src/security.js      validation, sessions, auth middleware
src/db.js            SQLite connection + migration runner
migrations/          SQL schema and approval-flow updates
public/              login/signup/forgot/reset pages, CSS, browser JS
views/               chat.html and admin.html (served only to signed-in users)
scripts/             create-admin.js, smoke-test.js
```

## Tests
`npm test` starts a temporary server and database and runs end-to-end checks: domain restriction, pending approval, invite activation, login, route protection, real-time delivery, history, conversation isolation, logout, deactivation, and password reset.

## Security notes
- All authorization is enforced on the server for REST and WebSocket; conversation IDs from the browser are never trusted.
- Message text is rendered with `textContent` (never as HTML); a strict Content-Security-Policy is set.
- Login, signup and reset endpoints are rate limited; responses do not reveal whether an email is registered.
- State-changing requests need a custom header plus a SameSite=Strict cookie (CSRF defence); WebSocket origin is checked.
