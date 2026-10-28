### The first sync after launch no longer holds the desktop app for most of a second

On a large mailbox the first sync after the app starts read every message location the mailbox holds in one
query, and the desktop app could not answer anything else while it parsed the result (74,000 locations held it
for about 0.9 s). The read now goes in pages of 5,000, so each pause is short (about 60 ms at that size), and
the desktop store takes the statistics that read needs once, so the pages use the index instead of sorting
the mailbox again for each one. The same paged read runs on the phone, the self-hosted worker and ohmail
Cloud.
