# API documentation

[`openapi.yaml`](openapi.yaml) is the contract for the BFF: **41 endpoints**, 38 GET and 3 POST:
with every query parameter, both security schemes, every status code and every response schema.

It was written by reading `server/src`, not by transcribing the endpoint table in `setup.md` §5. That
table is a useful reading aid and it has drifted twice; this file is checked.

## Viewing it without installing anything

**Paste it in.** [editor.swagger.io](https://editor.swagger.io) validates and renders it in the
browser. Nothing is uploaded to a server, it runs client-side, but it is still HCML-shaped
documentation, so use judgement.

**Or render it locally**, no install, no dependency. Save this next to `openapi.yaml` as `view.html`
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

**Or read it as text.** It is written to be readable unrendered; the descriptions carry the caveats
that matter more than the schemas do.

## Keeping it honest

```bash
cd server && npx tsx scripts/openapi.check.ts
```

Zero dependencies. It extracts every `app.get(`/`app.post(` from `server/src`, extracts every path key
from the spec, and fails if either side has one the other lacks, or if the spec lists a path twice.
It self-tests against fixtures before reading a real file, so a broken checker fails loudly instead of
passing everything.

Expected output:

```
openapi.check: 41 endpoints (38 GET + 3 POST) — all documented, none extra.
```

**Run it after adding a route, and after editing the spec.** It is the reason this document will not
become the next stale endpoint table.

One formatting contract it depends on: inside the `paths:` block, a path key is a two-space-indented
line ending in a colon. Keep that shape, or teach the checker the new one.

## Things the spec says that are easy to get wrong

- **Two security schemes.** `Authorization: Bearer` *and* `?token=`. The query form exists because
  `EventSource` cannot set headers, but it is accepted on **every** guarded path, not only the SSE ones.
- **Two different rejected tokens.** A bad portal JWT is `401 unauthorized`. A bad Zabbix API token is
  `503 zabbix_auth`.
- **Nothing ever returns 504.** A Zabbix timeout is `503 zabbix_timeout`; only `zabbix_error` is 502.
- **Four report paths can answer 200 with stale data of any age** on an upstream failure, because they
  are served with `staleIfError`. A client cannot tell from the status code.
- **Two endpoints are not JSON at all**: `GET /api/stream` and `POST /api/chat` are `text/event-stream`.
  Their event names and frame payloads are in the operation descriptions.
