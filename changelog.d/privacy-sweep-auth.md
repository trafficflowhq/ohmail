### Signing out closes the mail at once, and sign-in records stay bounded

On the web app and ohmail Cloud, pressing Sign out now marks the browser as signing out before the
server has answered, so for the few seconds the request takes no page opened in another tab shows the
mail, and the browser's other tabs close theirs at once. A tab that missed the news (a frozen tab, or
a browser without the channel tabs talk over) closes the mail the moment it is looked at again when
the browser no longer names its account, without waiting for the server. A tab that closes because
another tab signed out now also forgets its own notes for the session.

A device slowed by the sign-in limit for an address is no longer locked out for its own refused
attempts: a refusal from that limit no longer counts as a wrong password from that device.

On ohmail Cloud, the page that confirms a computer's sign-in in the browser now also says the request
came from a different network address when the computer and the browser reached ohmail over different
kinds of address (IPv4 and IPv6), and reads every spelling of an IPv4 address inside an IPv6 one as that
IPv4 address.

Deleting an account no longer fails when a verification link or a pairing code is created for it at the
same moment; that request fails instead. The hourly clean-up of old sign-in records and sign-in limits
now deletes in bounded steps, so a large backlog can no longer stop it from finishing.
