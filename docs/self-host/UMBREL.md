# ohmail on Umbrel

Umbrel is a home-server OS: a small box in your home that installs apps the
way a phone does. It is the path this project wants to be the easiest one —
install from a store, read one token, done.

**Where this stands, before anything else.** The ohmail app for umbrelOS is
a draft. The manifest lives in this repository under
[`deploy/umbrel/`](../../deploy/umbrel/), it is not yet in any app store,
and the prebuilt images it references are not yet published. This guide
describes the install as the manifest defines it, and marks every step that
is still arriving. When the app reaches a store, the whole thing below the
"one thing to prepare" section should take under ten minutes.

> **[screenshot placeholder: the ohmail tile in the Umbrel app store —
> added with the store submission]**

## The one thing to prepare: an address

ohmail needs an https address — your mail passwords deserve TLS, and the
browser features it uses (secure cookies, passkeys) do not exist on plain
`http://umbrel.local`. That is a hard rule in the server, not a preference,
so an Umbrel install needs two things most Umbrel apps don't:

1. **A domain name** pointing at your home's public IP address —
   `mail.yourhome.example`. A dynamic-DNS name works if your home IP
   changes.
2. **One port forwarded on your router:** outside port 443 to your Umbrel's
   address, port 443. The app obtains and renews its TLS certificate itself
   once traffic on 443 reaches it.

If forwarding a port is not something you can do (some ISPs make it hard),
the honest answer today is: ohmail on this box is not ready for you yet —
an alternative that needs no open ports is being worked on.

## Installing

**When the app is in a store:** find ohmail in the app store, install, and
skip to "Tell it your address".

**Today (the draft path):** the manifest in `deploy/umbrel/` is written in
umbrelOS's community-app-store format. Installing it means placing those
files in a community app store repository and adding that store's URL to
your Umbrel (Settings → App store → Community app stores). The
[`deploy/umbrel/README.md`](../../deploy/umbrel/README.md) documents
exactly that, including what has not been verified on a real device yet.
Until the images are published, even this path ends at a failed image pull.

> **[screenshot placeholder: adding a community app store URL in umbrelOS
> settings]**

## Tell it your address

The app keeps its settings in one file in its data directory,
`settings.env`, created on first start. Open a terminal on your Umbrel
(Settings → Advanced → Terminal, or SSH) and set the one required line:

```sh
nano ~/umbrel/app-data/ohmail-server/env/settings.env
# set:  OHMAIL_ORIGIN=https://mail.yourhome.example
```

then restart the ohmail app from the Umbrel dashboard.

Editing a file over SSH is the roughest edge of the draft — replacing this
step with a form the app shows on first open is part of the polish planned
before any store submission. Every other secret (database password,
encryption key, storage credential) is generated for you on the device; you
never handle those.

## First run: the setup token

On its first healthy start the server prints a one-time setup token — once,
to its own log. Reading that log proves you control the box, which is why
there is no default password anywhere.

Where to find it on Umbrel: open the app's logs from the Umbrel dashboard
(Settings → Troubleshoot, pick the ohmail app), or over SSH:

```sh
docker logs ohmail-server_api_1
```

Look for the fenced `FIRST-RUN SETUP` block; the token is the long value in
the middle. It works once and expires — restarting the app retires it and
prints a fresh one, so a lost token costs nothing. After a restart the
retired block is still in the log above the new one, so read the **newest**
block (`docker logs --tail 60 ohmail-server_api_1`).

> **[screenshot placeholder: the FIRST-RUN SETUP block in the Umbrel log
> viewer]**

Then open `https://mail.yourhome.example` in a browser. A fresh server
greets you with its setup page (also directly at `/setup`): paste the token,
choose your email address, name and password, and the page creates the first
account and walks straight on — second factor, recovery codes, first
mailbox. The ceremony is identical to the VPS guide's:
[VPS.md, step 6](./VPS.md#6-create-the-first-account).

## Connecting your first mailbox

Sign in and add a mailbox: your address, your provider's IMAP server, and
your password or app password. The provider notes in
[VPS.md, step 7](./VPS.md#7-connect-your-first-mailbox) apply unchanged —
Gmail wants an app password; Microsoft 365 needs the one-time
`MS_OAUTH_*` registration (those lines also go in `settings.env`).

If the mailbox you are connecting lives on your own network — the same NAS
the Umbrel sits next to, say — add `TF_PROBE_ALLOW_PRIVATE=1` to
`settings.env` and restart the app, then confirm the connection-security
notice when adding the mailbox if that server has no TLS.

> **[screenshot placeholder: the add-mailbox screen with a household member's
> Gmail account filled in]**

## Your household

Accounts on your server only ever arrive by invitation — there is no open
signup, and the setup token above only exists while the server has zero
users. To bring in the rest of the household: **Settings → Invites → Make an
invite link**, then let them scan the QR with their phone or send them the
link. It works once, expires after seven days, and can be revoked from the
same page if it goes astray. Whoever opens it sets their own password and
gets their own account — their sign-in, their mail. Send invite links over
a channel you trust: opening one is all it takes to claim the account.

## Backups on Umbrel

Everything the app stores lives under
`~/umbrel/app-data/ohmail-server/` on the device. The two things that
matter, in order:

1. **The generated secrets** — one small file at
   `~/umbrel/app-data/ohmail-server/env/secrets.env`. It holds the key that
   encrypts your mailbox credentials; copy it into a password manager once,
   the day you install. Lose it and every mailbox has to be re-entered.
2. **The database** — the nightly backup script from
   [BACKUP.md](./BACKUP.md), with one Umbrel-shaped change: its
   `docker compose exec -T db pg_dump …` line (and the `cd` above it)
   becomes

   ```sh
   docker exec ohmail-server_db_1 pg_dump -U ohmail -d ohmail
   ```

   Keep the rest of the script as it is — the private file mode and the
   rename-only-on-success are what make a failed night look failed.

Copy both off the device. Your mail itself is safe regardless — it lives in
your providers' mailboxes, and ohmail never becomes the only copy — but the
organizing, the accounts, and the connected-mailbox credentials are what a
backup protects.
