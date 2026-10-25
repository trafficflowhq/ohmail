### A message sent just before closing keeps its Sent copy when the mail server was slow or had stopped answering

A message sent shortly after another one, while the mail server was slow or had stopped answering,
could go out without its copy in Sent if ohmail closed within the next seconds. It now waits the way
the first message does, and goes with its copy when ohmail starts again (desktop, and the phone on its
own). While the server stays silent, such a message is not sent, and ohmail says so.
