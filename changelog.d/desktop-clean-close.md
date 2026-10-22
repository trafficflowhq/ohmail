### Closing the desktop app on a slow mail server no longer leaves the mail store to be recovered

On a mail server slow to answer, closing the desktop app could take longer than the five seconds the app
waits for its engine, so the engine was stopped before its local mail store had closed, and the next start
had to recover the store. The store now closes first and the goodbyes to the mail server run beside it,
so an ordinary close finishes inside those five seconds. An organizing install that is closed in the
middle of a sync still hands the mailbox back, so your other install can take over at once.

A message you send just before closing still goes out. If it has gone within the first two seconds of the
close it is recorded as sent at once; if not, the app checks your Sent folder for it as soon as it starts
again, as it now does for any message a crash left reading "Sending…", instead of waiting ten minutes.

A mailbox you remove just before closing no longer keeps its mail on this computer: the removal clears the
mail first, and one that a close, a crash or an older version left unfinished is finished when the app
next starts. Removing such a mailbox again now clears its mail too.
