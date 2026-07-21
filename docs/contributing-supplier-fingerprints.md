# Contribute a supplier safely

If a supplier is missing from Ratatosk Collector, you can help developers
understand its billing portal without giving anyone access to your account.
Collector links to this repository from its Vendors screen; no Svala account or
special contribution code is required.

## Before you start

- Use only a supplier account you are authorized to inspect.
- Prefer a dedicated Chrome profile and a supplier test account containing
  synthetic or non-sensitive test documents.
- Do not create a paid account or purchase anything only to contribute a
  supplier.
- Never post invoices, receipts, passwords, cookies, tokens, raw network logs,
  downloaded reports, or supplier fingerprint JSON in a public GitHub issue.

An agent or remote computer cannot replace the account holder here: the supplier
session stays in the local browser, and only an authorized person can decide
whether the page may be observed and whether the resulting structural data may
be shared.

## Request or investigate a supplier

1. Check Collector's Vendors screen to confirm the supplier is not already
   available.
2. Open the [Ratatosk repository](https://github.com/Igdrasil-AB/ratatosk) and
   create a supplier request containing the public supplier name. Include an
   origin only when it is the canonical, vendor-wide public origin (for example,
   `https://billing.vendor.example`). Never paste the active tab's tenant-,
   workspace-, account-, customer-, or employee-specific host (for example,
   `https://acme-customer.vendor.example`) or an internal hostname. Do not try to
   anonymize such a host by editing it: omit the origin instead. If you cannot
   confidently distinguish a public vendor origin from an identifying one, open
   a [private GitHub security advisory](https://github.com/Igdrasil-AB/ratatosk/security/advisories/new)
   with the supplier name only and ask a maintainer to arrange a safe channel;
   do not attach the origin or capture data yet. This lets maintainers confirm
   whether an investigation is useful before anyone records a page.
3. If you are helping with the technical investigation, install the reviewed
   Ratatosk Studio build described in the repository README.
4. Open the supplier's billing page in the dedicated profile, read Studio's
   capture disclosure, and confirm authorization yourself.
5. Record only the smallest safe billing flow. Use synthetic documents when
   possible, then stop and inspect both outputs locally.
6. Share the structural fingerprint or richer redacted report only through a
   private channel agreed with a Ratatosk maintainer. Never attach either file to
   the public repository.

Studio never starts recording or approves sharing automatically. Its normal
consent, review, and local-download flow remains the only capture path.

## What a fingerprint can contain

The shareable fingerprint may contain normalized origins, HTTP methods, path
shapes, query-key names, content types, response statuses, safe operation names,
inferred field paths, and aggregate confidence or counts. Its schema excludes
request and response bodies, header values, cookies, bearer credentials, query
values, fixtures, invoice IDs, dates, amounts, currencies, document URLs, and
customer details.

Origins and schema names can still reveal tenant or internal naming chosen by a
supplier, so inspect the exact preview before approving it. Approval for private
Svala intake does not make an origin safe to copy into a public issue.

## Stop and retention

Stop recording at any time to delete the temporary capture session. Approved
local outbox items expire after 30 days or can be cleared immediately. Disconnect
Svala in Studio if an internal maintainer paired the browser with a scoped intake
token. A successful intake receipt means only that a structural submission was
accepted for developer review; it does not promise that the supplier will be
published.
