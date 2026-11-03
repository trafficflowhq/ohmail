### A phone search for the start of a word no longer reaches words that only share its stem

On the phone, a search read the start of a word through its stem, so a name like `ines` was read as
the start of `in` and listed letters with an invoice, information or an `INV-` file name, and `amazing`
found `amazon`. The phone now reads the start of a word as you typed it, in index tables of its own
that it builds once from the mail already on it, and a whole word still finds its other forms. Searches
on a computer, on Cloud and on your own server were not affected.
