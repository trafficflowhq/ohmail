### The invitation page removes a signed-out browser's mail as it opens

On the web app on your own server, the page an invitation link opens asked whether this browser's sign-in still
held only once Create my account was pressed, so a browser signed out from another device kept its copy of the
mail while the page was open, and after it was closed without an account made. It now asks as it opens, as the
sign-in and sign-up pages do, and starts removing that copy at once. Create my account waits up to 15 seconds for
the removal before the invitation is used; a longer removal finishes in the background, or on the next ohmail page
the browser opens. A sign-out you asked for that the server never confirmed is now finished before the invitation
is used, and when the server still does not confirm it, the page says so and offers Sign out again.
