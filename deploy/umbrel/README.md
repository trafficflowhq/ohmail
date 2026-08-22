# ohmail for umbrelOS — app package

The umbrelOS app package for ohmail, in the format the official Umbrel app repository
(github.com/getumbrel/umbrel-apps) uses. The person-facing guide is
[`docs/self-host/UMBREL.md`](../../docs/self-host/UMBREL.md); this file is for whoever
works on the package itself. [`SUBMISSION.md`](./SUBMISSION.md) is the checklist for
getting it into the official app store.

## Status: submission-ready, not yet submitted

The app is **not in any app store yet**. What has changed since this package was a
draft: the three ohmail images are published on GHCR (multi-arch, linux/amd64 +
linux/arm64), every image in the compose is pinned `tag@sha256:…` with the multi-arch
index digest, and the package passes the official repository's own linter
(`npm run lint:apps -- ohmail --check-images`) with no issues.

What has NOT happened: a run on a real umbrelOS device. Everything below the
"assumptions" heading is designed and statically validated, not observed on hardware.

## The layout

```
ohmail/
  umbrel-app.yml            the app manifest (id: ohmail, official-store shape)
  docker-compose.yml        the stack, Umbrel-shaped, every image digest-pinned
  hooks/pre-start           generates secrets, seeds settings.env, renders the Caddyfile
  data/caddy/Caddyfile      committed placeholder; the hook renders the real one
  data/{postgres,minio,caddy/state,caddy/config}/.gitkeep
                            the bind-mount source directories, committed empty
```

The app id is `ohmail`, the official-store convention (no store prefix), and the
container names throughout follow Umbrel's `<app-id>_<service>_1` injection
(`ohmail_db_1`, …). To install TODAY — before the store submission is accepted — the
package has to travel through a community app store, whose convention prefixes app ids
with the store id: copy this directory into a store repository as
`<store-id>-ohmail/`, set that name as `id:` in `umbrel-app.yml`, and rename the
container names in the compose and the hook to match
(`<store-id>-ohmail_db_1`, …). The guide marks the same caveat.

## Design decisions, so nobody re-derives them

- **Secrets are generated on the device, not typed.** umbrelOS has no install-time
  configuration, so `hooks/pre-start` mints the database password, the
  credential-encryption key (`TF_KEK_V1`), and the staging-store password once into
  `data/env/secrets.env`, then derives the per-service env files from it on every
  start. One writer, so the api and organizer cannot disagree about the key ring or
  the storage block. They are random rather than derived from Umbrel's device seed ON
  PURPOSE: `TF_KEK_V1` is the value a person copies into a password manager, and with
  it (plus a database dump) the install can be rebuilt on any machine — a seed-derived
  key would be exactly as safe on the device and strictly worse off it.
- **The operator sets exactly one value**: `OHMAIL_ORIGIN`, in
  `data/env/settings.env` (seeded with comments by the hook). Everything optional
  (SMTP, the Microsoft OAuth block, the private-network allowances) lives in the same
  file and overrides the generated defaults via env_file order.
- **Host port 4443, because umbrelOS owns 80 and 443.** ohmail refuses to run on a
  plain-http, non-loopback origin — secure cookies and passkeys demand https — so the
  usual Umbrel shape (`http://umbrel.local:port` through the app proxy) cannot serve
  it. The bundled Caddy publishes host port 4443; the router forwards outside port 443
  there, and the certificate arrives over the TLS-ALPN challenge on that forwarded
  connection. Umbrel's `app_proxy` points at a small internal HTTP launcher site, so
  the dashboard's "Open" button goes somewhere sensible in BOTH states: configured, a
  redirect to the real origin; unconfigured, the setup steps.
- **The Caddyfile is rendered by the hook on every start**, not maintained as a
  committed config. Two reasons. First, umbrelOS copies `docker-compose.yml`, top-level
  templates, `exports.sh` and `hooks/` on app UPDATES — but not files under `data/` —
  so a committed front door would go stale on the first update that changes it. Second,
  rendering from `settings.env` is what lets the unconfigured launcher serve
  instructions instead of a dead redirect. The committed `data/caddy/Caddyfile` is a
  placeholder so the bind mount always has a file source; the hook overwrites it. The
  origin read from `settings.env` is validated before it is baked into config: https,
  a hostname, and NO port. The port is not a matter of taste — a Caddyfile site
  address's port is the port Caddy LISTENS on inside the container, and only container
  443 is published (as host 4443), so `https://host:8443` would put the TLS site
  where nothing forwards. TLS-ALPN issuance is answered on port 443 of the domain
  besides, so no other outside port can get a certificate anyway. A written-out `:443`
  is accepted and normalized away; anything else logs a line naming the rule and
  renders the setup page.
- **The organizer's database variable is `DATABASE_URL_SESSION`**, not
  `DATABASE_URL` — the hook writes both files from the same secret, mirroring
  `deploy/selfhost/docker-compose.yml`.
- **`MS_OAUTH_REDIRECT_URI` must be set explicitly here.** The selfhost compose
  derives it from the origin at interpolation time; this package configures services
  from env files, which cannot interpolate, so the settings template asks for all four
  Microsoft values.
- **The mailpit UI stays loopback-only** (`127.0.0.1:8025` on the device): it is the
  default sink for verification mail before a real SMTP relay is configured, and an
  SSH tunnel is the only way in. Deliberately never a network port.

## Assumptions a first device run must check

In the order they would bite:

- Host port 4443 is free on umbrelOS and an app may publish it (no store app uses it).
- `hooks/pre-start` runs before every compose up, as bash, with `APP_DATA_DIR` set.
- `env_file` paths under `${APP_DATA_DIR}` resolve at the compose version umbrelOS
  ships (verified against Docker Compose v2.40 locally).
- Caddy's TLS-ALPN issuance succeeds with only 4443 published, behind a home router's
  443→4443 forward.
- The manifest `port: 4680` and the internal `:8099` launcher port collide with
  nothing (no store app uses 4680).
- The manifest `category: social` is accepted. Measured against the store, mail has no
  settled home: `mailarchiver` and `stalwart` sit in `files`, `mailflow` (a webmail
  client) in `networking`. `social` is where the store keeps the things people talk to
  each other with — Element, Mattermost, The Lounge, FreshRSS — which is the closest
  fit for a mail client, and the PR says so and invites a retag.

## What is still to do

- **The boot.** No container has been started for this package — the machine it was
  written on cannot reach a Docker daemon. Two runs are outstanding and both are
  written out as runnable command blocks in
  [`SUBMISSION.md`](./SUBMISSION.md#the-boot-proof-parked--and-how-to-run-it): the
  stack on any Docker-capable host, and a real umbrelOS device against the checklist
  above.
- Screenshots for the store submission (attached to the pull request, not committed —
  the Umbrel team creates and hosts the final store assets, including the icon).
- Replace the settings-file step with a form the app shows on first open — the SSH
  edit is the roughest edge of the flow, and the store's standard is browser-only
  setup. The unconfigured launcher page narrows this gap (the "Open" button now shows
  the exact steps); a first-open form would close it.
