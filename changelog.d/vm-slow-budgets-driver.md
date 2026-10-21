### A database outage no longer stops the worker or the self-hosted server

If the database closed a connection while ohmail was still opening it, the worker and the self-hosted server
could stop (when the next attempt was refused, or the database said it was starting up or shutting down), or try
again hundreds of times a second until the database was back. They now wait between attempts as for any other
dropped connection, and when the database gives a reason for the close, the work waiting for that connection
fails with it at once.
