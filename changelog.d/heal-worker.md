### The organizer waits out a database outage and resumes by itself

On ohmail Cloud and on your own server, the organizer (the process that fetches and files mail) used to
exit when it could not reach its database. A host that had stopped restarting it left mail unfetched until
someone started it again, also after the database was back. It now stays up, tries again until the database
answers, and carries on from there; a connection that is accepted and then never answered is given up after
a minute and dialled again. A lost leader lock ends the same way instead of ending the process, and
an organizer whose cycle has stopped moving exits so that its host starts it again. A refused credential, a
missing setting or a schema the build does not accept still stop the start at once.

Its health endpoint says which of these it is in, with status 503: `waiting_for_database` (and the seconds
it has waited), `database_fault` or `stuck_cycle`. A failed start is named there by its error class and
code, no longer by the driver's message.

The server now tells a signed-in app whether new mail is being fetched: `fetching` on each mailbox it
fetches, also one that another install organizes, and on the answer to a pull, with the time of the last
finished pass. The apps do not show it yet.
