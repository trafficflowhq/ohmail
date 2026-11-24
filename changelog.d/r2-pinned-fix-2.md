### Requests made for a letter or a device go only to the address they were checked against

ohmail fetches a few addresses that a letter or a device names: a remote picture, a one-click unsubscribe,
a new-mail wake for your phone. It checks each address before it connects, and connects only to the
address it checked. A connection left open by an earlier request to the same name could still carry a
later request to the earlier one's address, which the later request's own check had never seen. On ohmail
Cloud, your own server and the desktop app, every such request now opens its own connection and closes it
when it is done.

When a picture's server answers with something that is no web answer at all, or with a certificate chain
that cannot be verified, the picture shows as one that could not be loaded, as it did before, and ohmail
Cloud and your own server no longer count it as a fault of their own.
