### The Screener's offer answers on a large account

The Screener offers to screen the Ohbox mail of senders you never decided about. To find it, the server read
the Ohbox letter by letter and asked about each one. On an account with tens of thousands of letters, most of
them from people already decided, that took longer than a request may last: the offer never came, and on ohmail
Cloud several of these reads at once kept the database connections of one server busy, so other requests were
answered "busy" and a send could be refused.

The read now goes by sender: it leaves out every sender you have decided about before it reads any mail, and
reads only the letters of the rest. One request reads for at most four seconds and says where it stopped; the
app asks on from there, so on a very large account the number appears as "at least" and grows instead of
failing. An app asks one such read at a time, and a server answers at most two of them at once, whoever asks.

On your own server and on the desktop and phone apps the same read is shorter for the same reason. A letter
whose From line names several mailboxes is no longer offered when the first of them is somebody you decided
about: the Screener's list would not have shown it.
