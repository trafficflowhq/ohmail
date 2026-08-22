## Add ohmail

ohmail is a mail organizer for one household. It connects to the mailboxes a family
already has — over IMAP, with the credentials encrypted at rest on the device — and
organizes what it finds. The mailbox stays the source of truth: ohmail never becomes
the only copy of a message, and you can stop using it at any time without moving
anything. No metering, no billing, no open signup: the first account is created with
a one-time token printed to the app's log, and every later account arrives by
invitation.

- App/version: ohmail 0.11.0
- Category: `social`, where the store keeps the messengers and readers. Mail in the
  store is currently split between `files` and `networking`, so this is a judgement
  call — retag it wherever you think it belongs.
- Upstream: https://github.com/trafficflowhq/ohmail (AGPL-3.0)
- Images: `ghcr.io/trafficflowhq/ohmail-{server,worker,web}:0.11.0`, built by the
  upstream repository's release workflow, linux/amd64 + linux/arm64, pinned by
  multi-arch index digest. Postgres, MinIO, Caddy and Mailpit sidecars pinned the
  same way.

### Topology

Seven services: Caddy (TLS front door), the web app, the API server, the sync worker,
Postgres, MinIO (attachment staging), and Mailpit (default sink for verification
mail). All state lives under `${APP_DATA_DIR}/data/...`. Secrets are generated
on-device by `hooks/pre-start` into `data/env/` — the person installing never handles
them. They are random rather than seed-derived on purpose: the credential-encryption
key is the one value users are told to copy into a password manager, because with it
(plus a database dump) the install can be rebuilt on any machine.

### Two deliberate departures from the packaging guidance

**Secrets are random and written to a file, not `derive_entropy`.** The guidance
prefers device-seed-derived values for package-generated local secrets, and for the
Postgres and MinIO passwords either would do. The credential-encryption key is the
reason we generate instead: it is the one value a user is told to copy into a password
manager, because with it plus a database dump the install can be rebuilt on another
machine. A seed-derived key is exactly as safe on the device and strictly worse off it
— it cannot leave with the backup. Deriving two of the three secrets and generating the
third would also mean two writers for one key ring; one writer is what keeps the API
and the worker from disagreeing about it. Happy to move the two database/storage
passwords to `derive_entropy` if you would rather they came from the seed.

**One raw host port for the product's own TLS.** `app_proxy` fronts the launcher page
as usual, but the app itself is served by the bundled Caddy on host port 4443, because
the certificate is the app's own and `app_proxy` cannot terminate it. Everything else
about the proxy wiring is the framework default, Umbrel auth included.

### Setup behavior, stated plainly

ohmail requires an https origin of its own — its session cookies and passkeys do not
exist on plain `http://umbrel.local`, and that is enforced by the server, not a
preference. So this app asks more of the user than most:

1. a domain pointed at their home, and
2. a router forward of outside port 443 to the device's port 4443, and
3. one line (`OHMAIL_ORIGIN=https://…`) set in the app's settings file over SSH,
   then an app restart.

Opening the app before that is done shows a page with exactly these steps (the
`app_proxy` target is a launcher site the pre-start hook renders from the settings
file), so the next step is always visible from the browser. We know the SSH edit
falls short of the store's browser-only-setup standard; a first-open form that writes
the same file is planned, and we would rather state the gap than paper over it. The
first-run auth token is read from the app's log via the dashboard's Troubleshoot
view — no default credentials exist anywhere.

### Ports and host access

- Manifest port 4680 → launcher site (`APP_PORT: 8099`), standard app_proxy wiring
  with Umbrel auth left on.
- One raw host port, `4443:443` (TLS): the actual product origin. Raw because it is
  TLS pass-through to the app's own certificate, which app_proxy cannot front; 4443
  because umbrelOS owns 80/443. No other app in the store publishes 4443.
- `127.0.0.1:8025:8025`: the Mailpit UI, loopback on the device only, for reading
  verification mail over an SSH tunnel before a real SMTP relay is configured.
- No privileged mode, no host network, no device mounts, no Docker socket, no
  capabilities added.

### Testing performed, and what it is not

- `npm run lint:apps -- ohmail --check-images`: `No issues found`.
- Every image digest re-resolved against its registry; the three ohmail images
  confirmed to be OCI indexes carrying `linux/amd64` and `linux/arm64`.
- `hooks/pre-start` exercised across its states: fresh, configured, re-run (secrets are
  minted once and stay stable), and with a rotated key added — which reaches both the
  API's and the worker's env files. Origin validation checked value by value:
  `https://host` and `https://host:443` render the front door; a non-443 port, plain
  `http`, and an origin with a path are each refused with a log line, and the app then
  serves the setup page instead of a front door pointing nowhere.
- `docker compose config` resolves the stack in both the configured and unconfigured
  states, with Mailpit's UI bound to loopback.

**No container has been started for this package.** The machine it was written on
cannot reach a Docker daemon, so all of the above is static validation. The same seven
services, same images and same wiring do boot and serve as the project's own
`deploy/selfhost` stack, but that is evidence about the software, not about this
package. The package README lists the assumptions a first device run must check, and
we will run whatever verification you want to see — including on hardware, if you tell
us what you want to see from it.
