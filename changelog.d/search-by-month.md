### Search reads your mail month by month for relevance and oldest first

On ohmail Cloud and your own server a search now reads a word's matches one month at a time and stops once
it holds its page, where it read far more of them before: relevance answers a word in most of your mail for
about what a rare one costs, and oldest first no longer reads every match of a broad word. Every answer is
the one it was, letter for letter. Newest first, the sender and mailbox orders, and every order beside an
excluded word read as they did.

Each search document now carries the month its letter is dated in. The worker gives the documents
written before this release theirs in the background, a thousand a cycle at most, so the database is
never rewritten in one go; until an account's all have one, its search reads as before. Setup builds the
four dated search indexes once every account's documents have their month (the first setup after that:
your server's next start, or the next upgrade), without locking a table. They take about as much space
again as the search indexes beside them.
