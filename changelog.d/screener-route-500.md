### A Screener decision no longer fails while ohmail is filing your mail

On ohmail Cloud and your own server, letting a sender in or screening one out could fail on the server while
ohmail was filing mail in the same mailbox, often the letters of the decision made just before. The decision
stayed on screen and went through on its own 30 seconds to two minutes later, and its letters moved that much
later. Releasing held mail could fail the same way.

A decision could also fail as ohmail finished a pass over your mailboxes, or beside a Pull new mail, a Move to
Junk or the reopening of a closed account. Adding, pausing or removing a rule, or changing When a sender goes
quiet, could fail while ohmail filed mail in a mailbox another install organizes. All of these now wait for
each other instead.
