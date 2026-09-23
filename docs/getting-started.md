# Getting Started

The shortest path from a clone to a working portal. The full environment reference is in
[`../README.md`](../README.md) § Configuration: this page does not repeat it.

## Prerequisites

* **Node.js 20+** and npm
* **Docker + Docker Compose**, for the deployment route
* **A reachable Zabbix 7.0** and a read-only API token for it
* **A model endpoint**, only if you want the plain-language layer: an Anthropic API key in
  `hcml-portal`, a running Ollama with `qwen3:8b` in `hcml-portal-ollama`. Everything else works
  without it.

## 1. A Zabbix token

In Zabbix: *Users → Roles* → a read-only role; *Users → Users* → a user with it, scoped to the host
groups the portal should see; *Users → API tokens* → generate and copy.

Smoke-test it before going further, most first-run problems are the token:

```bash
curl -s http://localhost:8080/api_jsonrpc.php \
  -H 'Content-Type: application/json-rpc' \
  -H 'Authorization: Bearer <TOKEN>' \
  -d '{"jsonrpc":"2.0","method":"host.get","params":{"output":["hostid","name"],"limit":3},"id":1}'
```

A JSON `result` array means you are ready. An `error` about permissions means the role is too narrow.

**Leave `ZABBIX_WRITE_TOKEN` unset** unless you want the acknowledge button. Without it the portal is
provably read-only and `/api/health` reports `writeBack: false` so the UI hides the control.
[ADR-0006](architecture/adr/0006-read-only-with-one-write.md).

## 2. Run it, two processes

```bash
cd server && cp .env.example .env    # then set ZBX_URL and ZABBIX_API_TOKEN
npm install && npm run dev           # BFF on :4000

cd ../web
npm install && npm run dev           # Vite on :5173, proxying /api to :4000
```

Check the BFF before opening the browser:

```bash
curl -s localhost:4000/api/health
# {"ok":true,"ts":…,"ai":false,"writeBack":false,"defaults":{…}}
```

`ok: true` with `ai: false` is a correct, complete portal without the plain-language layer.

## 3. Or run it in Docker

```bash
cp .env.example .env                 # then set ZBX_URL and ZABBIX_API_TOKEN
docker compose up -d --build         # hcml-portal → :8081 · hcml-portal-ollama → :8082
curl -s localhost:8081/bff/api/health   # :8082 in the ollama copy
```

`ZBX_URL` must be reachable **from inside the container**: on Docker Desktop that usually means
`http://host.docker.internal:8080/api_jsonrpc.php`, not `localhost`.

## 4. Signing in

With `AUTH_ENABLED=false` (the `server/.env` default) there is no login and every caller is treated as
`admin`. With it on you need `PORTAL_USER`/`PORTAL_PASS`, or `PORTAL_USERS` as comma-separated
`name:password:role` triples.

**Turning auth on also requires a real `JWT_SECRET`**: the BFF refuses to boot on the built-in
placeholder. Generate one with `openssl rand -hex 32`, and use a **different** secret per portal: the
token carries no audience claim, so one portal's session is otherwise accepted by the other.

## Checks you can run

```bash
cd server
npm test                                  # 336 tests, 19 files
npm run typecheck
npx tsx scripts/openapi.check.ts          # the API contract matches the code
npx tsx scripts/erd.check.ts              # the database ERD matches its .erd model
npx tsx scripts/validate-sli.ts           # the derived SLA against HCML's published reports

cd ../web
npm run typecheck
npx tsx scripts/markdown.check.ts
npx tsx scripts/units.check.ts
node scripts/css.check.mjs
```

All of them add **zero dependencies**: they are standalone scripts, not a second test runner.
`validate-sli.ts` needs HCML's Availability Report spreadsheets in `~/Downloads` and will skip
politely without them.

## When it does not work

| Symptom | Cause |
|---|---|
| `503 zabbix_auth` | Zabbix rejected the API token. Re-run the curl in step 1 |
| `503 zabbix_timeout` | Zabbix did not answer within `ZABBIX_TIMEOUT_MS`, default 10 s |
| `502 zabbix_error` | Unreachable, non-2xx, or a JSON-RPC error. Check `ZBX_URL` first |
| `401 unauthorized` | The **portal** JWT, not the Zabbix token. Sign in again |
| BFF will not start, complains about the secret | `AUTH_ENABLED=true` with the placeholder `JWT_SECRET` |
| Pages load but every panel is empty | The token's role cannot see the host groups |

Full status-code semantics, including why nothing ever returns 504, are in
[`api/openapi.yaml`](api/openapi.yaml).

## Next

* [`index.md`](index.md), what else is documented and where
* [`architecture/adr/0001-bff-over-zabbix-api.md`](architecture/adr/0001-bff-over-zabbix-api.md), why there is a portal at all
* [`../setup.md`](../setup.md) §12: the recipe for adding a Zabbix-backed view
