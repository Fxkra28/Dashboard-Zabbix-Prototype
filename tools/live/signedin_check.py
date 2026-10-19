"""Signed-in checks of a running portal through nginx (tracker.md SC-21, IN-01).

    PORTAL_USER=... PORTAL_PASSWORD=... python3 -I signedin_check.py http://localhost:8081 [--stream-seconds 80]

Read-only: only GETs after the sign-in. The cookie and the password are never printed or written.
Downloaded reports are checked in memory and dropped; their contents are not printed.
"""
import http.cookiejar
import io
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
import zipfile

base = sys.argv[1].rstrip('/')
secs = int(sys.argv[sys.argv.index('--stream-seconds') + 1]) if '--stream-seconds' in sys.argv else 80
user, pw = os.environ['PORTAL_USER'], os.environ['PORTAL_PASSWORD']

jar = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))


def call(method, path, body=None, headers=None, timeout=90):
    req = urllib.request.Request(base + path, data=body, method=method, headers=headers or {})
    t0 = time.time()
    try:
        resp = opener.open(req, timeout=timeout)
    except urllib.error.HTTPError as err:
        resp = err
    return resp, time.time() - t0


def line(label, ok, detail=''):
    print(f"{'PASS' if ok else 'FAIL'}  {label}" + (f"  ({detail})" if detail else ''), flush=True)
    return ok


results = []

# 1. Sign in. The cookie jar keeps the session; a Secure cookie would not be sent over plain http.
resp, dt = call('POST', '/bff/api/auth/login', json.dumps({'username': user, 'password': pw}).encode(),
                {'Content-Type': 'application/json', 'X-HCML-CSRF': '1'})
body = resp.read()
results.append(line('sign-in through nginx', resp.status == 200, f'HTTP {resp.status}, {dt:.2f}s'))
if resp.status != 200:
    print('Stopping: not signed in. Not retrying.')
    sys.exit(1)
for c in jar:
    c.secure = False
print('      cookie set:', sorted({c.name for c in jar}), 'httponly:', all(c.has_nonstandard_attr('HttpOnly') for c in jar))

# 2. Signed-in /api/health and /api/ready.
resp, dt = call('GET', '/bff/api/health')
health = json.loads(resp.read() or b'{}')
results.append(line('signed-in /api/health', resp.status == 200 and health.get('ok') is True, f'HTTP {resp.status}'))
print('      keys:', sorted(health.keys()))
for k in ('build', 'version', 'commit', 'builtAt', 'ready', 'model', 'aiProvider', 'aiExternal', 'writeBack'):
    if k in health:
        print(f'      {k}:', json.dumps(health[k])[:160])
print('      x-request-id header:', bool(resp.headers.get('x-request-id')))

resp, dt = call('GET', '/bff/api/ready')
ready_body = resp.read()
results.append(line('signed-in /api/ready', resp.status in (200, 503), f'HTTP {resp.status}, {dt:.2f}s'))
print('      body:', ready_body[:300].decode('utf8', 'replace'))

# 3. Report downloads through nginx's buffer (closed month, both formats).
month = '2026-09'
for fmt in ('pdf', 'xlsx'):
    resp, dt = call('GET', f'/bff/api/sli/export?month={month}&format={fmt}', timeout=190)
    data = resp.read()
    clen = resp.headers.get('Content-Length')
    disp = resp.headers.get('Content-Disposition') or ''
    ok = resp.status == 200 and len(data) > 1000 and (clen is None or int(clen) == len(data))
    if fmt == 'pdf':
        ok = ok and data.startswith(b'%PDF-') and b'%%EOF' in data[-1100:]
        pages = len(re.findall(rb'/Type\s*/Page[^s]', data))
        extra = f'pages~{pages}'
    else:
        try:
            zf = zipfile.ZipFile(io.BytesIO(data))
            bad = zf.testzip()
            names = zf.namelist()
            sheets = re.findall(r'<sheet [^>]*name="([^"]+)"', zf.read('xl/workbook.xml').decode('utf8', 'replace'))
            ok = ok and bad is None and 'xl/workbook.xml' in names
            extra = f'zip ok={bad is None}, sheets={sheets}'
        except Exception as exc:  # a truncated file is the failure this is looking for
            ok, extra = False, f'not a valid workbook: {type(exc).__name__}'
    results.append(line(f'{fmt} report through nginx', ok,
                        f'HTTP {resp.status}, {len(data)} bytes, Content-Length {clen}, {dt:.1f}s, {extra}'))
    print('      content-type:', resp.headers.get('Content-Type'), '| disposition ok:', 'attachment' in disp,
          '| x-request-id:', bool(resp.headers.get('x-request-id')))
    del data

# 4. The live stream stays connected through nginx for `secs` seconds.
resp, _ = call('GET', '/bff/api/stream', headers={'Accept': 'text/event-stream'}, timeout=15)
t0 = time.time()
events, sizes, pings, closed_early = {}, [], 0, False
last_data = last_any = t0
try:
    resp.fp.raw._sock.settimeout(5)
except Exception:
    pass
while time.time() - t0 < secs:
    try:
        raw = resp.fp.readline()
    except Exception:
        continue  # a read timeout while idle is normal
    if raw == b'':
        closed_early = True
        break
    last_any = time.time()
    text = raw.decode('utf8', 'replace').rstrip('\n')
    if text.startswith('event:'):
        name = text.split(':', 1)[1].strip()
        events[name] = events.get(name, 0) + 1
    elif text.startswith('data:'):
        sizes.append(len(text))
        last_data = time.time()
    elif text.startswith(':'):
        pings += 1
held = time.time() - t0
results.append(line('live stream stays connected', resp.status == 200 and not closed_early and sizes != [],
                    f'HTTP {resp.status}, held {held:.0f}s of {secs}s, data frames {len(sizes)}, '
                    f'pings {pings}, events {events}, largest frame {max(sizes) if sizes else 0} bytes'))
print('      content-type:', resp.headers.get('Content-Type'), '| x-request-id:', bool(resp.headers.get('x-request-id')))
resp.close()

# 5. Problems list, the page that was not exercised.
resp, dt = call('GET', '/bff/api/problems?limit=5')
pb = resp.read()
results.append(line('problems list', resp.status == 200, f'HTTP {resp.status}, {len(pb)} bytes, {dt:.2f}s'))

print(f"\n{sum(results)} of {len(results)} checks passed")
