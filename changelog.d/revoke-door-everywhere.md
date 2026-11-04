### Every page removes the mail of a browser signed out from another device

On the web app, on ohmail Cloud and on your own server, a browser whose sign-in was ended from another device
kept its copy of the mail when it opened a page other than the mailbox or the sign-in page, such as account
setup, a desktop approval or the return from payment. Every page now starts removing that copy as soon as it
learns the sign-in was ended, and waits up to 15 seconds for the removal before it goes on; a longer removal
continues in the background, and one cut short by closing the page is finished by the next ohmail page the
browser opens. Signing in, creating an account (on the sign-up page or from an invite link) and confirming an
address now first wait, up to 15 seconds, to hear from the server whether the browser's sign-in still holds.
A sign-in made while the copy is being removed, as the same account or another, keeps its own mail.
