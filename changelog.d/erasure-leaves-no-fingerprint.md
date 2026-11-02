### Erasing a mailbox takes the fingerprint of its saved settings too

Remove and erase now also takes the fingerprint of the mailbox's saved settings (a hash of the whole
settings copy, its signature included) off the account's history: the record of a settings copy ohmail
found in the mailbox, your answer to it, and an Import settings press handed to the organizer. Before,
those rows kept it for up to a year after the erasure; mailboxes erased before this update lose it on
the server's next erasure pass, and removing a mailbox from a computer takes it off that computer's
store. A settings card still open for an erased mailbox can no longer record an answer for it.

The limits on sign-up, email verification, desktop sign-in and waitlist attempts per connection, and on
how much mail ohmail sends one address, now store the connection's IP address and the recipient only as
a hash keyed with the server's own encryption key, as the sign-in limits already did, never as a plain
SHA-256 that a guess can reverse. Your own server needs no new setting; these counters start over once
when the update is deployed. Cloud and your own server.
