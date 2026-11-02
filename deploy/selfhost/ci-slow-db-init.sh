#!/bin/sh
# The CI overlay's slow first start (docker-compose.ci.yml): Postgres's init holds its final listener back this long.
sleep 10
