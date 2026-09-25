# Five lessons from migrating to Postgres 17

We moved 40 services from MySQL to Postgres over six months. This post
collects what we learned.

## Plan the cutover

Dual writes ran for 3 weeks before we switched reads. Replication lag stayed
under 200 ms at the 99th percentile.

## Measure everything

- Query latency dropped 27% after enabling parallel sequential scans.
- Storage grew 15% because of wider indexes.

## Keep rollback cheap

> A migration you cannot roll back is a bet, not a plan.

Every step had a documented rollback, and we used it twice.
