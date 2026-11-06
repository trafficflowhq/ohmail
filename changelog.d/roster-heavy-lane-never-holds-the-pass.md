### New mail keeps arriving within seconds while a large mailbox is being added

While a mailbox with a long history was being added, every other mailbox on the same server could wait about a
minute for its new mail, because the large mailbox's import took long turns and the others waited for them to
end. The import now works in turns of about two minutes, and the other mailboxes keep being checked while it
runs, including one that is catching up on a large change of its own. When the account already has other
mailboxes, the import takes turns of about 25 seconds instead, so those mailboxes get their new mail too; that
import runs somewhat slower. Otherwise the large mailbox imports about as fast as before. This applies to ohmail
Cloud and to your own server.
