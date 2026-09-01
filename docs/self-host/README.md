# Run ohmail on your own server

ohmail connects to the mailboxes you already have. It signs in to them over
IMAP, organizes what it finds, and never becomes the place your mail lives —
your mailbox stays the source of truth, and you can stop using ohmail at any
time without moving anything. Running it yourself means the organizing happens
on a machine you own, and your mail credentials sit on hardware you control.

Self-hosting is built for one household: you, your partner, the people you live with.
It is not a multi-tenant hosting kit, and nothing in it meters or bills.

## What you need

- **A machine that stays on.** A small VPS, a home server, or a box in a
  closet. 2 GB of memory and 20 GB of disk are comfortable.
- **An x86_64 or an arm64 machine.** Every image in the stack is published
  for both, so a Raspberry Pi 4 or 5, an Ampere or Graviton instance, or an
  Apple-silicon Mac takes the same commands as an Intel box — `docker pull`
  reads the architecture out of the image and there is nothing to
  configure. (`uname -m` prints `x86_64` or `aarch64`. A 32-bit Pi OS will
  not work at all: there is no 32-bit image — reflash the 64-bit one. A
  Linux distribution using 16 KB memory pages, which is how Asahi runs on
  some Macs, is the one arm64 shape with a known history of trouble for
  prebuilt binaries, and nobody here has tried it.) Read the arm64 note
  under "Where this stands" before you commit a weekend to it.
- **Docker**, with the compose plugin (`docker compose`, not the older
  `docker-compose`).
- **An https address for that machine.** Mail credentials deserve TLS, and
  the browser features ohmail relies on — secure cookies, passkeys — require
  an https origin, so the server refuses to run without one. There are three
  shapes, and only the first needs anything public:
  - **A public domain** pointed at the box with an A record. The stack
    obtains and renews the certificate itself; you only point the name.
  - **A private name your own network resolves** — a `.lan` or `.internal`
    name, or a Tailscale/VPN address. Nothing is exposed to the internet and
    no public certificate authority is involved: the stack issues
    certificates from its own CA, and you install that CA once on the
    machines that open the app. See
    [Private self-hosting, and ohmail over Tailscale](./VPS.md#private-self-hosting-and-ohmail-over-tailscale).
  - **`http://localhost`**, for a same-box test run only.
- **About 20 minutes.**

## Pick your path

| You have                                   | Guide                    |
| ------------------------------------------ | ------------------------ |
| A home-server OS (Umbrel)                  | [UMBREL.md](./UMBREL.md) |
| A VPS you rent, or plan to                 | [VPS.md](./VPS.md)       |
| Your own Linux box with Docker on it       | [VPS.md](./VPS.md) — skip step 1 |

Whichever path you take, read [BACKUP.md](./BACKUP.md) once the stack is up.
The nightly backup is part of setup, not an appendix: it is one cron line,
and the day it matters it is the only thing that does.

## Where this stands

Plainly, so you can decide with open eyes:

- **The VPS / own-box path is the default shape.** One `docker compose up`
  with the files in [`deploy/selfhost/`](../../deploy/selfhost/): a proxy
  that owns TLS, the web app, the API server, the sync organizer, Postgres,
  attachment staging, and a local mail sink. The stack runs prebuilt images
  from `ghcr.io/trafficflowhq` (`ohmail-server`, `ohmail-worker`,
  `ohmail-web`), built for amd64 and arm64 and pinnable with
  `OHMAIL_IMAGE_TAG`. Every release builds each image twice, once on each
  architecture's own hardware. **From 0.13.3 on**, a release also boots the
  whole stack twice before any public tag moves — the same proxy, web app,
  API, organizer, Postgres and staging store, on amd64 and on arm64. Two
  things that leaves open, stated rather than implied. Images from
  **earlier** releases were built for arm64 but only ever booted on amd64,
  so if you have pinned an older `OHMAIL_IMAGE_TAG`, that is what you have.
  And no release at all, new or old, has run on a Raspberry Pi or an arm64
  server for a week of real mail, because there is no arm64 machine in this
  project — if you run one,
  [report how it went](https://github.com/trafficflowhq/ohmail/issues),
  because hardware reports are the only thing that closes that gap.
  If a pull answers "not found", that tag's images have
  not finished publishing — pin `OHMAIL_IMAGE_TAG` to the previous release,
  or build the three images from a clone and tag them with the names the
  compose file pulls, e.g.
  `docker build -f apps/server/Dockerfile -t ghcr.io/trafficflowhq/ohmail-server:local .`
  (likewise `apps/worker/Dockerfile.selfhost` → `ohmail-worker` and
  `apps/webapp/Dockerfile` → `ohmail-web`), then set `OHMAIL_IMAGE_TAG=local`.
- **The Umbrel app is a draft.** The manifest lives in
  [`deploy/umbrel/`](../../deploy/umbrel/) and is not yet in an app store.
  [UMBREL.md](./UMBREL.md) separates what works today from what is still
  arriving.
- **Start9 packaging is planned.** [`deploy/start9/`](../../deploy/start9/)
  records the intended shape; there is no installable package yet.
- **The first account is a guided page.** The server prints a one-time setup
  token to its log on first boot; open the install in a browser and it
  greets you with the setup page — paste the token, choose your sign-in, and
  it walks you through the second factor, recovery codes and the first
  mailbox. The one terminal command left is reading the token out of the
  log.
- **Your origin serves the app, not our shop front.** After the first account
  exists, your root address is the sign-in page. The ohmail marketing site,
  its pricing, and the ohmail.app legal pages are not part of a self-hosted
  install and answer 404 there — they describe a service somebody else
  operates, and they have no business on your domain.

## The shape of the install

Every path lands on the same stack, so every guide shares the same facts:

- **Five required values**, set once in `.env`: your origin, a database
  password, the encryption key for mailbox credentials at rest, the
  staging-store password, and this install's organizer identity — its
  name in every connected mailbox's `ohmail/_meta` claim, generated once
  and never changed. Everything else has a working default. The
  authoritative list, with a sentence beside each value, is
  [`deploy/selfhost/.env.example`](../../deploy/selfhost/.env.example).
- **First boot migrates the database, then prints a one-time setup token**
  to the API service's log. Reading that log proves you control the box —
  that is the whole first-account ceremony.
- **The encryption key (`TF_KEK_V1` in `.env`) is the one value you must
  never lose.** It encrypts your mailbox credentials at rest. Losing it
  means re-entering every connected mailbox. [BACKUP.md](./BACKUP.md) says
  where to keep it.

## Screener suggestions and reply drafts

Both are off until you configure a model, and both are optional: with no model
configured the Screener still holds first contact, rules still file mail, and
search still works. That is the floor, not a degraded mode — what changes is
that the suggestion and the draft are plainly unavailable rather than quietly
broken.

**There are two run-it-yourself surfaces and they do not offer the same
choices today.** They are listed apart rather than together because a single
sentence covering both would be wrong about one of them:

| Surface | Anthropic | OpenAI | Local (Ollama) |
| --- | --- | --- | --- |
| **Desktop app**, opening your mail server directly | yes | yes | yes |
| **This server stack** (`docker compose`) | yes | not yet | not yet |

### On this server stack

One value in `.env`:

```
ANTHROPIC_API_KEY=sk-ant-…
```

Requests go to Anthropic under your own key, billed to your account. Leave it
unset and the AI surfaces answer as unconfigured. **OpenAI and a local Ollama
are not wired into this stack yet** — the desktop app has them, this one does
not, and setting an `OPENAI_API_KEY` here does nothing.

### In the desktop app

Settings → Suggestions and drafts, where you pick one of three:

- **Your Anthropic key.** Requests go to `api.anthropic.com`, billed to you.
- **Your OpenAI key.** Requests go to `api.openai.com`, billed to you.
- **A model on this machine**, served by [Ollama](https://ollama.com). The
  address defaults to `http://127.0.0.1:11434` and is yours to change; nothing
  leaves the machine if the server is on it.

For the local option, install Ollama and pull a model before you choose it:

```
ollama pull llama3.2
```

`llama3.2` is the default because it is the smallest model measured to do both
jobs here. Something much smaller will screen senders and then fail to write a
draft — very small models tend to repeat themselves instead of finishing, and
what you get is a refusal saying the model did not finish rather than a draft.
Ollama also has to be running when you press Save, or the test that runs then
reports that nothing answered.

Saving discards the previous test and runs a new one, so the pane tells you
whether what you just saved actually works rather than leaving you to find out
when the next message arrives. A model server that is running but does not have
the model you named is reported as exactly that — the most common way this is
set up wrongly, and the one that otherwise looks identical to a working setup.

Whichever you choose, an API key is sealed under a key held in your operating
system's keystore, is never written down in the clear, is never read back, and
is sent to no host but its own vendor's. Mail carrying a one-time code or other
authentication material is refused before any request is built and is never
sent to any model, under any provider.
