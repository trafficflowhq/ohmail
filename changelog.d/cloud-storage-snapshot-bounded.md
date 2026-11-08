### Cloud shows the storage estimate for very large mailboxes, never below what is kept

On ohmail Cloud, the figures behind what your mailboxes need were counted in one long read per account,
which gave up on very large mailboxes, so Settings → Storage had no estimate for them. They are now
counted a mailbox at a time in short steps, and a mailbox that has not changed is not counted again, so
the estimate appears for every mailbox, the largest included.

The estimate could also read below what ohmail already keeps, for example while deleted letters still
held their text, or above it once every letter was in, when one mailbox's letters were smaller than the
others'. A mailbox is now never expected to need less than it keeps, and once every letter is in the
estimate is what ohmail keeps. Letters still to come are counted at their own mailbox's average size.
