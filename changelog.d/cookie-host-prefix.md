### The web app's sign-in cookies can no longer be planted by a neighbouring site

The cookies that keep a browser signed in to the web app now carry the `__Host-` prefix: a browser keeps
them only from ohmail itself, over HTTPS, for the whole site and without a domain, so a site under another
name on the same domain can neither set nor shadow them. A signed-in browser moves over at its next session
renewal and is not signed out; the cookies it held before are expired as the new ones are written.

For your own server: this release is a floor. Rolled back to an earlier release after it has renewed
browsers, the server would sign those browsers out, so roll forward instead. Desktop apps older than 0.25.3
cannot complete a new password sign-in against it; sessions they already hold keep renewing. Web, ohmail
Cloud and your own server.
