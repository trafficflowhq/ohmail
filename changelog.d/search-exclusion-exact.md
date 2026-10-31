### A left-out word no longer loses a sender's first name in search

A search for a sender's first name the english stemmer shortens, such as Ines or Tomas, beside a left-out
word (`ines ledger -pdf`) or in quotes (`"ines varga"`) found the letters only as close words; now it finds
them exactly, as the same search without the left-out word does. `-ines` now also leaves out the letters
Ines sent. On ohmail Cloud, your own server and the desktop app; the phone already found them.
