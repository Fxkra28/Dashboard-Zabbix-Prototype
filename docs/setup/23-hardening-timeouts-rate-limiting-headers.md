# 23. Hardening: timeouts, rate limiting, headers

[setup.md](../../setup.md) · previous: [§22](22-testing.md) · next: [§24](24-assistant.md)

Three plugins and one timeout, all in [`index.ts`](../../server/src/index.ts), registered in an order that
matters.

Timeouts. `fetch` has no default timeout. Before this, one unresponsive Zabbix held the request
open forever, and every page waiting on it was held up too. `zabbix.ts` now passes
`AbortSignal.timeout(config.zbxTimeoutMs)` and maps the abort to a typed `ZabbixTimeoutError` → 503,
alongside the existing `ZabbixAuthError`. Same reasoning as that one: *"Zabbix is not responding"*
and *"the portal is broken"* need different responses from whoever is reading the screen.

The hosted model client had the mirror-image problem: the SDK defaults to a 10-minute timeout
and two retries, which is sane for a batch job and absurd for a request a human is waiting on behind
a button. Both are now configured. The local backend re-uses `zabbix.ts`'s pattern directly
(`AbortSignal.timeout` → typed error), with a larger ceiling: a local model generates more slowly and
loads from disk when cold. It does not retry: a local model that failed once is usually down rather
than flaky.

Order of registration. helmet → cors → rate-limit → auth → routes.

Rate limiting sits *before* the auth guard so a flood is rejected before the server spends work
verifying JWTs on it, and a request the guard refuses still counts. It is a root `onRequest` hook
(`rateLimit.ts`): the plugin's own hooks go on each route and run after the guard. The endpoint that
actually needs it is `POST /api/auth/login`, which is otherwise an unthrottled password oracle, so
it also has a limit of its own, checked on top of the global one: 10 attempts a minute per account
and address (`LOGIN_ATTEMPTS_PER_MINUTE` in `auth.ts`). After 10 failed sign-ins in a row for one
account from one address, sign-in is locked for a minute, doubling with each further failure up to
5 minutes, and a success clears it (`LOGIN_LOCK_*`). The cap is short on purpose: behind Docker
every browser shares one address, so a long lock would lock the account out for everyone. Three exemptions: `/api/stream` holds
one long-lived connection per NOC screen rather than making repeated requests, and is capped
by its own count instead (`STREAM_MAX_CLIENTS`, `STREAM_MAX_PER_USER`, §7), `/api/health` is
polled deliberately by every page, and sign-out must never be refused, or the cookie would stay
working behind a page showing the sign-in form. They are matched against the route, so no spelling
of those paths is counted.

**`trustProxy` is a prerequisite, not a detail.** Behind nginx every request carries the proxy's IP,
so without it all users share one rate-limit bucket and the limiter is worthless. But turning it on
with *nothing* in front is worse: a client can then forge `X-Forwarded-For` and rotate past the
limit. Hence `TRUST_PROXY`, off by default and set true only in `docker-compose.yml`. `true` means
one hop, the nginx in front, and a positive integer N means N hops; anything else trusts none.
Fastify 5.12 reads a bare hop count as "trust nobody", so `config.ts` hands it Fastify 4's hop rule
as a function (`trustProxyOption`) instead.
Until 24 September `true` trusted every hop, so the left-most `X-Forwarded-For` entry, which the
client writes, picked the rate-limit key. With one hop the BFF reads the right-most entry, the one
nginx appended, and ignores anything the client put in front. With a TLS proxy in front of nginx,
set `TRUST_PROXY=2` in `.env` (compose passes it through). That proxy must also keep the browser's
`Host` header (nginx `proxy_set_header Host $http_host;`, Apache `ProxyPreserveHost On`; Caddy,
Traefik and HAProxy keep it by default). The sign-in and every cookie `POST` are refused with 403
`csrf` when the browser's `Origin` does not name the `Host` the BFF receives. The BFF never reads
`X-Forwarded-Host` for that check, because a client can set it. Behind Docker's port publishing every
browser reaches nginx from the same gateway address, so the sign-in limit is keyed on the username
as well as the address.

Shutdown. `shutdown.ts` handles `SIGTERM` and `SIGINT`: it ends every live stream (`app.close()`
would otherwise wait on them until Docker kills the container), closes, and exits 0, or exits 1 after
8 s, under Docker's 10 s stop timeout. A second signal exits at once. Compose also sets `init: true`
on `portal-bff`, and the Dockerfile's `CMD` stays in exec form with no `npm start` or shell in front,
since either would swallow the signal.

One header caveat. `stream.ts` writes its SSE headers through `reply.raw.writeHead`, bypassing
Fastify's reply object. helmet's headers still arrive, since helmet 13 sets them on the raw response
at `onRequest`, but the CORS headers do not. That is harmless: the stream is same-origin.

The app's own headers come from nginx. helmet covers the BFF's replies only. `web/nginx.conf`
adds `Content-Security-Policy`, `X-Frame-Options: SAMEORIGIN`,
`X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer` to the pages and files it
serves, and hides its version. The CSP is enforced since 14 October (SC-24, [section 32](32-what-changed-on-14-october-2026.md#32-what-changed-on-14-october-2026)):
a script, image or connection to another site is blocked, and `style-src` keeps `'unsafe-inline'`
because ECharts and React set inline styles. The BFF's own replies carry `Cache-Control: no-store`
(except the public health check) and no `Strict-Transport-Security`, because the portal is served over
plain HTTP: the proxy that adds TLS sends that one.


## Request ids and `/api/ready` (7 October 2026, tracker IN-09)

- One id per request. nginx makes it (`$request_id`, in `web/bff-proxy.inc`), replacing anything the client sent, and writes it in its access log as `rid=`. The BFF uses it as Fastify's request id: it is `reqId` on every BFF log line of the request, the `X-Request-Id` header of the reply (the live stream's too), and `requestId` in the body of every error. To follow a failure, ask for the `requestId` shown in the error and search both logs for it. A request that reaches the BFF some other way keeps a sent id only if it is 8 to 64 letters, digits, `.`, `_` or `-`, and gets a new one otherwise, so a caller cannot choose what is written to the log.
- `GET /api/ready` answers `503` while the portal cannot read Zabbix and `200` otherwise, with the same body either way: the check's fields (`ok`, `zabbix`, `zabbixMs`, `model`, `checkedAt`) and the version, start time, build and screen count. It is for a monitor that holds a session or Bearer token, so it is guarded like any route (viewer). `/api/health` stays public and always 200, which is what the container healthcheck reads. Both read one cached check, so polling either costs Zabbix at most one call in 15 s. The model never changes the status.
- Not built: metrics in a collector's format. Nothing here scrapes them, and `/api/ready` carries the counts a person would look at.

## Containers (7 October 2026, SC-21)

Both images run as an unprivileged user and both compose files harden the containers. The BFF runs as `USER node`. The web image is `nginxinc/nginx-unprivileged`, which cannot bind port 80, so nginx listens on 8080 inside the container; the host side of the mapping is unchanged (`127.0.0.1:8081` or `:8082`). Each service has `read_only: true` with a small `tmpfs` for `/tmp` (nginx keeps its pid file and temporary files there, and a proxied report download is buffered there), `cap_drop: ALL`, `no-new-privileges`, a memory and CPU limit (the BFF 2 GiB and 2 CPUs, the web 256 MiB and 1 CPU) and a healthcheck: the BFF fetches `/api/health` and reads the status, the web fetches `/` with `wget`. The base images carry an explicit minor tag and, since 12 October 2026, the digest it pointed at (`node:24.11-alpine@sha256:...`, `nginxinc/nginx-unprivileged:1.28-alpine@sha256:...`); raise one on purpose, tag and digest together, on every Dockerfile line that names the image (§30 shows how to read the digest).

First run, 7 October 2026. Both portals were rebuilt that day, hosted first and then ollama. Checked from outside, with no sign-in: all four containers `healthy` with no restart; the BFFs run as `node` and the web containers as uid 101, each with a read-only root, `cap_drop: ALL` and `no-new-privileges`; the BFF is healthy before the web container starts; both pages load; `/api/health` answers through nginx, which finds the BFF by name; the web log shows requests and no `permission denied`; the BFFs log no warning. **Not checked** because it needs a sign-in: a report download (the buffered path), the live stream staying connected, and the Problems page. Sign in once after any rebuild and open the Dashboard, download one report and open Problems.

Second run, 12 October 2026. Both portals were rebuilt again, the first build on the digest-pinned base images, and the recreate and stop checks that the first run could not make were made: see §30, "Putting it live".

Steps for a rebuild. Save the current image IDs first, for a rollback (`docker tag <id> <name>:rollback-2oct`); build with `BUILD_COMMIT` and `BUILD_TIME` set; then check that both containers are `healthy`, that the page loads on :8081 and :8082, that a report downloads (the buffered path), that the live stream stays connected, and that the web container's log shows requests and no `permission denied`. Every open tab needs a reload and a new sign-in.

Rolling back. The BFF image can go back through compose: `docker tag <name>:rollback-2oct <name>:latest`, then `docker compose up -d --no-build portal-bff`. The web image cannot, because the 7 October compose maps container port 8080 and drops every capability, while the old image runs root nginx on port 80. Start the old image with `docker run` on the compose network instead (`-p 127.0.0.1:8081:80`, with the compose service stopped), or keep a copy of the old compose file beside the old images. The images from before the 12 October rebuild are tagged `rollback-7oct`; they were built for the current compose file, so both services should go back through compose with the same two commands (not tried).
