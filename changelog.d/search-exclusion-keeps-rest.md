### A minus word only leaves letters out of a search

A word you exclude with a minus (`mail -thanks`) now only leaves out the letters that hold it. The
rest of the search finds what it finds on its own: `mail` inside a sender's address (`mailroom`,
`webmail`), a word's start, and a stopword such as `you` inside a subject. Before, any minus word
dropped those matches, so `mail -google` found far fewer letters than `mail`, though none held `google`.
The same holds for a minus word in parentheses (`mail -(thanks)`), for many minus words in one search,
for more than eight words beside a minus word, and beside `or`: ohmail Cloud and your own server now read
`mail or -thanks` as `mail` without `thanks`, as the desktop and the phone do, instead of listing every
letter without `thanks`.

A minus word beside only common words (`you -thanks`, `the -thanks`) or on its own (`-thanks`) no
longer makes the search fail on ohmail Cloud and your own server. A minus word on its own finds
nothing; the phone and the desktop no longer list every letter without it.

The list a device shows while the server answers leaves out the letters holding the minus word too,
and when your server answers a search with an error, the web app and the phone say it could not run
the search instead of saying it did not answer. The web app's count of a large search reads "at least
2,000 matched" with its thousands separator, as every other count does.
