# ohmail for StartOS (Start9) — intended packaging

There is no installable Start9 package yet. This file records the intended shape so
the work starts from a plan instead of a blank page, and so nobody mistakes the
directory for a finished package.

## Why this is a follow-up, not part of the first self-host release

StartOS packages (`.s9pk`) are not a manifest-plus-compose format. A package is a
TypeScript project built with `@start9labs/start-sdk`: a `setupManifest` module, a
`main.ts` that declares each long-running process as a daemon in its own
subcontainer with its own health check, `interfaces.ts` for the exposed addresses,
`backups.ts` for StartOS's integrated backup system, and actions/init modules —
compiled and packed with Start9's toolchain. Mapping a seven-service stack onto
that honestly is a real engineering slice with its own testing story, and
pretending otherwise with a half-translated package would break at install time on
someone's actual home server. The Umbrel package (`../umbrel/`) and the plain
compose stack (`../selfhost/`) come first; this follows.

## The intended mapping

Everything below mirrors decisions already made in `deploy/selfhost/` — the
StartOS package translates them, it does not re-decide them.

- **Images** — the published `ghcr.io/trafficflowhq/ohmail-{server,worker,web}`
  images (amd64 + arm64), pinned by tag, in the manifest's `images:` map alongside
  `postgres:16` and a MinIO image. Same images as every other install; the package
  adds no build of its own.
- **Daemons** — one per process, with the same readiness semantics as the compose
  stack's health checks and the same ordering: postgres ready → bucket ensured →
  `api` (which migrates before it listens, and whose `/health` means "migrated,
  keyed, serving") → `organizer`. The api reads `DATABASE_URL`; the organizer
  reads `DATABASE_URL_SESSION` — two names for the same database, set from one
  place so they cannot disagree.
- **Configuration** — StartOS has what umbrelOS lacks: a real config UI. The spec
  maps the `.env` contract in `deploy/selfhost/.env.example` one to one: the
  origin is the one required user-facing value; the database password, the
  credential-encryption key (`TF_KEK_V1`, 64 hex chars), and the staging-store
  password are generated; SMTP, the Microsoft OAuth block (all four values,
  including the redirect URI), the AI key, the private-network probe
  allowance (`TF_PROBE_ALLOW_PRIVATE=1`) and the private-network push-endpoint
  allowance (`TF_PUSH_ALLOW_PRIVATE=1`, for a UnifiedPush distributor on the
  same box — a separate decision from the probe, since it licenses an
  unattended sender rather than one connection check) are optional fields with
  the template's own sentences beside them.
- **The origin requirement carries over.** ohmail refuses a plain-http,
  non-loopback origin — secure cookies and passkeys demand https. StartOS
  provisions `.onion` and `.local` addresses for services, and those do not
  satisfy it; the package needs the operator to bring a real domain with port 443
  reaching the box, exactly as on Umbrel. Whether StartOS's clearnet/interface
  machinery can own the certificate instead of the bundled Caddy is the first
  design question of the slice — if it can, the proxy daemon may not need to
  exist here at all, but the API's exact path surface
  (`/api /auth /events /health /hello /pair /internal`) must still route to the
  api process and everything else to web.
- **First run** — the server prints a one-time setup token to its log on first
  boot (that is the whole first-account ceremony: reading the log proves box
  control). The package should surface it properly — StartOS "Properties" or an
  action that shows it — rather than sending people log-diving.
- **Backups** — `backups.ts` covers the Postgres volume and the generated
  secrets. The key that encrypts mailbox credentials must be in every backup;
  losing it means re-entering every connected mailbox
  (see `docs/self-host/BACKUP.md`). The MinIO volume is transient staging and may
  be excluded.

## What the slice needs

- The Start9 SDK toolchain and a StartOS box (or VM) to install on — nothing
  here should ship untested, per the same rule the Umbrel draft states.
- The published images (the same gate every install path shares).
- The upstream examples to build from: Start9's `hello-world-startos` repository
  is the canonical skeleton of the current SDK.
