### Erasing a mailbox frees its storage on ohmail Cloud

On ohmail Cloud, "Remove and erase" deleted the mailbox's letters but left their size on the account's
storage count. The count then stayed too high for good, and once it neared the plan's limit ohmail emptied
the text of older letters in the mailboxes the person kept, to make room it did not need. Erasing a mailbox
now takes its letters off the count, the background trim waits while an erase is still running, and for an
account that has erased a mailbox the count is checked against the stored letters before any text is
emptied. The release recounts those accounts too. The letters themselves always stayed complete on the
person's own mail server.
