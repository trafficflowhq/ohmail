## Add ohmail

ohmail is a mail organizer for one household. It connects to the mailboxes a family
already has — over IMAP, with the credentials encrypted at rest on the device — and
organizes what it finds. The mailbox stays the source of truth: ohmail never becomes
the only copy of a message, and you can stop using it at any time without moving
anything. No metering, no billing, no open signup: the first account is created with
a one-time token printed to the app's log, and every later account arrives by
invitation.

- App/version: ohmail 0.11.0
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

### Testing performed

`npm run lint:apps -- ohmail --check-images` clean; the pre-start hook and the full
compose interpolation verified locally with Docker Compose v2.40 (secrets generated,
env files derived, both Caddyfile render states); the same seven-service stack (same
images, same wiring, different host layout) boots and serves in the upstream
repository's self-host deployment. Not yet run on a real umbrelOS device — the
package README lists the exact assumptions a device run must check, and we will run
whatever additional verification you want to see.
