### Forwarding a letter with a long run of blank lines or deeply nested quotes no longer stalls

Turning a letter's html into its plain-text half took seconds when a code block held a long run of blank
lines: 100,000 of them cost about six seconds before the forward or send went out. It now takes a few
milliseconds and gives the same text. A letter nesting thousands of quotes or lists no longer turns into a
text part hundreds of megabytes long, or fails to forward: the text shows at most 32 levels of `> ` and
of list indent, as the reader already does. This applies on the desktop, the web, the phone, ohmail Cloud and
your own server.
