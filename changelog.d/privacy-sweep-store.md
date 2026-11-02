### A letter deleted on the mail server keeps only who it was from and to, and older deleted letters lose their words too

On Cloud, your own server, the desktop app and the phone, a letter deleted on the mail server or in another
mail app kept every line of its header after its text, preview and search words went. Now ohmail keeps only
who sent it and to whom, its subject and date, the letters it answered and whether it was an automatic reply,
besides the names of its files, how it was filed and which trackers were found in it. A letter that comes back
gets its whole header back. The away reply no longer answers a letter that was deleted before the reply went
out. Letters that left the server before this release lose their preview, their search words and the rest of
their header too, a few hundred at a time in the background.

While a mailbox's organizer finishes an Import settings press, the web, desktop and phone apps ask how it
stands with the settings' fingerprint in a request header instead of in the address they ask, so request logs
no longer hold it; an older server is still asked the old way. On the desktop app and the phone, a mailbox
that an earlier version removed loses the fingerprints of its settings from the device's records at the next
start.

On Cloud and your own server, Test connection counts its attempts per mailbox address under the server's
keyed hash, as sign-in already does, instead of a plain hash that could be reversed by guessing addresses.
