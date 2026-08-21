# ohmail on a VPS, from nothing

One rented box, one compose file, one domain. This guide assumes nothing but
the ability to open a terminal and paste commands. If you already own a Linux
machine with Docker, start at step 2.

A note on state before you spend an afternoon: the stack pulls prebuilt
images from `ghcr.io/trafficflowhq`. If step 5's pull answers "not found",
those images have not been published yet — everything else here is real, but
you cannot finish until they are.

## 1. Get a box

Any small VPS from any provider. What matters:

- 2 GB of memory and 20 GB of disk are comfortable. The stack is seven
  containers, most of them idle most of the time.
- Ports 80 and 443 reachable from the internet (the default on a VPS).
- A recent Ubuntu or Debian is the well-trodden path; anything that runs
  Docker works.

## 2. Point a domain at it

Pick the address your household will type — `mail.example.com` reads well —
and create a DNS **A record** pointing it at the box's IP address (and an
AAAA record if the box has IPv6). That is all: the stack obtains and renews
its TLS certificate itself once the name resolves to the box.

If you don't own a domain, buy a cheap one; a fixed public address is a
prerequisite, because browsers require an https origin for the features
ohmail uses (secure cookies, passkeys), and the server refuses to run
without one.

## 3. Install Docker

On the box, as root:

```sh
curl -fsSL https://get.docker.com | sh
```

That is Docker's own convenience installer and includes the compose plugin.
Check it: `docker compose version` should print a version, not an error.

## 4. Get the stack and configure it

```sh
git clone https://github.com/trafficflowhq/ohmail
cd ohmail/deploy/selfhost
cp .env.example .env
```

Open `.env` in an editor. Four values are required; the file documents every
one beside where you type it, and everything not marked required has a
working default. The four:

- **`OHMAIL_ORIGIN`** — the address from step 2, scheme and host only:
  `https://mail.example.com`. This value derives the cookie host and the
  passkey identity; changing it later signs everybody out, so pick the name
  you mean to keep.
- **`POSTGRES_PASSWORD`** — the database password. URL-safe characters only.
- **`TF_KEK_V1`** — the key that encrypts mailbox credentials at rest.
  Generate it with `openssl rand -hex 32`. **Copy this value somewhere safe
  now** — a password manager is fine. Losing it means every connected
  mailbox has to be re-entered. See [BACKUP.md](./BACKUP.md).
- **`MINIO_ROOT_PASSWORD`** — the attachment-staging store's credential.
  `openssl rand -hex 24`. It never leaves the box, but pick a real value.

Two optional blocks worth deciding now:

- **Outbound mail.** By default, product mail (address verification,
  new-device notices) lands in a bundled sink — viewable, delivered
  nowhere. Its little web UI listens only on the box itself, so from your
  own computer open a tunnel first, then browse `http://localhost:8025`:

  ```sh
  ssh -L 8025:127.0.0.1:8025 root@mail.example.com
  ```

  To deliver for real, set `SMTP_URL` to a relay you have and `MAIL_FROM`
  to the sender address — **both together**: with only one of them set,
  the other keeps its bundled default, and mail would go out from the
  placeholder sender `ohmail@selfhost.example`.
- **Mail server on your own LAN?** If the mailbox you'll connect lives at a
  private address (a NAS, a home mail server), set
  `TF_PROBE_ALLOW_PRIVATE=1` — the add-mailbox connection check refuses
  private-network targets by default. If that server also has no TLS, you
  will additionally confirm the connection-security notice when you add the
  mailbox; plaintext IMAP is never used without that explicit consent.
- **Push distributor on your own LAN?** The mobile app can register a
  UnifiedPush endpoint so this server wakes the phone when mail arrives — a
  signal with no subject, no sender and no count in it. By default the
  endpoint must be `https` and must resolve to a public address, because the
  organizer POSTs to it unattended for as long as the registration lives. If
  your distributor is on the LAN (an `ntfy` beside this server), set
  `TF_PUSH_ALLOW_PRIVATE=1`. It is a **separate** switch from
  `TF_PROBE_ALLOW_PRIVATE` on purpose, and it has to be set on **both** the
  `api` and the `organizer` — the first accepts the registration, the second
  dials it.
- **Want the phone to actually ring?** Generate this install's own VAPID
  keypair:

  ```sh
  node scripts/vapid-keygen.mjs
  ```

  Paste `TF_VAPID_PUBLIC_KEY` and `TF_VAPID_PRIVATE_KEY` into `.env`. The app
  hands the public key to your phone's distributor when it registers, and the
  distributor's connector then renders only wakes signed with the private half
  — so without a keypair a phone can register but nothing it receives will
  wake it. The public key goes to both services; the private key stays on the
  `organizer`, which is the only process that signs.

  Generate your own. Never copy another install's pair — whoever holds a
  private key can send wakes the matching phones accept. `node
  scripts/vapid-keygen.mjs --check` verifies what you set, including whether
  the two halves are really a pair; a mismatch is the one failure nothing else
  reports, because phones register normally and simply never ring.

  Leave both empty and encrypted wakes are off: mail still arrives, the app
  still syncs when you open it, and a raw consumer still gets the plain wake.
  Set them wrong and the organizer sends nothing at all rather than let the
  working half hide the mistake.

## 5. Start it

```sh
docker compose up -d
```

The first start pulls the images, creates the database, and applies the
schema. Watch it settle with `docker compose ps`. What a good boot looks
like, within a couple of minutes:

- `web`, `api`, `organizer`, `db`, `minio` — `running (healthy)`
- `proxy`, `mailpit` — `running` (they carry no health check)
- `minio-init` — gone from `ps`, or `Exited (0)` in `docker compose ps -a`:
  it runs once to create the staging bucket and is supposed to exit.

## 6. Create the first account

The server mints a one-time setup token on first boot and prints it once,
to the API service's log. Reading that log is the proof you control the
box — that is the whole ceremony, and it is why there is no default password
anywhere.

```sh
docker compose logs api
```

Look for the fenced block:

```
──────────────────────────────────────────────────────────────────────
  FIRST-RUN SETUP

  No account exists on this server yet. ...
      <the token>
  ...
──────────────────────────────────────────────────────────────────────
```

The token works once and expires; restarting the API service
(`docker compose restart api`) retires it and prints a fresh one, so a lost
token costs nothing. After a restart the retired block is still in the log
above the new one — read the **newest** block, most conveniently with
`docker compose logs api | tail -40`.

Now open `https://mail.example.com` in a browser. A fresh server greets you
with its setup page ("Set up your ohmail server" — it is also directly at
`/setup`): paste the token, choose your email address, name and password,
and the page creates the first account and walks straight on — a passkey or
an authenticator app, your recovery codes, then your first mailbox. Every
account on the server has a second factor, including yours.

The setup page only exists while the server has no accounts; once yours is
created, the address serves the ordinary sign-in.

## 7. Connect your first mailbox

Sign in and add a mailbox: the address, the IMAP server, and the password.
Plain facts about providers:

- Most providers work with the address and either your password or an "app
  password" — Gmail and several others require an app password for IMAP,
  generated in the provider's own security settings.
- **Microsoft 365 / Exchange Online** signs in with OAuth instead of a
  password and needs a one-time app registration on the Microsoft side. The
  `MS_OAUTH_*` block in `.env.example` documents it, including the exact
  redirect URI to register. Skip this entirely unless you have such a
  mailbox.
- A mail server on your own LAN needs the probe allowance from step 4.

## 8. Your household

The server never opens signup to strangers: the first account came from box
control, and every later account arrives by invitation. Inviting someone
takes a minute and no command line:

1. Open **Settings → Invites** and make an invite link — name who it is for
   if you like.
2. Hand the link over: let them scan the QR with their phone camera, or
   copy the link and send it however you normally reach them. It works
   once and expires after seven days.
3. They open it, choose their email address, name and password, and the
   same guided setup you went through carries them on — second factor,
   recovery codes, their own mailbox.

Each person gets their own account: their own sign-in, their own mail.
The Invites page lists the invites still open and lets you revoke one that
went astray — a revoked or expired link stops working, and you make
a new one. Treat an invite link like a key to the house: send it over a
channel you trust, because opening it is all it takes to claim the account.

## 9. Back it up now, not someday

The short version — [BACKUP.md](./BACKUP.md) has the reasoning, the exact
script, and the restore drill. A five-line script at
`/usr/local/bin/ohmail-backup` (from BACKUP.md — it keeps the dump private
and refuses to leave a good-looking file behind when the dump failed), and
one cron line:

```sh
# /etc/cron.d/ohmail-backup — nightly dump at 03:10, then copy it off the box
10 3 * * * root /usr/local/bin/ohmail-backup
```

Copy the dump **off the box** (scp, rclone, anything) and keep your `.env`
— above all the `TF_KEK_V1` line — somewhere that is not this machine. A
backup on the same disk dies with the disk.

## 10. Updates

Pin a version in `.env` (`OHMAIL_IMAGE_TAG=<released tag>`) rather than
riding `latest`, then updating is:

```sh
docker compose pull && docker compose up -d
```

The server applies any schema changes at boot, before it starts listening.

## External database or storage

The one-box shape above is the default. If your Postgres or S3-compatible
storage lives elsewhere:

- **Postgres:** the API reads `DATABASE_URL` and the organizer reads
  `DATABASE_URL_SESSION` — two names, deliberately, and the bundled compose
  file sets both to the bundled database for you. Pointing at an external
  server means three edits in `docker-compose.yml`: both URL lines to the
  same database (plain connection URLs, no pooler), the bundled `db`
  service removed, and the `db:` entry under the api service's
  `depends_on:` removed with it — compose refuses a dependency on a service
  that no longer exists. Change one URL and not the other and the two
  processes will quietly use different databases.
- **Storage:** the `S3_*` block at the bottom of `.env.example` switches
  the staging store to an existing S3-compatible service. The organizer
  sweeps the same bucket the API mints into, so both read the identical
  block — the compose file already wires that.

## When something looks wrong

- `docker compose ps` — is anything not `healthy`?
- `docker compose logs api` and `docker compose logs organizer` — boot
  refusals name the exact variable to fix.
- `https://mail.example.com/health` — answers only after the schema is
  verified and the key ring loads, so a 200 here means "migrated, keyed,
  serving".
