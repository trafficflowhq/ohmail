### The Linux desktop window no longer freezes when an accessibility client is slow to answer keys

On the Linux desktop app, with a screen reader or another accessibility client running, the window could stop
repainting for good while you typed: each key waited on the accessibility service, and keys arrived faster than
it answered. Keys are now offered to accessibility clients within a time budget. A client that answers in time
still gets every key; one that answers late stops getting keys for a few seconds, and longer each time it stays
late, so the window keeps answering you.
