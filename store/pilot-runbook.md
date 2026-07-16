# Unlisted Collector pilot runbook

This runbook prepares the pilot but does not authorize Web Store submission,
reviewer credential distribution, or tester invitations. Those actions require
an explicit operator decision.

## Private evidence record

Keep one private record per supplier and test session. Record only Collector
version/checksum, commit, Chrome major, timestamp, destination mode, stable
outcome code, pass/fail, and a sanitized `receipt:` reference. Do not copy raw
logs, URLs, account/company/invoice IDs, documents, headers, cookies, or tokens.

Exercise: deny/grant permission; first collection; duplicate rerun; sign-out and
reconnect; destination failure; disconnect/revoke; schedule-off restart; local
destination; dedicated Igdrasil test company; support request; deletion request.

## Operator checkpoints

1. Complete current synthetic live attestations in `src/vendors/lifecycle.ts`.
2. Run `npm run validate:release`; stop if any claim is stale or unverified.
3. Build from the reviewed commit and replace template hashes/commit/window in a
   private pilot manifest.
4. Run `npm run validate:pilot -- <private-manifest.json> --ready`.
5. Confirm legal/support ownership, publisher/trader identity, verified domain,
   private reviewer account, regions, and Unlisted distribution.
6. Ask the operator for explicit submission approval. Do not infer it.

## Rollback and stop policy

Stop invitations and disable the listing if a high-severity issue appears, a
supplier claim becomes stale/degraded, permissions differ from the reviewed ZIP,
or support/privacy ownership lapses. Retain the previous known-good ZIP and
checksum before submission. Moving from Unlisted to Public requires a separate
plan and explicit decision; it is never a pilot side effect.
