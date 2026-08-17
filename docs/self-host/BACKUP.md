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
   mailbox credentials at rest. The database backup below is only fully
   useful together with this key: restore the data without it and your
   accounts and organization survive, but every connected mailbox has to be
   re-entered by hand. It is one line of text — put the whole `.env` in a
   password manager **the day you set the server up**, and again any time
   you change it. This is the single highest-value minute in this document.
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

On the box, with the stack running:

```sh
docker compose exec -T db pg_dump -U ohmail -d ohmail | gzip > ohmail-$(date +%F).sql.gz
```

Schedule it (as root, with the path to your checkout):

```
# /etc/cron.d/ohmail-backup
10 3 * * * root cd /root/ohmail/deploy/selfhost && docker compose exec -T db pg_dump -U ohmail -d ohmail | gzip > /var/backups/ohmail-$(date +\%F).sql.gz
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
first week: take a dump, restore it on any spare machine (a laptop with
Docker and `OHMAIL_ORIGIN=http://localhost` is enough), and check you can
sign in. Twenty minutes, and after it the word "backup" means something.

## Rotating the key

If the key must change — a laptop with your `.env` on it was lost, say —
do not replace `TF_KEK_V1` in place: rows encrypted under it would become
unreadable. Add `TF_KEK_V2` with a fresh value and keep `TF_KEK_V1` set;
new writes use the highest version and old rows still decrypt with theirs.
The comments in [`.env.example`](../../deploy/selfhost/.env.example) beside
the key are the authoritative words on this.
