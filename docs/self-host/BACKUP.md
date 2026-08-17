# Backing up your ohmail server

Start with the calming fact: **your mail itself is not at risk.** ohmail
organizes mailboxes that live at your providers, over IMAP; it never becomes
the only copy of a message. What your server holds — and what a backup
protects — is everything you have built on top: your accounts and passkeys,
the credentials of every connected mailbox (encrypted), your screening
decisions, rules, and piles, and cached copies of messages that would
otherwise be refetched.

Lose the box with no backup and your mail is still in your mailboxes. What
is gone is the organizing, and every credential — which means starting over.

## The three things, ranked

1. **The encryption key.** The `TF_KEK_V1` value in your `.env` encrypts
   secrets at rest — mailbox credentials, and also authenticator-app
   enrollments. The database backup below is only fully useful together
   with this key: restore the data without it and your accounts and
   organization survive, but everything it encrypted stops working — every
   connected mailbox has to be re-entered, and anyone who signs in with an
   authenticator app is locked out of their second factor (a passkey or a
   saved recovery code still works; passkeys are public keys, not encrypted
   secrets, and they survive). It is one line of text — put the whole
   `.env` in a password manager **the day you set the server up**, and
   again any time you change it. This is the single highest-value minute in
   this document.
2. **The database.** Postgres holds everything else. Back it up as a
   nightly `pg_dump`, not as a copy of the volume directory — a dump is
   consistent, portable across Postgres versions, and restorable with one
   command.
3. **The staging store (optional).** The MinIO volume holds attachment
   uploads in flight. It is transient by design — the organizer cleans it —
   and losing it can only affect a send that was mid-flight at that moment.
   Skip it unless volume-level backups cost you nothing.

The proxy's certificate volume needs no backup: certificates are
re-provisioned automatically on a fresh box.

## The nightly dump

A dump contains your mail in plain text, and a pipeline's exit code is the
code of its **last** command — so the recipe is a small script rather than
a one-liner, for two reasons it states itself: the file must not be
readable by other accounts on the box, and a night where `pg_dump` failed
must not leave a healthy-looking archive behind (without `pipefail`, a dead
`pg_dump` still ends in a successful `gzip`). Put this at
`/usr/local/bin/ohmail-backup` and `chmod +x` it, with the path to your
checkout:

```sh
#!/bin/bash
set -euo pipefail
umask 077                       # the dump is your mail — no other account reads it
cd /root/ohmail/deploy/selfhost
out="/var/backups/ohmail-$(date +%F).sql.gz"
docker compose exec -T db pg_dump -U ohmail -d ohmail | gzip > "${out}.partial"
mv "${out}.partial" "${out}"    # the real name appears only after a successful dump
```

Run it once by hand to see it work, then schedule it:

```
# /etc/cron.d/ohmail-backup
10 3 * * * root /usr/local/bin/ohmail-backup
```

**Then get it off the box.** A backup on the same disk dies with the disk;
a backup on the same box dies with the box. Any off-box copy counts:

```sh
# examples — pick one you already have
scp /var/backups/ohmail-$(date +%F).sql.gz you@another-machine:backups/
rclone copy /var/backups/ remote:ohmail-backups/
```

Keep a couple of weeks of dumps and delete older ones; a nightly gzipped
dump of a household's server is small.

On Umbrel the same dump works with the container's name instead of compose:
`docker exec ohmail-server_db_1 pg_dump -U ohmail -d ohmail`.

## Restoring

The drill, on a fresh box:

1. Set the stack up as in [VPS.md](./VPS.md) **using your saved `.env`** —
   the same `TF_KEK_V1`, the same `OHMAIL_ORIGIN`. A different key cannot
   decrypt the restored mailbox credentials; a different origin signs
   everybody out and re-registers passkeys.
2. Start **only the database** and let it become healthy:

   ```sh
   docker compose up -d db
   docker compose ps
   ```

3. Restore the dump into it — before anything else runs, so the schema
   arrives from the dump rather than from a fresh migration:

   ```sh
   gunzip -c ohmail-2026-01-01.sql.gz | docker compose exec -T db psql -U ohmail -d ohmail
   ```

4. Start the rest:

   ```sh
   docker compose up -d
   ```

5. Sign in. Connected mailboxes resync on their own; anything that changed
   in your mailboxes since the dump is refetched from the source of truth.

## Test it once

A backup nobody has restored is a hope, not a backup. Once, after your
first week: take a dump and restore it on any spare machine (a laptop with
Docker and `OHMAIL_ORIGIN=http://localhost` is enough). Two rules keep the
test from touching your real server:

- **Never start the organizer on the test box.** The restored database
  holds your real mailbox credentials, and the organizer is the process
  that signs in to mailboxes — a test copy running it is a second server
  working the same mail as your live one. Start everything else by name
  and the organizer stays down:

  ```sh
  docker compose up -d db        # then restore the dump, as above
  docker compose up -d proxy web api
  ```

- **Check sign-in with your password and authenticator code** (or a
  recovery code). Passkeys are bound to your real address and will not
  answer on the test box — that is them working correctly, not a failed
  restore.

Twenty minutes, and after it the word "backup" means something. Then take
the test stack down (`docker compose down`) so it is not forgotten.

## Rotating the key

The mechanics first: never replace `TF_KEK_V1` in place — rows encrypted
under it would become unreadable. Add `TF_KEK_V2` with a fresh value and
keep `TF_KEK_V1` set; new writes use the highest version, old rows still
decrypt with theirs. The comments in
[`.env.example`](../../deploy/selfhost/.env.example) beside the key are
the authoritative words on this.

Know what that does and does not achieve. Adding a version protects what
is written from then on; everything already stored stays readable to
anyone holding the old key — the old key stays loaded, which is exactly
what keeps your own rows working. So if you are rotating because the key
may have **leaked** — a laptop with your `.env` on it is gone, say —
adding a version is not containment by itself:

- **Change the connected mailboxes' passwords at their providers.** The
  stored credentials are what the key protects; once the provider password
  changes, anything a thief could decrypt no longer opens a mailbox.
  Re-enter each mailbox's new password in ohmail — each save re-encrypts
  it under the newest key as a side effect.
- Anyone signing in with an authenticator app should re-enroll it, for the
  same reason.
- Keep the risk in proportion: the key alone reads nothing — it decrypts a
  database. A leaked `.env` matters most if database backups may have
  leaked with it, which is one more reason the backup script above keeps
  its output private.

(A bulk re-encryption pass exists in the organizer's source —
`run-kek-rewrap` — for retiring an old key version without touching each
mailbox by hand; it is an operator tool without a written guide yet.)
