### A downloaded attachment is no longer served from the browser cache to the next account

On the web app (ohmail Cloud and your own server), an attachment's bytes were kept in the browser's cache for an
hour without being tied to the session, so after a sign-out and a different account's sign-in on the same browser
the same attachment link could in a narrow case still be answered from that cache. Attachments are now keyed on the
session, as remote images already were.
