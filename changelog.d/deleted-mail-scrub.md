### Older deleted letters lose their words on accounts that no longer sync too

On Cloud and your own server, the background tidy that empties letters deleted on the mail server before
0.30.31 reached only accounts with a mailbox that syncs. An account whose mailboxes were all disconnected with
their mail kept, or a closed account on Cloud, kept those letters' preview, search words, summary, tracker
address and the rest of their header. The tidy now reaches every account that still holds mail.
