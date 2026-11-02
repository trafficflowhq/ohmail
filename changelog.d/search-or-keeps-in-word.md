### A search with "or" keeps the letters each word finds inside a longer word

A search with `or` now finds, for each of its words, every letter that word finds alone: inside a sender's
address, at the start of a longer word and in a file name. Before, `mail or zzzqx` missed the letters
`mail` finds only inside a word such as `webmail`, and `mail or -thanks` listed fewer letters than
`mail -thanks`. On ohmail Cloud, your own server, the desktop and the phone.
