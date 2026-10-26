# After a restart: what comes back, in what order, and how to look

The portals read HCML's Zabbix, and on this laptop that Zabbix is two containers of a compose project
that lives outside this repository (`Proto1/docker-compose.yml`). A restart of Docker or of the Mac used
to bring the portals back and leave their data source down, so they came back reading nothing. Since 22
October 2026 (tracker IN-27) both come back together.

## What comes back by itself

| Container | Restart policy | Why |
|---|---|---|
| `proto1-mysql-1`, the Zabbix database | `unless-stopped` | Everything the portals show is read from it, through the frontend |
| `proto1-zabbix-web-1`, the Zabbix frontend | `unless-stopped` | It serves `api_jsonrpc.php` on `127.0.0.1:8080`, the address both BFFs read |
| `proto1-zabbix-server-1`, the poller | `no` | Down on purpose ([ADR-0008](../architecture/adr/0008-stop-local-polling.md)): started, it would poll HCML's real devices from this laptop and run housekeeping on the restored data. It is behind the `poller` profile and nothing here changes that |
| The two containers of each portal | `unless-stopped` | Set when the containers were hardened (setup §23) |

`unless-stopped` means that a container someone stopped by hand stays stopped when Docker restarts. To
undo the change on one container: `docker update --restart no <name>`.

## What has to be true first

Docker itself has to start. On a Mac that is Docker Desktop's setting "Start Docker Desktop when you
sign in", and the Mac has to be signed in. Without it nothing comes back, the portals included. This
repository cannot read or set it.

## The order, and what a restart policy does not do

MySQL first, then the Zabbix frontend, then the portals. A restart policy does not order containers
across compose projects, so for about a minute after a restart the frontend may show a database error,
and a BFF may say that Zabbix cannot be read. Both settle without anyone doing anything: the frontend
waits for MySQL to be healthy, and the portals read again after their cache lifetimes.

## Looking after it

```bash
docker ps --format '{{.Names}}  {{.Status}}'      # six containers, every one healthy
curl -s -X POST http://127.0.0.1:8080/api_jsonrpc.php -H 'Content-Type: application/json-rpc' \
  -d '{"jsonrpc":"2.0","method":"apiinfo.version","params":[],"id":1}'       # the Zabbix version, 7.0.x
curl -s http://127.0.0.1:8081/bff/api/health       # {"ok":true,...}; :8082 for hcml-portal-ollama
```

If the first shows a container that is not healthy, `docker logs <name>` says why. If the second
answers and a portal's Dashboard still says that Zabbix cannot be read, wait a minute and reload: the
page `/api/ready` of a signed-in session says whether the BFF can read Zabbix now. After a hard power
loss MySQL recovers its log before it answers, which can take longer than a minute (`docker logs
proto1-mysql-1`); the compose file flushes that log once a second, so up to a second of writes can be
lost, which on a copy of data that no longer changes does not matter.

## How it was applied, and what was not tried

On 22 October 2026, with `docker update --restart unless-stopped proto1-mysql-1 proto1-zabbix-web-1`,
which changes the policy of a running container without restarting it (their start times did not
change), and the same `restart: unless-stopped` line under `mysql` and `zabbix-web` in the compose
file, so that the next `docker compose up` keeps it. That next `up` recreates the two containers once,
because their configuration changed, and MySQL takes about a minute to stop (its grace period is 120
seconds) and to start. The file as it was is beside it as `docker-compose.yml.before-in27`.

Tried on 26 October 2026. The Mac had restarted at about 06:57, and Docker Desktop had not started by
itself, so `docker ps` could not reach the daemon and ports 8080, 8081 and 8082 answered nothing. After
Docker Desktop was opened at 07:16, `proto1-mysql-1`, `proto1-zabbix-web-1` and the four portal
containers were running and healthy within 11 seconds of the engine coming up, and
`proto1-zabbix-server-1` stayed exited. So the policies in the table above work.

Not tried: whether Docker Desktop starts by itself at login. It had not started in the 18 minutes between
the boot and this test, so its setting "Start Docker Desktop when you sign in" is probably off; this
repository cannot read or set it. `docker inspect` shows the policy on both containers, and
`docker compose config` shows that the two lines are the only change to the resolved configuration.
