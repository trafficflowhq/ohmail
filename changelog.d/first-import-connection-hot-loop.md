### A connection lost during a large first import no longer ends the import early

On the desktop and the phone, a mail server connection that dropped between two commands of a large
mailbox's first import could leave the import marked complete with only part of the mail read, and the
rest was then treated as mail that arrived after the import. A lost connection now fails that pass, and
the import goes on over the next connection. A new connection that has served mail also counts as
reconnected at once: a drop after that retries at the first step instead of waiting longer each time, up
to five minutes, and the connection check now watches it even when the launch's own import was the one
cut off.
