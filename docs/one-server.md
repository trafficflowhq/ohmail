# One API program

ohmail's API is one program. A self-hosted server and the managed service run the same code, built from
settings; what differs between them is one list. This page says how that is put together, what every
setting is, and what the two hosts did differently before they were one.

The code is in `apps/server/src`:

| File | What it is |
|---|---|
| `settings.ts`, `settings/`, `config.ts` | Every setting the program reads, read once (`loadSettings`). |
| `differences.ts` | The list of what the managed service does differently. |
| `deps.ts` | The one wiring: the service bag and the per-request dependencies. |
| `handler.ts` | The one request pipeline. |
| `clocks.ts`, `clock-lock.ts`, `alert-clock.ts` | The program's own clocks, and the lock that lets one copy drive them. |
| `program.ts` | `buildProgram(settings, door)`: the program a door serves. |
| `index.ts` | The process door: a long-running server behind a proxy. |

`apps/api-vercel` is the second door: a function a platform starts per request. It reads the same
settings and serves the same program. It gets no new work, and it is the one app that imports another:
it wraps `apps/server` for as long as it exists.

## Two doors

A door loads the settings, says what kind of host it is, and serves `program.dispatch`.

| What the door hands in | Process door (`apps/server/src/index.ts`) | Function door (`apps/api-vercel/src`) |
|---|---|---|
| Largest request body | 50 MB (the node adapter's cap) | 4.5 MB (the platform's cap) |
| Inline attachment bytes in one send | 32 MiB | 3 MiB |
| How long a request may run | no limit | 60 s, then the platform ends it |
| When the costly services are built | before it listens | on first use (a cold start must not pay for them) |
| An answer that left request bytes unread | closes the connection | the platform owns the socket |
| Work that outlives an answer | runs on | handed to the platform, which freezes a function once it answers |
| `/events` | holds the stream | answers 204; clients poll |
| Longest `/events` lifetime that may be set | no ceiling | 290 s (the route's own limit, less a margin) |
| Build identity | the `BUILD_VERSION` file beside the program | the platform's id for the build, then the file |
| The release `/hello` states | the version its bundle was built with, else the checkout's manifest | the root manifest's version, which the build writes in |
| The deployment's label when `TF_ENV` is unset | none | the platform's label |
| Settings that fail to load | the process does not start | every request answers 503, `/health` with the reason |

None of this is a setting, and none of it is on the list of differences. A platform's own variables are
named in two files only, `apps/api-vercel/src/config.ts` and `deps.ts`, and reach the program as these
inputs. Nothing else reads a platform's name; `apps/server/test/settings.test.ts` loads the settings
with three platforms' variables set and holds that nothing changes, the branches that read the
deployment's label included.

A build of the function door needs `apps/server/src` beside `apps/api-vercel` and `packages/`: the door
imports `@ohmail/server/program` and `@ohmail/server/settings`, which resolve to source there. A deploy
that uploads a filtered tree must include it, or the build stops at a module that was not found.

Two names are left outside those files, both in packages this change does not touch:

- `packages/api/src/context.ts:13` reads the visitor's address from `x-vercel-forwarded-for` first.
  The node adapter drops every inbound `x-vercel-*` header (`packages/core/src/adapters/http-host.ts`),
  so on the process door that line never matches and the address comes from the proxies the operator
  named. Removing it belongs to the change that decides whose word is taken for the visitor's address
  behind a forwarding edge.
- `packages/core/src/organizer-install.ts:44` derives the organizer's install id from `TF_ENV`, else
  from `RAILWAY_ENVIRONMENT_NAME`, else `production`. The API and the organizer must name one install
  to a mailbox, so both call that one function and the program takes its answer as it is
  (`settings.installId`). It chooses no branch. `TF_ENV`, or `TF_ORGANIZER_INSTALL_ID`, pins it on any
  host.

## Which service a configuration is

A configuration is led by one name:

- `OHMAIL_ORIGIN`: a self-hosted server.
- `DATABASE_URL_POOLED`: the managed service.

Exactly one must be set. Both refuse the start, and so does neither: a configuration that lost its lead
never starts as the other service.

A configuration put together half-way does not start on the lax side either. Beside `OHMAIL_ORIGIN`,
each of these refuses the start, named: `TF_AUTH_ORIGINS`, `TF_RP_ID`, `TF_COOKIE_HOSTS`,
`DATABASE_URL_ADMIN`, `TF_ADMIN_SECRET`, `CRON_SECRET`, `TF_PUBLIC_SIGNUP`, `TF_INVITE_CODES`. They are
the managed service's, no self-hosted file carries one, and read as a self-hosted server the
configuration would migrate the database, meter nothing and ask no verified address. An emptied value is
not set.

Inside the managed service, `ENTITLEMENTS_URL` and `BILLING_PLANE_SECRET` are one marker for metering.
Both set: limits and AI credits are asked of the entitlements program. Neither: the managed service runs
unmetered (a preview, a test), and then nothing that costs may be set beside it: `ANTHROPIC_API_KEY`, or
`TF_PUBLIC_SIGNUP=1`, without the pair refuses the start, under every label. A deployment that lost both
names does not go on serving unlimited mailboxes and AI on the service's own key.
`BILLING_PLANE_SECRET` set without `ENTITLEMENTS_URL`, an emptied value included, refuses the start: that
is a deployment that would meter nothing while looking metered. The organizer has always refused it; the
API now does too. Either name beside `OHMAIL_ORIGIN` refuses.

Two managed rules are strict in production only: a deployment that cannot say which build it is fails
`/health`, and a bootstrap invite set (`TF_INVITE_CODES`) refuses the start unless
`TF_INVITE_BOOTSTRAP_ACK` repeats it. "Production" is `TF_ENV` where it is set, else what the door's host
says where it has a label, else `production`. For the build rule the door's label, where there is one,
decides alone.

## What the managed service does differently

The whole list is `DIFFERENCES` in `apps/server/src/differences.ts`. Which service a configuration is,
is decided once, from its lead (above). What follows from it is read from the list in both places that
could ask: `loadSettings` takes every block that differs from its line, and the wiring is typed against
settings that have no marker, so it can only take a line. `apps/server/test/differences.test.ts` holds
that each line reads differently on the two and shows each through the loaded settings or the built
program.

| Line | Self-hosted server | Managed service |
|---|---|---|
| `routes` | pairing and first-run setup | the staff door, the funnel, the scheduled passes |
| `flavor` | `/hello` says `selfhost` | `/hello` says `managed` |
| `origin` | the operator's one origin; its host is the passkey id and the only cookie host | listed origins, a passkey id, cookie hosts picked from a compiled list |
| `database` | one pool on the operator's own Postgres, which also holds the LISTEN | the managed database through its pooler; a session connection apart |
| `firstAccount` | a setup token, minted at start and whenever no account exists | no such ceremony |
| `migrations` | the server migrates before it listens | the deploy migrates; the server only serves |
| `requireVerified` | no: a pairing invite verifies nobody by mail | yes, before any costly route |
| `signup` | pairing invites only | invites, and open sign-up where configured with a mailer |
| `metering` | never: the operator's disk and keys | the entitlements program, where its pair is set |
| `owedCopy` | an owed Sent copy is kept with its files | kept without them: attachment bytes are never written down |
| `staffDoor` | none; the alert pass runs on the server's own handle | cross-account reads on the content-blind role only |
| `ai` | the operator's provider and bill | the shipped models, inside the plan's credits |
| `privateDials` | the operator's two switches | never |
| `deviceCodeDoor` | Microsoft's device-code sign-in is mounted | not mounted |
| `events` | `/events` is always served, asking every 5 s | served only where `TF_SSE=1`, asking every 8 s |
| `sendClock` | the server's own sending chain and alert clock | a scheduler pokes the internal routes, with its own credential |
| `pager` | unlisted on `/health` where nobody armed one | always listed, empty included |
| `funnel` | none | waitlist, mailbox discovery by DNS, connect records, lifecycle mails |
| `mailLinks` | every link in a mail names the one origin | the configured app, site and console addresses |
| `keyRetirement` | a key version marked retired refuses the start | read, and checked on `/health` against every stored secret |
| `buildIdentity` | a label that came from a variable is named on `/health` | in production, a build with no identity of its own fails `/health` |
| `paymentVariables` | not looked at | a `STRIPE_*` variable refuses the start |

Seven lines are decided when the settings load, and the wiring reads only their block: `origin`,
`database`, `events`, `mailLinks`, `keyRetirement`, `buildIdentity`, `paymentVariables`. The other
fifteen choose in the wiring. Some of those also decide which settings are read at all: the scheduler's
credential (`sendClock`), the staff blocks (`staffDoor`), the entitlements pair (`metering`), the model's
key (`ai`), the two switches (`privateDials`), the device client (`deviceCodeDoor`) and the lifecycle
switches (`funnel`).

The door decides whether an `/events` stream is held open, not this list: with the flag on, a function
answers 204 and clients poll, and a managed process holds the stream. With the flag off both answer
503 `sse_disabled`.

## Settings

Every setting, with its default and what a plain server sets. A setting is read once, by `loadSettings`.
No name an operator has in a file changed. A refusal names the variable and never its value.

### Read by both

| Setting | Default | A plain server sets |
|---|---|---|
| the key ring (its variables are in `docs/self-host/README.md`) | none; `/health` answers 503 naming a broken ring | 64 hex characters |
| `TF_ENV` | the door's label, else `production` | nothing |
| `TF_BUILD_VERSION` | `dev` | nothing; the image carries a `BUILD_VERSION` file |
| `PORT` | 8080 | nothing |
| `TF_TRUSTED_PROXIES` | none: no peer's `X-Forwarded-For` is believed | its proxy (`proxy` in the bundled compose) |
| `OHMAIL_EXTERNAL_TLS`, `OHMAIL_TLS_TERMINATOR` | the proxy terminates TLS | only behind an outside terminator |
| `SMTP_URL` or `RESEND_API_KEY`, with `MAIL_FROM`, `MAIL_REPLY_TO` | no mailer | `SMTP_URL` + `MAIL_FROM` |
| `TF_STORAGE_KIND` and the kind's block (`deploy/selfhost/.env.example` has both kinds) | no object storage | `s3` and the `S3_*` block |
| `TF_ALERT_SECRET` (24+ characters) | no pager; `/internal/*` answers 404 | when it wants a pager |
| `TF_ALERT_WEBHOOK_URL`, `TF_ALERT_TELEGRAM_BOT_TOKEN` + `TF_ALERT_TELEGRAM_CHAT_ID`, `TF_ALERT_EMAIL`, `TF_ALERT_HEARTBEAT_URL` | no arm | the arms it has |
| `MS_OAUTH_CLIENT_ID`, `MS_OAUTH_CLIENT_SECRET`, `MS_OAUTH_TENANT`, `MS_OAUTH_REDIRECT_URI` | none | its own registration, if any |
| `TF_VAPID_PUBLIC_KEY` | none | its generated public key |
| `TF_API_CLOCKS` | off | nothing (see Clocks) |

Mail to customers is one setting: the transport is whichever of `SMTP_URL` and `RESEND_API_KEY` is set.
Both refuse; so does either without `MAIL_FROM`, or `MAIL_FROM` alone. `TF_ALERT_EMAIL` without a mailer
refuses. Storage is one setting: `TF_STORAGE_KIND` names the kind and its block is all or nothing. The
older block of three variables with no kind is still read as its kind, and some of them without the
rest refuse.

### A self-hosted server's

| Setting | Default | Meaning |
|---|---|---|
| `OHMAIL_ORIGIN` | required | the one browser origin; the passkey id and the only cookie host (plus loopback) |
| `DATABASE_URL` | required | its own Postgres, session-capable; the server migrates it |
| `TF_PROBE_ALLOW_PRIVATE`, `TF_PUSH_ALLOW_PRIVATE` | off | `1` lets the mail probe, or a wake, dial a private address |
| `TF_AI_PROVIDER` and its block, `TF_AI_TIMEOUT_MS` | no AI | the operator's model |
| `MS_DEVICE_CLIENT_ID`, `MS_DEVICE_TENANT` | none | the public client of the device-code sign-in |
| `S3_PUBLIC_ENDPOINT` | `OHMAIL_ORIGIN` | where a browser uploads |

The managed service ignores the two switches and the device client. `TF_AI_PROVIDER` refuses there.
Retiring a key version refuses on a self-hosted server, which cannot do it yet.

A self-hosted server reads `ANTHROPIC_API_KEY` as its operator's own key, and the bundled compose hands
`DATABASE_URL_SESSION` to the organizer: neither says anything about which service a configuration is.

### The managed service's

| Setting | Default | Meaning | On a plain server |
|---|---|---|---|
| `DATABASE_URL_POOLED` | required | the runtime role through the pooler | `DATABASE_URL` |
| `DATABASE_URL_SESSION` | none | holds the LISTEN for `/events`, and the clock lock | `DATABASE_URL` |
| `DATABASE_URL_ADMIN` | none: the staff door and the pager's pass are off | the content-blind role | refused; the server's own handle runs the pass |
| `TF_AUTH_ORIGINS`, `TF_RP_ID`, `TF_COOKIE_HOSTS` | the product's own origin | origins, passkey id, cookie hosts from a compiled list | refused; `OHMAIL_ORIGIN` |
| `TF_APP_URL` | the product's own origin | the app's origin | `OHMAIL_ORIGIN` |
| `ENTITLEMENTS_URL` + `BILLING_PLANE_SECRET` | unmetered | the entitlements program | refused; never metered |
| `ANTHROPIC_API_KEY` | no AI | the shipped models; needs the entitlements pair | the operator's own key (`TF_AI_PROVIDER`) |
| `TF_SSE`, `TF_SSE_POLL_MS`, `TF_SSE_LIFETIME_MS` | off, 8 s, 270 s | whether `/events` is served | always on, 5 s, 270 s |
| `TF_ADMIN_SECRET`, `STAFF_ASSERTION_SIGNING_KEY`, `STAFF_ASSERTION_KID` | no console | the staff console's credential | the secret refused; no staff door |
| `CRON_SECRET` | none | a platform scheduler's credential for the scheduled routes | refused; `TF_ALERT_SECRET` |
| `TF_INVITE_CODES`, `TF_INVITE_BOOTSTRAP_ACK`, `TF_PUBLIC_SIGNUP`, `TF_PUBLIC_SIGNUP_CAP` | invites from the table only | bootstrap invites (refused in production without the acknowledgement), open sign-up (needs the entitlements pair) | the codes and the sign-up flag refused; the setup token and pairing invites |
| `TF_CONNECT_REMINDER`, `TF_CONNECT_REMINDER_SINCE`, `TF_CONNECT_ATTEMPTS` | log only, off | lifecycle mail and connect records | none |
| `MAIL_APP_URL`, `MAIL_SITE_URL`, `TF_ADMIN_URL`, `MAIL_SUPPORT_EMAIL` | the product's own | link bases in mail | all are `OHMAIL_ORIGIN` |
| the key ring's retired mark | none retired | key versions that left the ring | refused |

A `STRIPE_*` variable refuses the start: no payments code runs here. `TF_AUTH_ORIGINS` and `TF_RP_ID`
that do not make a usable pair refuse in one fixed sentence that quotes neither.

## Clocks

Some passes run on a clock, not on a request.

A self-hosted server keeps its own, as it always has: one chain every minute (scheduled sends, then
stranded reservations, owed Sent copies, the away responder, security notices) and the alert pass every
minute where `TF_ALERT_SECRET` is set. The managed service's passes are poked over HTTP by its worker and
its platform's scheduler.

`TF_API_CLOCKS=1` lets the program drive the poked passes itself, where it is a long-running process.
It is off by default, and nothing sets it yet. A pass is driven by dispatching its route inside the
process, with the same bearer and the same answers as the outside poke. The table is `CLOCK_ROWS` in
`apps/server/src/clocks.ts`, the worker's schedule row for row:

| Pass | Every | Does a self-hosted server need it | Driven with `TF_API_CLOCKS` |
|---|---|---|---|
| `sessions_reap` | day | yes; nothing ran it there | yes |
| `smtp_size` | day | yes; nothing ran it there | not yet: it dials mail servers |
| `scheduled_send` | minute | it has its own chain | not yet: it dials mail servers |
| `send_reconcile` | minute | it has its own chain | not yet: it dials mail servers |
| `away_responder` | minute | it has its own chain | not yet: it dials mail servers |
| `unsubscribe_drain` | hour | yes; nothing ran it there | yes |
| `account_lifecycle` | day | no: it is the managed service's | not yet: one fire makes follow-up calls |
| `security_notices` | 5 minutes | it has its own chain | on the managed service |
| `sent_copies` | 5 minutes | it has its own chain | not yet: it dials mail servers |
| `storage_mails` | hour | no: it follows metering | on the managed service |
| `alerts` | minute | it has its own clock | on the managed service |

No sending pass moves until a dial from an always-on host to the mail providers has been measured. The
passes left out are named once at start, and stay with the scheduler that pokes them today.

With the setting on, every clock of the program runs under one leader: a session-level advisory lock on
a connection of its own (`clock-lock.ts`). Of two copies alive at once, as during a deploy, one drives
and the other stands by, asks again every 15 s, and takes over when the first stops or loses its
session. `TF_API_CLOCKS` refuses the start on the function door, without `TF_ALERT_SECRET`, and on the
managed service without `DATABASE_URL_SESSION`.

## A bearer over plain http, only inside a private network

`ENTITLEMENTS_URL` is https. Plain http is admitted for one kind of address: a private service name.
That is a single label (`plane`), `localhost` or a name under it, or a name ending in `.internal` or
`.home.arpa`. An IP address is never one, nor any other name. The check is by the name's shape when the
settings load; no setting widens it.

At every call the name is resolved again. Every address it resolves to must be private, the socket
connects only to those addresses, no redirect is followed, and the bearer is always sent. A name that
resolves to one public address, or to none, is a failed call and nothing leaves the process. `/health`
names the transport in use (`billing.transport`).

A self-hosted server sets none of this.

## What the two hosts did differently

Before this change the API was wired twice: `apps/api-vercel/src` for the managed service and
`apps/server/src` for a self-hosted server. This is every difference found between them, with where it
stood (lines as of release 1.0.11) and what became of it. *Intended* differences are lines of the
list above, or inputs of a door. *Accidental* ones are gone: the program does one thing.

### Settings

| What | Function host (`apps/api-vercel/src`) | Self-host server (`apps/server/src`) | Kind | Now |
|---|---|---|---|---|
| Origin | `TF_AUTH_ORIGINS` + `TF_RP_ID`, defaulted; `TF_APP_URL` first-party check (`config.ts:34-35, 680-717, 872-881`) | `OHMAIL_ORIGIN`, one origin, the passkey id derived (`config.ts:332-365`) | intended | line `origin`; two name families, never mixed |
| A refused origin or passkey id | the validator's own message, which quotes the value, published on `/health` (`config.ts:872-881`) | a fixed sentence naming the variable (`config.ts:311-330`) | accidental | a fixed sentence on both |
| Cookie hosts | a compiled list `TF_COOKIE_HOSTS` may select from (`config.ts:46-81, 916, 939`) | the origin's host and loopback (`config.ts:35-52`) | intended | line `origin` (`origin.cookieHosts`) |
| The cookie rule per request | `config.ts:597-628` | the same rule, written again (`config.ts:63-82`) | accidental | one copy, `cookie-auth.ts` |
| Database | `DATABASE_URL_POOLED`, a pooled handle, 4 connections (`config.ts:565-569, 870`); `DATABASE_URL_SESSION` for LISTEN (`:139-146`); `DATABASE_URL_ADMIN` (`:1077-1102`) | `DATABASE_URL`, one owned pool of 5; a transaction pooler refused (`index.ts:92`, `config.ts:616-623`) | intended | line `database` |
| Start | none; settings resolved once per cold instance, 503 `config_invalid` on a fault (`handler.ts:70, 96, 189-193`) | waits for the database, migrates, mints the setup token, listens last, drains on SIGTERM (`index.ts:74-99, 349-380`) | intended | the door; migrate and mint are lines `migrations`, `firstAccount` |
| The strict branch | keyed to the platform's environment name: build identity (`config.ts:542`), invite bootstrap (`:811`), the label (`:980`) | `TF_ENV`, default `production`; refusals unconditional (`config.ts:730`) | accidental | the door hands the label in; no platform name is read |
| The entitlements pair | the bearer without the address booted unmetered (`config.ts:188-191, 766-767`) | none | accidental (the organizer refuses that state) | refused at start |
| No entitlements pair at all | booted unmetered with the AI key and open sign-up live (`config.ts:766-767`, `deps.ts:166-172`) | never metered, by design | accidental on the managed side | the key or open sign-up without the pair refuses |
| The other service's names | not looked at | not looked at: the managed service's names beside `OHMAIL_ORIGIN` were ignored | accidental | eight of them refuse beside `OHMAIL_ORIGIN`; both leads together refuse |
| `/events` | `TF_SSE` off by default, 8 s poll, holds nothing and answers 204 (`config.ts:92-127, 899-914, 935`) | always on, 5 s poll, holds (`config.ts:84-98`) | intended | line `events`; holding is the door's |
| Storage | three variables, no kind; a partial set silently off (`config.ts:994-1005`) | `TF_STORAGE_KIND`; partial and stray refused (`config.ts:519-606`) | intended as one setting; the silence accidental | one setting; partial refuses on both |
| Mail to customers | `RESEND_API_KEY` + `MAIL_FROM` and link bases; a partial block silently off (`config.ts:1145-1158`) | `SMTP_URL` + `MAIL_FROM`; partial refused (`config.ts:443-460`) | intended as one setting; the silence accidental | one setting; partial refuses on both; the link bases are line `mailLinks` |
| Alerts | `TF_ALERT_SECRET`; plus `CRON_SECRET`; a mail arm with no mailer silently not built (`config.ts:955-958, 1032-1055`) | `TF_ALERT_SECRET`; `TF_ALERT_EMAIL` without a mailer refused; the address checked (`config.ts:470-492`) | the scheduler's credential intended; the silence accidental | the refusal on both |
| Staff | `TF_ADMIN_SECRET`, `DATABASE_URL_ADMIN` with no fallback to the runtime URL (`config.ts:444-454, 1077-1143`) | none | intended | line `staffDoor` |
| AI | `ANTHROPIC_API_KEY` only; `TF_AI_PROVIDER` refused (`config.ts:851-858, 1016-1020`) | the provider family and `TF_AI_TIMEOUT_MS` (`config.ts:649-653, 680`) | intended | line `ai` |
| Sign-up and lifecycle | `TF_INVITE_CODES`, `TF_PUBLIC_SIGNUP`, `TF_CONNECT_*` (`config.ts:807-843, 960-963`) | none; open sign-up never (`config.ts:346-354`) | intended | lines `signup`, `funnel` |
| Key retirement | the retired mark read (`config.ts:892`) | refused (`config.ts:267-270, 632`) | intended | line `keyRetirement` |
| `STRIPE_*` | refused (`config.ts:728-739`) | not looked at | intended | line `paymentVariables` |
| Private dials | never | `TF_PROBE_ALLOW_PRIVATE`, `TF_PUSH_ALLOW_PRIVATE` (`config.ts:701, 715`) | intended | line `privateDials` |
| The device-code client | not read | `MS_DEVICE_CLIENT_ID` (`config.ts:692`) | intended | line `deviceCodeDoor` |
| The wake key | read from the environment per request (`deps.ts:731`), against the file's own rule | read once (`config.ts:729`) | accidental | read once |
| The install id | `resolveCloudInstallId(process.env)` inside the wiring (`deps.ts:267`) | the same (`deps.ts:355`) | accidental on both | read once, `settings.installId` |
| Build identity | the platform's id, then a file at the working directory, then `TF_BUILD_VERSION` (`config.ts:493-522`); none in production fails `/health` (`:527-554`) | a file beside the module, then the variable, then `dev`; only a label from the variable is reported (`config.ts:279-300`) | intended | the file reader and the platform's id are the door's; what is asked of it is line `buildIdentity` |
| Network | not read | `PORT`, `TF_TRUSTED_PROXIES`, the terminator pair (`config.ts:368-440, 625-629`) | intended | read on both, used by the process door |

### Wiring

| What | Function host (`deps.ts`) | Self-host server (`deps.ts`) | Kind | Now |
|---|---|---|---|---|
| Route table | `apiRoutes` (`handler.ts:23`) | `selfHostRoutes` (`handler.ts:132`) | intended | line `routes` |
| `/hello` | `managed`, never needs setup (`:735-739`) | `selfhost`, needs setup while no account exists (`:658-660`) | intended | lines `flavor`, `firstAccount` |
| The release `/hello` states (added after 1.0.11) | the root manifest's version, written in by the build and read where `/hello` was wired | the version the bundler baked in, else the checkout's manifest, read on every request | intended | the door hands in what its build wrote, read once; one line of the wiring states it on both |
| Verified address for costly routes | required (`:669`) | not required (`:621`) | intended | line `requireVerified` |
| Entitlements port, storage cap, mailbox allowance, access verdict, live-body admission, alert readers, refunds | the client or unmetered (`:166-172, 254-261, 385-408, 510-538, 820-822`) | unmetered, stated (`:78-80, 281, 343, 348-353, 715-718`) | intended | line `metering` |
| Owed Sent copy | without files (`:156`) | with files (`:276`) | intended | line `owedCopy` |
| Staff door and the alert pass's handle | `admin`, `adminDb`; no handle of its own for the pass (`:852-870`) | no staff door; `alerts.db` (`:720`) | intended | line `staffDoor` |
| Probe and wake guards | strict (`:134-146`) | strict unless the operator's switch (`:253-270`) | intended | line `privateDials` |
| Invite redemption, waitlist, DNS discovery, connect records | waitlist, DNS, records (`:436-438, 826-829, 882`) | invite redemption (`:341`) | intended | lines `signup`, `funnel` |
| A Sent copy retried after the answer | no | yes (`:274`) | intended | the door: a process nothing ends |
| Send surface ceiling | 3 MiB (`:153`) | 32 MiB (`:272`) | intended | the door |
| Drafting and screener time budget | the invocation's 60 s (`:208, 313`) | none (`:321, 383`) | intended | the door |
| Service bag | lazy getters (`:98-108`) | built at start (`:229`) | intended | the door |
| Token provider | one per request (`:883-892`) | one per process (`:496-553`) | accidental | one per program; it handles expiry |
| Staging storage client | one per call (`:182-185`) | one per process (`:234`) | accidental | one per program |
| Pager arms, heartbeat, the arm that refuses when it cannot be built | `:496-639` | the same code again (`:434-494`) | accidental | one copy |
| Customer mailer that cannot be built | logged, mail off (`:459-485`) | refuses the start (`:145-158`) | intended | the door: a process refuses, a function degrades |
| `/health` extras | fresh-connection probe, key retirement, entitlements, staff attestation (`:670-721`) | both journals probed (`:622-648`) | intended | by lines `database`, `keyRetirement`, `metering`, `staffDoor`, `pager` |
| Fault log handle | a fresh pooled handle with a short wait (`:789-807`) | the pool (`:698-702`) | intended | line `database` |
| Logger | `service: "api"` (`:966`) | `service: "server"` (`index.ts:64`) | intended | the door hands it in |

### Request handling

| What | Function host (`handler.ts`) | Self-host server (`handler.ts`) | Kind | Now |
|---|---|---|---|---|
| Request id, normalize once, HEAD as GET, `no-store` | `:66-143` | the same steps, written again (`:134-192`) | accidental | one pipeline |
| A busy database on a route with no error envelope | answered 503 `db_busy` (`:128-142`) | answered 500 | accidental | 503 on both |
| The client's leave reaching the route | the abort signal passed on (`normalize.ts:24`) | not passed | accidental | passed on both |
| Body ceiling of the inline-attachment route | 4.5 MB (`prefix.ts:23`) | 50 MB (`config.ts:109`) | intended | the door |
| Connection closed after unread bytes | no | yes (`:120-130`) | intended | the door |
| Quiet hold after an answer | yes (`quiet-hold.ts`) | no | intended | stays in the function door |
| Settings that did not load | 503, `/health` with the reason (`:189-193`) | the process never started | intended | stays in the function door |

### Clocks

| What | Function host | Self-host server | Kind | Now |
|---|---|---|---|---|
| Sending passes and security notices | poked by the worker over HTTP, ten routes (`apps/worker/src/api-cron.ts:59-232`) | one in-process chain every minute (`index.ts:170-344`) | intended | line `sendClock`; the chain moved to `clocks.ts` unchanged |
| Alert pass | poked by the platform's scheduler every 2 minutes | its own clock every minute (`alert-clock.ts`) | intended | line `sendClock` |
| Session reaper, size probe, unsubscribe drain | poked | ran nowhere: the compose sets no poke address | accidental | rows of `CLOCK_ROWS`, driven with `TF_API_CLOCKS` |
| Lifecycle mails, storage mails | poked | ran nowhere, and need not: they follow the managed service | intended | the managed service's rows |
