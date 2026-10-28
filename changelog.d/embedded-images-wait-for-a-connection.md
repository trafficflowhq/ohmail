### Embedded pictures wait for a free connection instead of failing

Opening a conversation with several letters that carry embedded pictures could show "ohmail already has
this mailbox's connections open" in place of some pictures, because every letter asked for its pictures
at once and ohmail opens at most two connections to one mailbox. The apps now ask one mailbox for no
more than that, keep a free connection for the file you press, and wait when the mailbox is busy, so
the pictures arrive. A picture your mail server could not serve says so and is tried again on its own
a few times. On web, desktop and phone.
