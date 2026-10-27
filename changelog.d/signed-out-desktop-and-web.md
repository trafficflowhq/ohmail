### When ohmail Cloud ends your sign-in, the sign-in screen says so

On the web, a sign-in that ohmail Cloud had ended showed "Checking your sign-in…" and then the front
page, without a word. It now goes to the sign-in page, which says that you were signed out on this
browser, or that your sign-in here expired.

In the desktop app, the reason was lost when the app was restarted after ohmail Cloud ended its sign-in:
it opened on the sign-in dialog as if it had never been signed in. The dialog now says why at the next
start too (signed out from another device or after a security check, or expired after a long time
without use) until you sign in again, sign out yourself or switch to another account.

On ohmail Cloud, a desktop app signed in with version 0.11.0 or 0.11.1 was signed out after 60 days
without use, by the clean-up meant only for browsers. It now keeps its sign-in for 400 days without
use, like every desktop sign-in.
