# Supplier fingerprints

Ratatosk Studio can turn an authorized billing-page recording into a small,
versioned supplier fingerprint. The fingerprint helps developers recognize
request shapes and draft a new supplier recipe without receiving the recorded
account's invoices or credentials.

## Data flow

1. Studio records one authorized page into temporary session storage.
2. The recorder infers a draft locally.
3. A separate builder projects only structural facts into
   `ratatosk.supplier-fingerprint.v1` and validates the result.
4. Studio shows the exact fingerprint. The user separately confirms authority
   and approves saving that preview for Svala.
5. The approved `ratatosk.supplier-fingerprint-submission.v1` is kept in a local
   outbox (20 items maximum, 30-day validity), remains visible after the popup is
   reopened, and can be downloaded again as JSON until it expires or is cleared.
6. Today, a developer imports that JSON into a Svala task's **Context docs**.

There is no configured network destination in this version. The extension does
not attempt automatic delivery. A future Svala transport implements the existing
transport interface after its endpoint, authentication, replay, and deletion
policy are chosen; the fingerprint and consent contracts do not need to change.

## Included

- supplier and document origins;
- HTTP methods, normalized path patterns, query parameter names, response status,
  and base content type;
- safe GraphQL operation names;
- inferred list, field, authentication-template, pagination, and document shapes;
- aggregate request/document counts and inference confidence.

Unknown path segments become `{id}`. Query parameter values are never included.

## Excluded by schema

- request and response bodies;
- headers, cookies, bearer tokens, and API keys;
- query values and URL credentials;
- fixtures and generated recipe objects;
- invoice IDs, dates, amounts, currencies, document URLs, and customer details
  contained in captured values;
- email addresses and JWT-like strings.

Both Studio and Svala strictly reject unknown fields, unsafe literals, oversized
payloads, unsupported schema versions, and consent envelopes whose previewed ID
does not match the included fingerprint. Svala's manual import requires the
approved submission envelope and converts it into a Markdown context document
through its existing authenticated developer workflow. The envelope records a
user assertion; it is not a cryptographic signature. A future authenticated
transport must provide server-verifiable uploader and company attribution.
Expired outbox records are discarded whenever Studio starts or reads the outbox.

Origins, query-key names, GraphQL operation names, and inferred schema paths are
structural but can still contain tenant or internal naming chosen by a supplier.
The user must inspect the exact preview. Do not commit fingerprint JSON or agent
reports to this public repository; import approved submissions into private Svala.

## Why local installation does not prevent future delivery

A locally installed Chrome extension can make an authenticated HTTPS request if
its manifest and runtime policy allow the destination. It cannot give Svala
access to browser-local storage by itself. Automatic collection therefore needs
an explicit extension transport plus a user/company authentication design. The
local outbox provides retryable state without committing this release to an
endpoint prematurely.
