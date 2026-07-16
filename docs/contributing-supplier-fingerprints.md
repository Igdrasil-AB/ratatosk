# Contribute supplier fingerprints safely

A capture mission asks an already-authorized account holder for a small,
structural description of a supplier billing portal. It does not grant access,
and it is never a request to share an account, password, 2FA code, invoice, raw
log, or customer data.

## Before claiming

- Claim only a mission for a supplier account you are authorized to use.
- Prefer a dedicated browser profile and a supplier test account containing
  synthetic or non-sensitive test documents.
- Do not create a paid account or purchase anything only to complete a mission.
- If the mission's origin is not exactly the portal you control, stop and ask the
  Svala developer who created it.

An agent or remote computer cannot replace you here: the supplier session stays
in your local browser, and only an authorized person can decide whether the
account may be observed and whether the structural result may be shared.

## Complete a mission

1. Claim the mission in authenticated Svala. Copy the one-use `rmc_…` code when
   it is shown; Svala stores only its hash and cannot show it again.
2. Install the reviewed Ratatosk Studio developer build in the dedicated profile.
3. Pair Studio with the scoped, upload-only Svala token provided for the pilot.
4. Paste the mission code into Studio and inspect the exact origin and actions.
5. Open that exact HTTPS origin. Studio refuses to start on a different origin.
6. Read the normal capture disclosure and check authorization consent yourself.
   A mission never starts recording or checks consent automatically.
7. Perform only the displayed bounded actions. Use a synthetic document when a
   document action is requested; skip the action if none is safely available.
8. Stop recording, inspect the exact structural fingerprint, and separately
   approve sharing only if it contains no sensitive naming you do not intend to
   share.
9. Explicitly deliver the saved item. Manual JSON export remains available.

If a developer will author a new Collector recipe from the capture, separately
download the **redacted agent report** before leaving the result screen and send
it through the approved private development channel. A structural fingerprint is
deliberately insufficient to reconstruct exact billing endpoints: it excludes
the request templates and response fixture needed to prove that a recipe works.
The richer report is never delivered with the fingerprint and must not be
committed to this public repository.

## What crosses the boundary

Studio may share normalized origins, methods, path shapes, query-key names,
content types, response statuses, safe operation names, inferred field paths,
and aggregate confidence/counts. Its shareable schema excludes request and
response bodies, header values, cookies, bearer credentials, query values,
fixtures, invoice IDs, dates, amounts, currencies, document URLs, and customer
details.

## Stop, withdraw, and retention

Stop recording at any time to delete the temporary capture session. Removing a
mission from Studio stops using it locally; withdraw an open or claimed mission
in Svala to revoke it server-side. Disconnecting Svala removes the upload token
from Studio. Approved local outbox items expire after 30 days or can be cleared
immediately. Svala retains an accepted structural submission and its audit-safe
receipt according to the internal development evidence policy.

A receipt means only that Svala validated and stored the structural envelope for
review. Statuses such as `needs another capture` and `accepted for review` do not
promise that a recipe will be published or that the supplier is supported.
