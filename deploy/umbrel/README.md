# ohmail for umbrelOS — app package (draft)

The umbrelOS app package for ohmail: a manifest and compose file in the format the
official Umbrel app repository uses, plus the pieces umbrelOS itself does not
provide. The person-facing guide is
[`docs/self-host/UMBREL.md`](../../docs/self-host/UMBREL.md); this file is for
whoever takes the package the rest of the way.

## Status: draft, honestly

Two things stand between these files and an installable app:

1. **The images are not published yet.** The compose references
   `ghcr.io/trafficflowhq/ohmail-{server,worker,web}`; until those packages are
   public, every install ends at a failed pull. Once they exist, every image in
   `ohmail-server/docker-compose.yml` must be pinned as `name:tag@sha256:…` (the
   store requires digests) and `version:` in `umbrel-app.yml` set to the image tag.
2. **Nothing here has run on a real Umbrel device.** The format is modeled on
   current apps in the official repository (the manifest fields, the `app_proxy`
   service, `${APP_DATA_DIR}` volumes, a `hooks/pre-start` script, container names
   in the `<app-id>_<service>_1` convention). The behavior below is designed, not
   observed.

## The layout

```
umbrel-app-store.yml            the community-store descriptor (store id: ohmail)
ohmail-server/
  umbrel-app.yml                the app manifest
  docker-compose.yml            the stack, Umbrel-shaped
  hooks/pre-start               generates secrets + seeds settings.env on-device
  data/caddy/Caddyfile          the front door (seeded into APP_DATA_DIR/data)
```

To install from a community store, umbrelOS wants `umbrel-app-store.yml` at the
**root** of a repository with the app directory beside it — so publishing this as a
community store means copying `umbrel-app-store.yml` and `ohmail-server/` into a
repository of their own and adding that repository's URL in umbrelOS settings.
Submitting to the official store instead means a pull request to
`getumbrel/umbrel-apps` with the app id shortened to `ohmail` (official apps carry
no store prefix; the container names in the compose, the Caddyfile, and the hook
must be renamed to match).

## Design decisions, so nobody re-derives them

- **Secrets are generated on the device, not typed.** umbrelOS has no install-time
  configuration, so `hooks/pre-start` mints the database password, the
  credential-encryption key (`TF_KEK_V1`), and the staging-store password once into
  `APP_DATA_DIR/env/secrets.env`, then derives the per-service env files from it on
  every start. One writer, so the api and organizer cannot disagree about the key
  ring or the storage block.
- **The operator sets exactly one value**: `OHMAIL_ORIGIN`, in
  `APP_DATA_DIR/env/settings.env` (seeded with comments by the hook). Everything
  optional (SMTP, the Microsoft OAuth block, the private-network probe allowance)
  lives in the same file and overrides the generated defaults via env_file order.
- **Port 443 only.** ohmail refuses to run on a plain-http, non-loopback origin —
  secure cookies and passkeys demand https — so the usual Umbrel shape
  (`http://umbrel.local:port` through the app proxy) cannot serve it. The bundled
  Caddy publishes host port 443 and obtains certificates over the TLS-ALPN
  challenge, because umbrelOS itself owns port 80. Umbrel's `app_proxy` points at a
  small internal HTTP site that redirects to the real origin, so the dashboard's
  "Open" button goes somewhere sensible.
- **The organizer's database variable is `DATABASE_URL_SESSION`**, not
  `DATABASE_URL` — the hook writes both files from the same secret, mirroring
  `deploy/selfhost/docker-compose.yml`.
- **`MS_OAUTH_REDIRECT_URI` must be set explicitly here.** The selfhost compose
  derives it from the origin at interpolation time; this package configures
  services from env files, which cannot interpolate, so the settings template asks
  for all four Microsoft values.

## Assumptions a first device run must check

In the order they would bite:

- Host port 443 is free on umbrelOS and an app may publish it.
- The app repo's `data/` directory is seeded into `APP_DATA_DIR` on install (the
  Caddyfile mount depends on it; if not, the pre-start hook is the place to write
  the file instead).
- `hooks/pre-start` runs before every compose up, as bash, with the app directory
  layout current official apps assume.
- `env_file` paths under `${APP_DATA_DIR}` resolve at the compose version umbrelOS
  ships.
- Caddy's TLS-ALPN issuance succeeds with only 443 published, behind a home
  router's port-forward.
- The `port: 4680` and the internal `:8099` launcher port collide with nothing.
- The manifest `category: social` is accepted (there is no obviously right
  category for mail).

## What is still to do

- Publish the images; pin digests; set `version:`.
- One full run on a real device, against the checklist above.
- An icon and gallery screenshots (designer work, at submission).
- Replace the settings-file step with a first-open form — the guide calls the SSH
  edit the roughest edge, and it is.
