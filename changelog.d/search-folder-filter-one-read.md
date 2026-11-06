### Searching inside one folder is faster

A search limited to one folder no longer reads the folder state of every mailbox on the server. A word with few
matches is read from the search index, and a common word walks the folder's newest letters once for the whole
page instead of looking up every one of its matches. On a large mailbox such a search had taken up to one and a
half seconds, a word beside a minus word the longest; most now answer several times faster, on ohmail Cloud, your
own server, the web app and the desktop app. A very common word in a folder that holds few of your letters is
still read from the index and can take a few hundred milliseconds.
