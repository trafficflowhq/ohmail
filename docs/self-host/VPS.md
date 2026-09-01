# ohmail on a VPS, from nothing

One rented box, one compose file, one domain. This guide assumes nothing but
the ability to open a terminal and paste commands. If you already own a Linux
machine with Docker, start at step 2.

A note on state before you spend an afternoon: the stack pulls prebuilt
images from `ghcr.io/trafficflowhq`. If step 5's pull answers "not found",
that tag's images have not finished publishing — pin `OHMAIL_IMAGE_TAG` to
the previous release, or build them from source; everything else here
stands.

## 1. Get a box

Any small VPS from any provider. What matters:

- 2 GB of memory and 20 GB of disk are comfortable. The stack is seven
  containers, most of them idle most of the time.
- Ports 80 and 443 reachable from the internet (the default on a VPS).
- A recent Ubuntu or Debian is the well-trodden path; anything that runs
  Docker works.
- **x86_64 or arm64, either one.** Every image in the stack is published for
  both, so an Ampere or Graviton instance — usually the cheaper row on the
  price list — runs the same commands with nothing to change; `docker pull`
  reads your architecture out of the image itself. Same for a Raspberry Pi 4
  or 5 or an Asahi Mac if the box in the closet is what you are using
  (`uname -m` prints `x86_64` or `aarch64`; a 32-bit Pi OS is the one thing
  that will not work). Read the arm64 note in
  [README.md](./README.md#where-this-stands) first — from 0.13.3 on those
  images are built AND booted on arm64 hardware every release, earlier ones
  were only built, and nobody has run any of them for a week of real mail.

## 2. Point a domain at it

Pick the address your household will type — `mail.example.com` reads well —
and create a DNS **A record** pointing it at the box's IP address (and an
AAAA record if the box has IPv6). That is all: the stack obtains and renews
its TLS certificate itself once the name resolves to the box.

Browsers require an https origin for the features ohmail uses (secure
cookies, passkeys), and the server refuses to run without one — so a fixed
address of some kind is a prerequisite. A public domain is the simplest, and
if you don't own one, buy a cheap one.

**If you would rather the install were not on the public internet at all**,
you do not need a public domain: a name only your own network resolves works
just as well, and the stack issues its own certificate for it. Read
[Private self-hosting, and ohmail over Tailscale](#private-self-hosting-and-ohmail-over-tailscale)
below, then come back to step 3 — the rest of this guide is unchanged.

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

Open `.env` in an editor. Five values are required; the file documents every
one beside where you type it, and everything not marked required has a
working default. The five:

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
- **`TF_ORGANIZER_INSTALL_ID`** — this install's organizer identity, the name
  its claim carries inside each connected mailbox (`ohmail/_meta`). That claim
  is how every ohmail — this server, the hosted service, a desktop install —
  agrees on who organizes a mailbox, so the name must be unique to this
  install. Generate it once, `echo "ohmail-selfhost:$(openssl rand -hex 6)"`,
  and never change it: a changed name makes the server read its own previous
  claims as a stranger's, and every mailbox waits for another "Organize here".

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

**Your origin is yours.** A self-hosted install serves the application and
nothing else — no ohmail marketing page, no pricing, and none of the
ohmail.app legal pages. `/privacy`, `/imprint`, `/subprocessors` and `/de`
answer 404 on your server, deliberately: those documents describe the Swiss
company that operates ohmail.app, its hosting and its subprocessors, and none
of that is true of a box you run. Your users see your sign-in page at your
address, and the privacy notice your install owes them is yours to write.

## 7. Connect your first mailbox

Sign in and add a mailbox: the address, the IMAP server, and the password.
Plain facts about providers:

- Most providers work with the address and either your password or an "app
  password" — Gmail and several others require an app password for IMAP,
  generated in the provider's own security settings.
- **Microsoft 365 / Exchange Online** signs in with OAuth instead of a
  password, and needs a one-time app registration on the Microsoft side.
  Skip this entirely unless you have such a mailbox. There are two ways in
  and `.env.example` documents both:
  - `MS_OAUTH_*` — **your own registration.** A confidential app with a
    client secret, and a redirect URI pointing at your origin (the block
    gives the exact URL to register, byte for byte).
  - `MS_DEVICE_CLIENT_ID` — **the device-code flow.** A public app with no
    secret and **no redirect URI at all**, which is why it works on a
    hostname Microsoft has never heard of. Connecting shows a short code;
    you enter it at `microsoft.com/devicelogin` on any device, approve the
    sign-in, and Microsoft issues the access straight to your server.
    Nothing about the exchange passes through ohmail.
    Two things to get right: **"Allow public client flows" = Yes** in the
    registration (without it the flow fails and says only
    `unauthorized_client`), and set the variable on **both** the `api` and
    the `organizer` service — the api runs the sign-in, the organizer
    renews the access afterwards, and a refresh token can only be renewed
    by the app that issued it.

  Set either, or neither. With both set the app uses your own registration.
- A mail server on your own LAN needs the probe allowance from step 4.

## 7b. Screener suggestions and reply drafts (optional)

Both are off until you configure a model, and the install works without one:
the Screener still holds first contact, rules still file mail, and search
still works. On **this** stack the only provider wired today is Anthropic,
under your own key — one line in `.env`:

```
ANTHROPIC_API_KEY=sk-ant-…
```

Requests go to Anthropic billed to your account; leave it unset and the AI
surfaces say they are unconfigured rather than failing oddly. Setting an
`OPENAI_API_KEY` here does nothing — OpenAI and a local Ollama are wired into
the desktop app, not into this server stack.
[README.md](./README.md#screener-suggestions-and-reply-drafts) has the full
comparison and the desktop app's options.

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

**One-time, updating an install created before the organizer identity was
required:** newer compose files refuse to start without
`TF_ORGANIZER_INSTALL_ID` in `.env` (the refusal names the variable). Mint
it once and keep it forever:

```sh
echo "TF_ORGANIZER_INSTALL_ID=ohmail-selfhost:$(openssl rand -hex 6)" >> .env
```

It is this install's name in every connected mailbox's `ohmail/_meta`
claim. Older stacks ran under a shared default name; after this update each
already-connected mailbox may ask for one "Organize here" confirmation, and
then stays organized under the install's own name.

## Private self-hosting, and ohmail over Tailscale

Everything above assumes a public domain. It does not have to be. ohmail has
no opinion about your hostname and needs nothing inbound from the internet,
so the whole install can live on a private network — a Tailscale tailnet, a
WireGuard network, or a LAN with its own DNS — reachable only by your own
devices.

Two things change. Nothing else in this guide does.

### 1. The address, and the certificate for it

Put the private name in `OHMAIL_ORIGIN` and set `OHMAIL_TLS_INTERNAL=1`:

```
OHMAIL_ORIGIN=https://ohmail.your-tailnet.ts.net
OHMAIL_TLS_INTERNAL=1
```

**Do not leave `OHMAIL_TLS_INTERNAL` empty on a private name.** Without it
Caddy treats the name like a public domain, asks Let's Encrypt for a
certificate it can never issue, and retries for thirty days while your site
serves no TLS at all. With it, Caddy issues the certificate from its own CA
on the box — no public certificate authority is contacted, and nothing about
the install is announced anywhere.

Then install that CA on every machine that opens the app:

```sh
docker compose exec proxy cat /data/caddy/pki/authorities/local/root.crt > ohmail-local-ca.crt
```

- **Debian/Ubuntu:** copy to `/usr/local/share/ca-certificates/` and run
  `sudo update-ca-certificates`.
- **Arch:** `sudo trust anchor ohmail-local-ca.crt`.
- **macOS:** Keychain Access → System → drag the file in → set it to
  "Always Trust".
- **Windows:** import into "Trusted Root Certification Authorities".
- **iOS/Android:** mail the file to yourself and open it; iOS additionally
  needs Settings → General → About → Certificate Trust Settings.

The certificate the server presents is short-lived and renewed
automatically. The **root** is the durable thing — it is valid for years, and
installing it once is the whole ceremony. Never copy the server certificate
itself to a client; copy the root.

A command-line client that reads Node's trust store — the desktop app in
self-host mode among them — takes the same file through `NODE_EXTRA_CA_CERTS`:

```sh
NODE_EXTRA_CA_CERTS=/path/to/ohmail-local-ca.crt <command>
```

That variable is read **once, when the process starts**. Exporting it from
inside a running program has no effect, and the failure it produces —
`UNABLE_TO_GET_ISSUER_CERT_LOCALLY` — looks like a broken certificate rather
than a mis-set variable.

### 2. Bind the proxy to the private interface

This step is the difference between "private" and "private in intent", and
it is the one the compose file does not do for you.

As shipped, the proxy publishes `80:80` and `443:443`, which binds **every
interface on the box**. On a rented VPS that includes its public IP — so an
install you think of as tailnet-only is answering the internet on port 443,
regardless of what its hostname is or who can resolve it.

Find the address your private network gave the box (`tailscale ip -4`, or
`ip -4 addr show tailscale0`) and pin the publish to it in
`docker-compose.yml`, under the `proxy` service:

```yaml
    ports:
      - "100.x.y.z:80:80"
      - "100.x.y.z:443:443"
```

Recreate the proxy and check:

```sh
docker compose up -d --force-recreate proxy
ss -tlnH | awk '{print $4}' | grep -E ':(80|443)$'
```

Every line should carry the private address. If any line reads `0.0.0.0:443`
or `[::]:443`, the install is still listening on the public interface. A
firewall that drops 80/443 on the public interface achieves the same thing
and is worth having as well, but the bind is the part that cannot be
misconfigured open.

### What needs no inbound connection, and why

Worth stating plainly, because it is the usual reason people assume a
private install cannot work:

- **Nothing reaches the box from outside your network.** The organizer makes
  outbound IMAP and SMTP connections to your mail provider. No provider, and
  no ohmail server, ever connects in.
- **Microsoft 365 / Exchange signs in with the device-code flow**
  (`MS_DEVICE_CLIENT_ID`, step 7). It has no redirect URI at all, which is
  exactly why it works on a hostname Microsoft has never heard of. You are
  shown a code, you enter it at `microsoft.com/devicelogin`, and Microsoft
  issues the access straight to your server over its outbound connection.
  The `MS_OAUTH_*` alternative does need a redirect URI reachable by the
  browser — which on a tailnet means reachable by *your* browser, not by
  Microsoft — but the device-code flow avoids the question entirely and is
  the one to use here.
- **Your session cookie does not care what the hostname is.** It is issued
  host-only, with no `Domain` attribute, so a private name is treated
  exactly like a public one.

### Tailscale specifically

Install Tailscale on the box and join your tailnet:

```sh
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --hostname ohmail
tailscale ip -4          # the 100.x.y.z address to bind to, above
```

With MagicDNS on, the box is `ohmail.<your-tailnet>.ts.net` from every
device you own, and that is the name to put in `OHMAIL_ORIGIN`. Install the
CA on each device as above and you are done: browser, desktop app in
self-host mode, and the phone all reach the same origin.

**Phone pairing works unchanged** — the pairing token and its QR are minted
by your own server, and the phone scans them while on the tailnet.

**On `tailscale cert`.** Tailscale can issue a *publicly trusted* certificate
for your `ts.net` name (`tailscale cert ohmail.<tailnet>.ts.net`), which
would remove the CA-installation step entirely. **The stack cannot use it
today**: the proxy takes its certificate either from its own CA or from ACME,
and there is no supported way to hand it a certificate file. Putting
`tailscale serve` in front does not help either, because the same
`OHMAIL_ORIGIN` value is both the address the proxy serves on and the origin
the application announces, so it cannot be told to serve plain HTTP behind
something else. Until that changes, `OHMAIL_TLS_INTERNAL=1` plus the CA
install is the supported private-network path, and it is the one described
above.

### What was verified, and what was not

Measured on a real stack, on a private hostname with no public DNS record:
the local-CA certificate is issued with no ACME request of any kind; the
first-run setup token, account creation, second factor and recovery codes all
complete over the private origin; session cookies are issued host-only; and
the phone-pairing grant is minted. The interface-scoped bind was verified to
serve on the private address and nowhere else.

Not verified here, because it needs a Tailscale account: `tailscale up`
against a real tailnet, MagicDNS resolution of the `ts.net` name from a
second device, and `tailscale cert`. Those are Tailscale's own behaviour
rather than ohmail's, and the ohmail side of the boundary — a hostname it has
never seen, a certificate from a CA you control, and no inbound connection —
is what was tested.

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
