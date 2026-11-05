### Search reads `_` and `%` as typed, and a minus word no longer changes the count

On every app and store, an underscore, a percent sign or a backslash in a search is now that character:
`a_b` no longer finds `axb`, and `50%` no longer finds `500`. The same holds for the contact list's
search on the server. A new letter sent to a long list of people keeps its file names findable by
any part of them.

On ohmail Cloud and your own server, a minus word that leaves no letter out (`mail -zzzqx`, or
`mail or -zzzqx`) now gives the same "at least" count as the words alone, where it showed far fewer
for a large mailbox. A bare `or` beside a minus word (`mail or -thanks`) now ranks and counts the same as
`mail -thanks`, and its closest-word answer and first paint read it that way too.
