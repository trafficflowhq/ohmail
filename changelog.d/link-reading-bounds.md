### The link label tests no longer fail on a busy machine

Five tests that hold the reader's link check to a linear read timed it against a plain letter, so a loaded
test machine could fail them on code that was no slower. Four now count the work instead: a label of a
thousand pieces must be read at most a few times over, a link that holds forty nested links reads its
label once, a letter of 2,000 hiding rules may match at most 32 of them, and a rule too costly to match
(a word-list test, more than four parts or 64 characters) is never matched. The fifth, 100,000 bidi
controls left open, has a ceiling of ten seconds where one pass takes well under a tenth of one. Breaking
any limit still fails them on any machine. Measured on letters up to the 512 KiB cap, a linked label costs
about what the same text costs outside a link, and the check's time does not grow with the number of rules.
