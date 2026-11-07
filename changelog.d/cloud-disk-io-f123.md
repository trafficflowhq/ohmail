### The Cloud worker reads far less from the database while a large mailbox is being imported

While a large mailbox is being imported, the Cloud worker no longer re-reads the whole mailbox on every
pass to look for letters removed from the server: it looks after a removal, on a new connection and at
least once an hour. The check that gives a letter moved out of Junk in another mail app its text back now
runs every 15 minutes instead of on every pass; moving a letter out of Junk in ohmail still restores it at
once. The worker's in-memory list of known letters is now sized from the memory the worker actually has, and a
mailbox too large for that list no longer stops importing new letters.
The organizer image now sets its memory ceiling at start to half the memory its container may use, between
512 MB and 2 GB, where it was always 512 MB; a `--max-old-space-size` you set in its `NODE_OPTIONS` still wins.
Automatic suggestions and filing in the Screener only consider letters the mail server still holds.
This applies to Cloud and to your own server.
