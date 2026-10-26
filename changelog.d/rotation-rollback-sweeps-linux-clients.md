### Fewer sign-outs after a crash or a forced restart

After a crash, a power cut or a forced restart, the desktop app or the browser could come back with a
sign-in that had already been replaced. The server refuses such a sign-in the way it refuses a stolen
one, so you had to sign in again.

The desktop app now writes each renewed sign-in to the disk before it uses it. On the web, tabs that come
back together, after a restart or a sleep, renew the sign-in once instead of once each, which leaves much
less for a crash right after to undo (desktop, web, Cloud, your own server).
