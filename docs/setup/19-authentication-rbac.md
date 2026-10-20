# 19. Authentication & RBAC

[setup.md](../../setup.md) · previous: [§18](18-automated-reporting.md) · next: [§20](20-acknowledge-close-write-back.md)

Implements `plan_1.2.md` (in `myown/plan/`, outside this repo) Phase 7 and closes its defect #5. Every source slide in
HCML's review is stamped Private and Confidential, so an open portal is not deployable.

`AUTH_ENABLED=true` turns on JWT login; the `onRequest` guard then rejects unauthenticated `/api/*`
calls. Exactly four routes are excepted, `/api/health`, `/api/auth/login`, `/api/auth/me` and
`/api/auth/logout`, and the guard judges the route the router matched rather than the URL text, so
an encoded path such as `/%61pi/hosts` is guarded like `/api/hosts`. The Zabbix token is never
exposed either way: RBAC decides who sees which portal view, not what the BFF may ask Zabbix.
`/api/health` is public, so it carries the version, build and `ready` state, and nothing sensitive:
no address, token or error text. `GET /api/auth/me` also returns `pages`, the role each menu page
needs, worked out from the same rules (`pageAccess.ts`), so the sidebar keeps no copy of them.

## Three roles

The portal is read-only but for one write (§20), so roles divide by sensitivity and cost, and only an operator may write:

| Role | Gets | Rationale |
|---|---|---|
| viewer | all monitoring, Sites, Hosts, Devices (without the Ports link), Services, SLA, reports, the Dashboard's Overview and Hosts views, and "Explain" | The plain-language layer exists *precisely* for non-engineers. Gating it higher would defeat its purpose. |
| operator | + Network, Links & WAN health, the Dashboard's Internet traffic view, and the Ports link of Devices | Engineering surfaces, which is interface data; also the one role that may acknowledge or close, when write-back is switched on (§20). |
| admin | + Inventory & ownership scorecard | Governance, not monitoring. |

Enforcement lives in [`auth.ts`](../../server/src/security/auth.ts) `ROUTE_RULES`, **first match wins, and anything
unmatched requires `viewer`**: so a newly added route is protected by default rather than
accidentally public. A 403 explains itself: *"This view needs the admin role; you are signed in as
viewer."*

The sidebar hides what a role can't reach, but that is only courtesy: the BFF enforces it
regardless, and the UI never holds a permission decision the server doesn't also make.

## Users

There's no database yet (that phase was deferred), so users come from the environment:

```bash
AUTH_ENABLED=true
JWT_SECRET=<openssl rand -hex 32>       # required; a published value or under 32 bytes stops the boot
PORTAL_USERS=ana:secret:viewer,budi:secret:operator,citra:secret:admin
SESSION_COOKIE=hcml_session             # optional; two portals on one host need different names
SESSION_HOURS=12                        # optional; how long one sign-in lasts, 2 to 24
SESSION_EPOCH=1                         # optional; raise it and restart to end every session at once
# or the single-admin shorthand:
PORTAL_USER=admin
PORTAL_PASS=zabbix
```

Malformed entries are warned about and skipped; an unknown role falls back to `viewer`, never to
something more privileged. The BFF refuses to start while any user's password is empty or `admin`,
and `POST /api/auth/login` takes 10 attempts a minute per account and address. With
`AUTH_ENABLED=false` the BFF reports role `admin` so the scaffold runs open with zero setup, and
none of the secret or password checks run: that is a dev convenience and `docker-compose.yml`
defaults it to true.

Next: SSO or LDAP in place of env users. The acknowledge/close write-back that once sat here too is built
(§20), through a separate `ZABBIX_WRITE_TOKEN` that is deliberately not the read-only token.


## What changed on 7 October 2026 (tracker SC-14, SC-19, SC-22, BK-03, FR-13, SC-07, SC-20, IN-09)

- Every request looks its user up again. A token is checked, then the user is found in `PORTAL_USERS` and the current role is used, not the one the token was signed with. Remove someone and restart the BFF and their tokens stop working at once; change a role and it takes effect at once. A new `JWT_SECRET` still ends everyone's.
- Tokens name their portal. Each carries an issuer and an audience built from the session cookie name (`hcml-portal:hcml_session`, `hcml-portal:hcml_session_ollama`), so a token from :8081 is refused on :8082 even when both share a `JWT_SECRET`. No `.env` change is needed.
- Names ignore case, and a password may hold a colon. `Ana` and `ana` are one account for sign-in and for the lockout counter. The name is what comes before the first `:` and the role what comes after the last, so the password between them can contain `:`. Two entries that differ only by case are warned about at start.
- Hashed passwords are optional. A password in `PORTAL_USERS` or `PORTAL_PASS` is plain text, as before, or an scrypt hash of the form `scrypt.N.r.p.salt.hash` (Node's own `crypto`, no new package). Make one with `printf '%s' 'the password' | npx tsx scripts/hash-password.ts` from `server/`, or run the script alone to be asked twice with nothing shown, and paste the line where the password was. The password is read from standard input, never from an argument, so it stays out of the shell history. A hash of `admin` or of nothing is refused at start, like the plain text. A check costs about 100 ms and 32 MiB, and an unknown name costs one too, so a wrong name is not quicker to refuse.
- Sign-ins are logged. Every attempt writes a line with the name as typed (control characters removed, 64 characters at most), the outcome (`success`, `failure`, `locked` or `rate_limited`) and the address, never the password. Five failures in a row for one name, from any address, raise a warning, and again at every fifth. A password typed into the username box is logged as a name.
- `AUTH_ENABLED` is read strictly. Unset or empty is on; empty used to mean off. `true`, `1` and `yes` are on, `false`, `0` and `no` are off, in any case. Anything else, such as a typo, stops the server at start and names the accepted values.
- With sign-in off the server answers only to this machine. Every caller is admin then, so a `Host` that is not `localhost`, `127.0.0.1`, `::1` or the host of `WEB_ORIGIN` gets `421`, which stops a page on another site reaching the dev server by DNS rebinding. Write-back is refused as well unless `ALLOW_WRITE_WITHOUT_AUTH=true`: a dev `server/.env` with sign-in off and a write token now needs that line to acknowledge anything. The setting is not passed to the containers.
- Interface data is for operators. A viewer does not get items whose key starts with `net.if` from `/api/items` or `/api/latest`, and `/api/graph` answers `403` when asked for one by id (`/api/history` and `/api/trend` did too, until BK-11 removed them). On `/api/maps/detail` a viewer does not get the network hosts, the network host groups or the links that end at them, **but only when `NET_GROUP_IDS` names the network host groups**: with it empty nothing says which hosts are network devices, so nothing is cut. Operators and admins see everything, and an unknown role counts as a viewer.
- A public `/api/health` is short. Anyone gets `ok`, `ts`, `ai`, `aiProvider`, `aiExternal`, `writeBack` and `defaults`. The version, start time, build, `ready` (including `token_rejected`) and the screen count are for a signed-in caller only.

Upgrading from a build before issuer and audience (7 October 2026, SC-14). Tokens issued before the deploy carry neither claim and are refused. Reload every open portal tab right after the deploy and sign in again, wall screens included: a tab left open lands on the sign-in page at its next request.
