### A transaction that loses its database connection writes nothing more

On ohmail Cloud and on your own server, when the database connection under a transaction closed while the
transaction was still at work (the database closes a connection whose transaction sat idle too long, for
one), the caller was told the connection was gone, but the work could go on writing on a new connection to the
database: alone, outside any transaction, or inside a transaction someone else had just begun there, which
it could then commit early or roll back. Such a statement is now refused before it is written, and nothing
of the lost transaction stands. A statement sent on a transaction after it has ended is refused the same
way, and so is one sent while the transaction's own commit or rollback is still on its way to the database:
such a statement was written after it, alone, and stood even when the transaction was rolled back.
