### A sign-out, and a sign-in after one, end the previous session on the server

Signing out of the phone, or of a browser paired with your computer, now ends the session on the server
also when the device never received the answer to its last session renewal; before, that sign-out ended the
session on the device only, and it stayed valid on the server until it expired. Signing in again on the
desktop after a sign-out the server never heard, or over a saved sign-in the app can no longer open, now
ends the desktop's previous session there.

While a sign-out in the browser has not finished, opening the account page goes to the sign-in page, which
finishes the sign-out, instead of opening the account page of the person who signed out. And a session
renewal that answers a token again, after a lost answer, never hands the session to a browser or device
signed in to a different account. Desktop, web, phone, ohmail Cloud and your own server.
