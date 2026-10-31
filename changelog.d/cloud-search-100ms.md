### Search answers sooner on Cloud, and a broad word's count no longer takes seconds

On ohmail Cloud every search answer now leaves for the database in one flight: the transaction's
start, its settings and the read go together, and the end is sent after the answer, so a page waits
one round trip to the database instead of three.

On Cloud and your own server, the count and facets after the first page read at most 2,000 matches a
part of the query. Up to that the count is exact; past it the search says "at least 2,000" and the
facet chips show no numbers. The address view counts exactly up to 10,000 letters, then says "at
least 10,000". A word in most of your mail could hold a search for 10 to 24 seconds before.

Which orders got faster: relevance, the default, whose page reads what it read before, in that one
round trip on Cloud, and newest first, which now reads the newest letters and stops at its page,
unless the search excludes a word. Unchanged: oldest first, the sender and mailbox orders, and newest
first beside an excluded word still read every match, and every order lists exactly the letters it
listed before.

No number a search shows is taken from the database's statistics any more: those cover every
account's mail, so another account's letters could move "about N" on yours. Each answer also carries
a `Server-Timing` header with where its time went, which never names what was searched for.
