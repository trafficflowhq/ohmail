### Safari no longer forgets a sign-out that is still owed

On the web app and ohmail Cloud, a sign-out the server could not confirm is finished on the next visit, at the
sign-in page. Safari drops what a page writes into the browser after seven days, and with it the note that a
sign-out was still owed, so a visit a week later could reopen the session that had been signed out of. From the next
page the browser loads, the server now sets that note itself, the way it sets the session, and the page no longer
writes over it, so from then on it lasts as long as the session could be resumed. Two smaller fixes beside it: the account name a sign-in leaves in the browser no longer
ends when the browser closes, and a session check that renewed the session while another tab signed out no longer
writes the account's name back.
