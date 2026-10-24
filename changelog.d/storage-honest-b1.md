### ohmail Cloud checks its storage count before emptying older letters

On ohmail Cloud, an account at 90% of its plan's storage now has its count checked against the stored
letters once a day, before any older letter's text is emptied to make room. A count that had drifted above
the real total no longer empties the text of letters the person kept. For each account ohmail Cloud also
records how many letters' text it has emptied for space, when it last did so (and first, for accounts where
that happens after this release), and the month from which every letter still keeps its text. Letters that
arrive while the storage is full and are stored without their text are counted apart and never move that
month. The letters themselves stay complete on the person's own mail server.
