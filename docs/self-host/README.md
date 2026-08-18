# Run ohmail on your own server

ohmail connects to the mailboxes you already have. It signs in to them over
IMAP, organizes what it finds, and never becomes the place your mail lives —
your mailbox stays the source of truth, and you can stop using ohmail at any
time without moving anything. Running it yourself means the organizing happens
on a machine you own, and your mail credentials sit on hardware you control.

Self-hosting is built for one household: you, your partner, your family.
It is not a multi-tenant hosting kit, and nothing in it meters or bills.

## What you need

- **A machine that stays on.** A small VPS, a home server, or a box in a
  closet. 2 GB of memory and 20 GB of disk are comfortable.
- **Docker**, with the compose plugin (`docker compose`, not the older
  `docker-compose`).
- **A domain name pointed at that machine.** Mail credentials deserve TLS,
  and the browser features ohmail relies on — secure cookies, passkeys —
  require an https origin, so the server refuses to run without one (a
  same-box `http://localhost` test run is the one exception). The stack
  provisions and renews certificates itself; you only point the domain.
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
  `OHMAIL_IMAGE_TAG`. If a pull answers "not found", the images for that tag
  have not been published yet — the first public image release is what turns
  these guides from a description into a procedure.
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

## The shape of the install

Every path lands on the same stack, so every guide shares the same facts:

- **Four required values**, set once in `.env`: your origin, a database
  password, the encryption key for mailbox credentials at rest, and the
  staging-store password. Everything else has a working default. The
  authoritative list, with a sentence beside each value, is
  [`deploy/selfhost/.env.example`](../../deploy/selfhost/.env.example).
- **First boot migrates the database, then prints a one-time setup token**
  to the API service's log. Reading that log proves you control the box —
  that is the whole first-account ceremony.
- **The encryption key (`TF_KEK_V1` in `.env`) is the one value you must
  never lose.** It encrypts your mailbox credentials at rest. Losing it
  means re-entering every connected mailbox. [BACKUP.md](./BACKUP.md) says
  where to keep it.
