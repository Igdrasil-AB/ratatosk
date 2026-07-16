# Testing a vendor live

Fixture tests prove mapping and engine behavior. They cannot prove that a current
vendor endpoint, browser auth flow, or bot-protection rule still works. Complete
this test before naming a vendor as supported in a release.

Use a dedicated vendor test account with synthetic, non-sensitive invoices. Do
not use a personal account, customer account, production token, or real financial
document in screenshots, logs, fixtures, or issue reports.

## 1. Build and load Collector

```bash
npm run ci
npm run build:collector
```

Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and
select `dist/collector`.

Confirm the loaded manifest has no `debugger`, `tabs`, `activeTab`, `cookies`, or
`<all_urls>` permission. Do not load `dist/studio` for the consumer test.

## 2. Choose a destination

Collector intentionally has no default destination and will reject a vendor
connection until one is confirmed.

- For a local test, choose the Downloads destination and a dedicated Ratatosk test
  folder. The documents will be written to disk.
- For an Igdrasil test, use the connect flow on
  `https://accounting.igdrasil.se` and a dedicated test company.

There is no dry-run fallback: a successful run delivers documents to the selected
destination.

## 3. Connect and exercise the vendor

Open the popup and connect the vendor.

1. Review and grant only the vendor host prompt.
2. Sign in to the dedicated test account in the same Chrome profile.
3. Run collection and confirm exactly the expected synthetic documents arrive.
4. Run again and confirm those documents are not duplicated.
5. Sign out of the vendor and run again; confirm `Reconnect` and the notification.
6. Disconnect the vendor and confirm Chrome revoked its optional host permission.

## 4. Inspect extension logs safely

Open the Collector service-worker console from `chrome://extensions`. Confirm the
typed outcome and HTTP status without copying response bodies or tokens. Redact
account ids, invoice ids, URLs, and financial fields before attaching logs to an
issue.

## 5. Verify persistence and failure behavior

- Turn the schedule off, restart Chrome, and confirm it remains off.
- Deny a host prompt and confirm the vendor remains disconnected.
- Disconnect Igdrasil and confirm the destination clears; another vendor must not
  run until a destination is selected again.
- Simulate a destination failure and confirm the invoice is retried rather than
  marked collected.
- Simulate one failed account scope beside one successful scope and confirm the
  popup says `partial`, including only bounded failed/empty scope counts.
- Simulate HTTP 429 and confirm automatic and manual runs remain skipped until
  the persisted per-vendor eligibility time; another vendor must still run.
- Use **Copy diagnostic** on a non-OK vendor and inspect the JSON. It may contain
  only vendor ID, Collector/lifecycle revisions, stable outcome code, timestamps,
  and counts—never URLs, headers, bodies, invoice/company IDs, or tokens.

## 6. Record the verification

Record the Chrome version, Ratatosk commit and package checksum, vendor name,
test date, destination mode, and pass/fail for fetch, download, de-duplication,
expired-session handling, and disconnect. Do not record secrets or actual invoice
content.

After storing the private test record, update `src/vendors/lifecycle.ts` using
only a sanitized `pr:`, `release:`, or opaque `receipt:` reference. Set the next
review date according to the release policy and run `npm run validate:release`.
The public manifest is release metadata, not a place for captured evidence.

The full pre-release flow is in `store/release-checklist.md`.
