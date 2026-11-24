### A search by recipient reads a key each letter carries

In ohmail 2.0 every letter carries the key a search by recipient looks for: its account and each To and Cc
address, in lower case. The database writes it when the letter is stored and whenever its recipients change, and
nothing else can. A search by To, or by an address on either side, reads that key from the letter instead of
working it out letter by letter, and a search by filters alone looks through as many letters at a time whatever
it filters by, so old letters to someone show up in fewer steps.

On your own server, the move to 2.0 at its first start writes the letters' table once more to store the key:
about ten seconds for 400,000 letters on a fast workstation, and about 160 bytes a letter. If the search index 1.0
keeps is missing or was renamed, the server stops before it changes anything and names it: start 1.0 once more,
which builds the index again, then start 2.0. On a phone nothing is
rewritten, and a search by filters alone looks through as many letters at a time there too.
