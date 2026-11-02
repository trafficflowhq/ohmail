### ohmail clears out its own old settings copies that a mail server kept

Some mail servers kept every copy of your settings that ohmail builds before 0.30.21 failed to save, so a
mailbox could hold hundreds of them in ohmail's settings folder, and ohmail kept them all as if another device
had left them. On the desktop, the phone and your own server, ohmail now reads them as its own and clears them
out. Settings another phone or computer left behind are still kept and asked about, never removed, also when
they sit behind hundreds of such copies: before, they could be deleted without a question. On ohmail Cloud
too, a mailbox holding many of ohmail's own copies no longer has ohmail ask you to import its own settings
after a restart, or hold back a change you made since, also once those copies are more than a year old.
