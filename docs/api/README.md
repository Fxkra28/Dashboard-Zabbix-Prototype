# API documentation

[`openapi.yaml`](openapi.yaml) is the contract for the BFF: 41 endpoints (36 GET and 5 POST), with
every query parameter, both security schemes, every status code and every response schema.
Fastify's own client errors can come back from any POST and are not repeated per route: 400
`fst_err_ctp_invalid_json_body` for malformed JSON, and 415 for a content type Fastify has no
parser for (anything but JSON and plain text).

It was written by reading `server/src`, not by transcribing the endpoint table in `setup.md` §5. That
table is a useful reading aid and it has drifted twice; this file is checked.

## Viewing it without installing anything

Paste it in. [editor.swagger.io](https://editor.swagger.io) validates and renders it in the
browser. Nothing is uploaded to a server, it runs client-side, but it is still HCML-shaped
documentation, so use judgement.

Or render it locally, no install, no dependency. Save this next to `openapi.yaml` as `view.html`
and open it:

```html
<!doctype html>
<html>
  <head><meta charset="utf-8"><title>HCML Portal API</title></head>
  <body>
    <redoc spec-url="openapi.yaml"></redoc>
    <script src="https://cdn.jsdelivr.net/npm/redoc/bundles/redoc.standalone.js"></script>
  </body>
</html>
```

Then `npx serve .` or any static server, `file://` will not work, because the spec is fetched.

Or read it as text. It is written to be readable unrendered; the descriptions carry the caveats
that matter more than the schemas do.

## Keeping it honest

```bash
npm run check:api    # at the repository root; the same as ./server/node_modules/.bin/tsx tools/check/openapi.check.ts
```

Zero dependencies. It extracts every `app.get(`/`app.post(` from `server/src`, extracts every path key
from the spec, and fails if either side has one the other lacks, or if the spec lists a path twice.
It self-tests against fixtures before reading a real file, so a broken checker fails loudly instead of
passing everything.

Expected output:

```
openapi.check: 41 endpoints (36 GET + 5 POST), all documented, none extra.
```

**Run it after adding a route, and after editing the spec.** It is the reason this document will not
become the next stale endpoint table.

One formatting contract it depends on: inside the `paths:` block, a path key is a two-space-indented
line ending in a colon. Keep that shape, or teach the checker the new one.

## Things the spec says that are easy to get wrong

- Two security schemes. The session cookie, which the browser sends (`hcml_session` by default;
  the ollama copy's `docker-compose.yml` names it `hcml_session_ollama`, since cookies ignore ports), *and*
  `Authorization: Bearer`, for scripts. The header wins when both arrive. No route takes `?token=`
  any more, the live stream included: `EventSource` sends the cookie
  ([ADR-0010](../architecture/adr/0010-session-cookie.md)).
- A cookie POST needs `X-HCML-CSRF: 1`. Every POST that authenticates with the cookie, and every
  sign-in and sign-out, is refused with `403 csrf` without it, or when its `Origin` names another
  host. A Bearer request needs neither, except to sign in or out.
- Sign-in returns no token. `POST /api/auth/login` and `POST /api/auth/refresh` answer
  `{ user, expiresIn }` and set the cookie. A script takes the token from `Set-Cookie`. `expiresIn` is the
  session length in seconds: 43200 at the default 12 hours (`SESSION_HOURS`).
- Two different rejected tokens. A bad portal JWT is `401 unauthorized`. A bad Zabbix API token is
  `503 zabbix_auth`.
- Nothing ever returns 504. A Zabbix timeout is `503 zabbix_timeout`; only `zabbix_error` is 502.
- The slow report paths can answer 200 with an old copy, of any age, on an upstream failure,
  because they are served with `staleIfError`: `/api/reports/availability`, `/api/reports/noise`,
  `/api/reports/capacity` and everything built on the derived monthly SLA (`/api/sli`,
  `/api/sli/export`, `/api/services/derived`, `/api/explain/sla` with `source=derived`). The status
  code does not say so, but `X-Data-Stale: true` and `X-Data-Age-Seconds: <seconds>` do. They are
  absent on a live answer, and the JSON body never changes. The SLA report download is built from the
  same cached figures, so it can be a 200 with a file made from older figures, with the same headers.
- The live stream is capped, not rate limited. `GET /api/stream` answers `429 too_many_streams`
  with `Retry-After: 30` past `STREAM_MAX_CLIENTS` screens in all or `STREAM_MAX_PER_USER` for one
  user, and it ends when the session token expires.
- `GET /api/health` is public, and tells a signed-in caller more. Anyone gets `ok`, `ts`, `ai`,
  `aiProvider`, `aiExternal`, `writeBack` and `defaults`. A request with a valid session also gets
  `version`, `startedAt`, `build`, `ready` (does Zabbix answer, and the model) and `streams`. A bad or
  expired token is not a 401 here: it gets the public reply. The status stays 200 when Zabbix is
  down: read `ready.ok`. With sign-in off every caller counts as signed in, as for `/api/auth/me`.
  `writeBack` is false when sign-in is off and `ALLOW_WRITE_WITHOUT_AUTH` is not `true`, since
  acknowledge would be refused.
- Three endpoints are not JSON at all: `GET /api/stream` and `POST /api/chat` are
  `text/event-stream`, and their event names and frame payloads are in the operation descriptions.
  `GET /api/sli/export` answers a PDF or an Excel file. It needs `format=pdf` or `format=xlsx` (there
  is no default), takes no other parameter than `month` (any other is a 400), is never compressed, and carries `Cache-Control: private, no-store`.
