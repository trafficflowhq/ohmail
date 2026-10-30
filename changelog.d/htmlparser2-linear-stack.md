### A letter with deeply nested html no longer stalls mail sync

The html parser ohmail reads letters with (htmlparser2) kept the elements a letter had opened in a way
that slowed down with every level of nesting. A letter built to nest tens of thousands of elements, or to
close many that were never opened, could hold the mail sync for 2 to 21 seconds while its text was
read, and on Cloud that delay held up other mailboxes on the same worker too. The phone's message view
spent up to 4.6 seconds cleaning such a letter, and search indexing up to 0.75 seconds. ohmail now carries a
fix to the parser that makes this cost grow in step with the letter's size, so the same letters take
milliseconds. Ordinary mail reads exactly as before. On every app: desktop, web, phone, Cloud and your own
server.
