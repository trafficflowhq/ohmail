### A self-hosted server behind your own terminator needs OHMAIL_TLS_TERMINATOR set before you update

If your server sits behind a TLS terminator of your own (`OHMAIL_EXTERNAL_TLS=1`), set
`OHMAIL_TLS_TERMINATOR` in `.env` before you update: the proxy and the server no longer start without
it, and each says why. `OHMAIL_TLS_TERMINATOR=gateway` keeps what an empty value did, for a terminator on
the same box that sets `X-Forwarded-For` while `OHMAIL_BIND` stays on `127.0.0.1`. Name your terminator's
addresses when it runs anywhere else, or set `0.0.0.0/32` for a relay that adds no forwarded address
([the VPS guide](docs/self-host/VPS.md) has all three). An empty value used to trust the stack's network
gateway, which every connection through a published port arrives from, so a visitor could choose the
address the server recorded for them: lock that address out of an account, or get past the per-address
sign-in limit.

`gateway` needs this release's `proxy/` directory and its images together: a server from an earlier
release refuses it as a word, not an address, and does not start. While `OHMAIL_IMAGE_TAG` pins an
earlier release, to stay on it or while this release's images are still publishing, write the gateway's
own address followed by `/32` instead, the `Gateway` that `docker network inspect ohmail_default` shows
(your `OHMAIL_PROJECT` in place of `ohmail`). Every version reads an address the same way; switch to
`gateway` once the images catch up.

A first start on a slow machine no longer fails and restarts while Postgres is still setting itself up:
the database reads healthy only once it takes connections on its final listener, and the server waits for
it, up to two minutes, before it migrates.

The self-hosted server now refuses to start while the key-retirement setting is set, and says how to undo
it: it cannot yet check that no stored secret still needs a retired key, and setting the retired keys back
keeps every stored secret readable.

A `.env` beside the compose file, which holds the encryption key and the database password, is now ignored
by git, so a `git add -A` in your clone no longer picks it up.
