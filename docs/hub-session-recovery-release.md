# Hub session recovery: release and rollback (CAAH-108)

CAAH-108 keeps a Hub session through Hub outages and ends it only on a documented Hub denial ([Hub policy](hub-auth.md#hub-policy) lists them). It replaces the per-session row lock held across Hub calls with a refresh lease, and stores a rotated grant before verifying it. This page covers deploying and reverting it. Prove it on staging first with the [staging smoke](hub-session-recovery-staging-smoke.md).

## Migration

`20261105120000_hub_session_refresh_lease` adds one nullable column:

```sql
ALTER TABLE "hub_session" ADD COLUMN "refreshLeaseUntil" TIMESTAMP(3);
```

Apply it with the normal migration step (`pnpm db:migrate`, or `pnpm --filter @cortexai-agent-hub/api db:deploy` in containers) before any new API or worker process starts. It is additive and nullable, so existing rows need no backfill and the previous release keeps working against the migrated schema.

New processes read `refreshLeaseUntil` on every Hub session check and write it on every refresh. Against a database without the column every check fails and answers `503`, so never roll the binaries forward without the migration.

## Deploying

1. Apply the migration.
2. Roll out the API and the worker together and finish the rollout promptly.
3. Check that `/internal/health` is `ok` on every API process and that no `hub_session_unavailable` warnings appear while Hub is healthy.

**Mixed-version hazard.** Until every API and worker process runs the new release, an old process still deletes the session on any Hub error during verify or refresh, including timeouts and `5xx`. A user whose request lands on an old process during a Hub blip can still be signed out. The two releases also serialize refresh differently (old: a row lock; new: the lease), so an old and a new process can both refresh the same expired grant. Hub spends the token for the first, and the second gets `401 refresh_failed` or `400 invalid_grant`. A new process then keeps the session when the stored grant has already changed, but an old process signs the user out. Production deploys run the previous and new API side by side for a few seconds, so expect this only in that window. Do not rely on keep-session behavior until the rollout has finished.

## Rolling back

- **Reverting the binaries** to the previous release without reverting the migration is safe. The previous release ignores `refreshLeaseUntil`. Users then get the old behavior back: any Hub error signs them out again.
- **Dropping the column** while any new process is still running is not safe: their session checks fail with `503` until they are stopped. Drop it only in a later deploy, after no running release reads or writes it, as with any column removal.
- A lease left set by a process that stopped mid-refresh expires on its own after 30 seconds. No manual cleanup is needed.

## Known limitation: a lost refresh response signs the user out

Hub rotates the refresh token on every refresh and refuses the old one. If Hub rotates but Agent Hub never stores the new grant (the response is lost to a timeout or a dropped connection, or the process stops between the reply and the write), the stored token is already spent. The session is kept for that request, but the next refresh gets `401 refresh_failed` (or `400 invalid_grant`), which is a documented denial, so the user is signed out and must sign in again.

Agent Hub cannot recover this on its own without treating a real revocation as an outage. Closing it needs Hub to tolerate reuse of the previous refresh token for a short grace window, or to return the grant it just issued when the same token is replayed. That is a Hub change and is not part of this release. Until it lands, the expected impact is an occasional extra sign-in after a Hub timeout during refresh.

When storing a rotated grant fails after Hub issued it, Agent Hub revokes that grant at Hub (best effort) and keeps the session, so the next request retries with the stored token and hits the same limitation.
