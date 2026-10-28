### Cloud can record how connecting a mailbox ended

On ohmail Cloud, each press of Test or Connect, and each start or finish of the Microsoft sign-in, can
leave one record of how it ended: which of these it was, the provider from the setup list or "another",
whether it worked, if not why as one word from a fixed list (such as a refused password or a server that
did not answer), which side refused (incoming or outgoing mail), and the time. A record holds no address,
no server name, nothing the mail server said, no IP address and no browser details. It is kept for 30
days and deleted at once with the account. Staff can read the counts and one account's records over the
console's content-blind connection, and nothing else of it.

Recording starts off: an operator sets `TF_CONNECT_ATTEMPTS=record` on the API once
[ohmail.app/privacy](https://ohmail.app/privacy) describes it. A self-hosted server and the desktop app
record nothing of the kind; a self-hosted server's next migration creates the table and leaves it empty.
