# Backing up and restoring the portal

The portal keeps no estate data, but it does keep its settings, and nothing else holds a copy of
them. They are in the `.env` files. Git ignores those files on purpose, because they hold passwords
and tokens, so a clone of the repository does not bring them back. This page says what to keep, how
to keep it, and how to start again from it. It corrects an older claim in
[`../index.md`](../index.md) and [ADR-0003](../architecture/adr/0003-no-database.md) that there is
"nothing to back up" (ayoyo_1.1 IN-24).

## What the portal keeps

| What | Where | In git? | What to do |
|---|---|---|---|
| The users and their roles, the Zabbix read and write tokens, the model key, `JWT_SECRET`, and the SLA and site settings | `.env` in the repository root, which `docker compose` reads | No, ignored | Keep an encrypted copy (below) |
| The same, for a development run | `server/.env`, which `npm run dev` reads | No, ignored | An encrypted copy too, if you use it: it holds a Zabbix token |
| The names of the settings, with no real value | `.env.example` in the root and in `server/` | Yes | Nothing: templates, which must never hold a real value |
| The non-secret settings and their defaults | [`deploy/settings.example`](../../deploy/settings.example) | Yes | Nothing: already versioned |
| Hosts, problems, history, the figures behind the SLA | Zabbix's own database | Not here | Zabbix's own backup. The portal only reads it |
| Cached answers | The BFF's memory | No | Nothing: rebuilt on demand, and gone on every restart |

`docker-compose.yml` declares no volumes, so there is no portal data folder to copy. Each copy of
the portal has its own `.env` files, and each needs its own backup. `hcml-portal-ollama` is not
under git at all (checked 7 October 2026: there is no `.git` folder in it), so its compose file, its
documents and its `.env.example` files are not versioned either. Copy that whole folder, leaving out
`node_modules` and `dist`.

## Keep an encrypted copy

Make a new copy after every change to a user, a role, a token, `JWT_SECRET` or a setting. An old copy
that holds a user's old password is a copy that restores the wrong thing.

```bash
# From the repository root. Each command asks for a passphrase twice.
# Write outside the repository folder: git does not ignore a file named .env.enc or .env.gpg.
mkdir -p ~/hcml-backup
openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt -in .env \
  -out ~/hcml-backup/hcml-portal.env.$(date +%F).enc
openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt -in server/.env \
  -out ~/hcml-backup/hcml-portal.server-env.$(date +%F).enc
```

In `hcml-portal-ollama`, use `hcml-portal-ollama` in the file names so the two never mix.

Then:

- Copy the encrypted files off this computer: a second machine, or a drive kept somewhere else.
  A backup on the laptop is lost with the laptop.
- Keep the passphrase somewhere else, such as a password manager. A passphrase written beside
  the file is no protection.
- Check a copy opens, without writing the plain file to disk or showing it. This prints the
  number of lines in it, and `bad decrypt` means a wrong passphrase or a damaged file:
  `openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -in ~/hcml-backup/hcml-portal.env.2026-10-07.enc | wc -l`
- Never send the plain file by email or chat, and never commit it. `.env.example` is the only
  file with this kind of name that git should hold, and it must never hold a real value.

`gpg --symmetric --cipher-algo AES256` does the same job, as does a password manager that stores
files, or an encrypted disk image. What matters is that the copy is encrypted and is not on the same
machine.

## Restore checklist

1. **Get the code.** `git clone` for `hcml-portal`. For `hcml-portal-ollama`, restore the folder you
   copied.
2. **Put the files back and lock them.** From the repository root:
   ```bash
   openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -in ~/hcml-backup/hcml-portal.env.2026-10-07.enc -out .env
   chmod 600 .env
   ```
   Do the same for `server/.env` if you use a development run.
3. **Compare the names.** Open `.env.example` beside `.env`: a setting named in one and missing from
   the other is a question to answer. Then read [`deploy/settings.example`](../../deploy/settings.example)
   for the non-secret settings and their defaults, and check that the values you changed from them
   are still in `.env`.
4. **Check that compose accepts it.** `docker compose config --quiet` prints nothing when all is
   well. It stops with an error naming `JWT_SECRET` when the signing secret is missing.
5. **Start it.** `docker compose up -d --build`.
6. **Check it is up.** `curl localhost:8081/bff/api/health` (8082 for `hcml-portal-ollama`) answers
   `"ok":true` when the BFF is running. `docker compose logs portal-bff` shows why, in plain words,
   if the BFF refused to start: a placeholder `JWT_SECRET`, or a user with an empty password.
7. **Sign in as each user once.** A mistake in `PORTAL_USERS` shows here. Then, in a tab that is
   signed in, open `/bff/api/health` on the same address: `ready.ok` is `true` when Zabbix accepted
   the token. Only a signed-in caller is shown `ready`, so the `curl` above cannot see it. Do not
   press Acknowledge as a test: it writes to the production Zabbix.
8. **Open the SLA page for a past month.** The first request after a start rebuilds the figures from
   Zabbix and takes a while.
9. **Make a fresh encrypted copy** if you changed anything while restoring.

Run steps 1 to 6 once into an empty folder before you need them. A restore that has never been tried
is a guess.

## If there is no copy

Nothing in `.env` can be read back from the portal. All of it can be made again:

- `JWT_SECRET`: a new value, for example from `openssl rand -hex 32`. Every signed-in session
  ends, which is the only cost.
- The Zabbix tokens: a Zabbix administrator makes them again (*Users → API tokens*): a read-only
  one for `ZABBIX_API_TOKEN`, and a separate one for `ZABBIX_WRITE_TOKEN` if acknowledge and close
  should work. Leave the write token blank to keep the portal strictly read-only. If the loss may
  have been a leak, delete the old tokens in Zabbix as well.
- The users: `PORTAL_USERS` as `name:password:role` triples. Choose new passwords and tell the
  people. A password may be stored as a hash instead of plain text (`server/scripts/hash-password.ts`),
  which keeps the plain password out of the backup.
- The model key: a new one from the provider, for the hosted copy. The local copy needs none.
- The other settings: the defaults are in [`deploy/settings.example`](../../deploy/settings.example).
  Anything HCML had changed from them, such as the site settings, the trigger names behind the SLA
  or `NET_GROUP_IDS`, has to be remembered or worked out again. That is why the encrypted copy is
  worth more than the settings file.

## What this does not cover

Zabbix's own database and its backup. The Docker images, which are rebuilt from the code. And, if
you add a TLS proxy ([`tls.md`](tls.md)), its certificate store: Caddy and Traefik keep one, and the
certificates can be issued again. On a development laptop that runs the restored Zabbix stack, the `.env` beside
its `docker-compose.yml` holds the two MySQL passwords (since 12 October 2026) and needs the same care.
