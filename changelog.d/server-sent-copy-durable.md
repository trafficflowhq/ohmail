### A letter delivered just before a restart or an IMAP outage reaches Sent once it can

When your mail server had accepted a letter but its copy could not be put in your Sent folder yet, Cloud
and your own server kept retrying only in memory, so a restart or a deploy at that moment lost the copy:
the letter went out but never appeared in Sent or its conversation. Now the copy is kept and filed once
your Sent folder takes it: on your own server for every letter, on Cloud for letters without attachments,
because Cloud never stores attachment bytes. While your mail server refuses every copy, for example a full
mailbox, the waiting copies are tried together after a minute, ten minutes, an hour, six hours and then
once a day, and a copy it refuses does not hold the others back. A refusal counts against a copy only when
the server says it is about that letter, for example that it is too large, or when your mailbox took
another waiting copy at the same time; after eight refusals that count, the copy is given up. Every copy is
kept for at most seven days: one that is still not in Sent by then is deleted. Each copy is filed once,
after a look in Sent.
