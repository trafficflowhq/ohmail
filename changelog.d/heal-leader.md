### One organizer fetches mail, also when its database connection goes silent

On ohmail Cloud and on your own server, the organizer holds a lock in the database so that only one process
fetches and files mail. A connection that stayed open while nothing answered on it never told the organizer
that its lock was gone. A second organizer could then take over while the first went on fetching, and the
first could push the second aside again. An organizer that cannot confirm its lock for three of its checks
(thirty seconds as shipped) now stops fetching, gives way, and takes the lock again by itself when it can.
Once another organizer has taken over, the earlier one can no longer write mail or take over again without
the lock. Stopping or restarting the organizer no longer waits on a connection that does not answer.

Two settings of the organizer are checked at its start, and a value outside is refused by name:
`TF_LOCK_HEARTBEAT_MS` must be between 1000 and 40000, `TF_STANDBY_RETRY_MS` at most 60000. In the
`worker_heartbeats` table, `instance_id` now ends in a short suffix that is new at every takeover.
