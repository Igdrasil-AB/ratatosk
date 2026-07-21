# Chrome Web Store submission process

This is the operational sequence for taking Ratatosk Collector from this repo to
an unlisted pilot and, later, a public listing. Complete the checkboxes in
`store/release-checklist.md` for the exact release commit.

## 1. Close the owner-controlled prerequisites

1. Have Igdrasil's legal owner review `PRIVACY.md`, then merge it so the public
   policy URL in `store/listing.md` resolves to the exact reviewed text.
2. Confirm `legal@igdrasil.se` and `support@igdrasil.se` are monitored.
3. Register the Chrome Web Store developer account, pay the registration fee,
   verify the account email, and complete identity and any applicable trader
   verification.
4. Verify ownership of `igdrasil.se` in Google Search Console so it can be used as
   the official publisher URL.

Official starting points:

- https://developer.chrome.com/docs/webstore/register
- https://developer.chrome.com/docs/webstore/set-up-account

## 2. Cut the reviewed Collector artifact

From a clean release commit on Node 22:

```bash
npm ci
npm run release:collector
COLLECTOR_VERSION="$(node -p "require('./package.json').version")"
COLLECTOR_ZIP="artifacts/ratatosk-collector-v${COLLECTOR_VERSION}.zip"
npm run verify:collector-artifact
unzip -l "$COLLECTOR_ZIP"
```

Upload only the exact path in `COLLECTOR_ZIP`, resolved from the reviewed
package version above. Do not upload the Studio ZIP, `dist/`, a GitHub source
archive, or the repository root.

The packaging command rejects a non-MV3 build, version mismatch, source maps,
unexpected Collector permissions, an optional-host envelope other than the
reviewed HTTPS discovery pattern, a changed Igdrasil content-script origin, or a
weakened CSP.

## 3. Complete the dashboard tabs

1. Create a new item and upload the Collector ZIP.
2. In **Store listing**, paste the product copy from `store/listing.md`, add the
   128x128 icon, at least one 1280x800 screenshot, and the 440x280 small tile.
3. Set the homepage, support URL, official verified site, language, and category.
4. In **Privacy practices**, paste the single-purpose statement, enter each
   permission justification, select every handled data category documented in
   `store/listing.md`, enter the public privacy-policy URL, and make the Limited
   Use certifications only if they still match the release.
5. In **Distribution**, choose only the intended pilot regions and **Unlisted**.
6. In **Test instructions**, adapt `store/test-instructions.md` with a current
   synthetic vendor account and exact expected result.
7. Save each tab, resolve every dashboard warning, and compare the dashboard copy
   one last time with the ZIP-root manifest.

Official dashboard guidance:

- https://developer.chrome.com/docs/webstore/cws-dashboard-listing
- https://developer.chrome.com/docs/webstore/cws-dashboard-privacy
- https://developer.chrome.com/docs/webstore/cws-dashboard-distribution
- https://developer.chrome.com/docs/webstore/cws-dashboard-test-instructions

## 4. Submit an unlisted pilot

Before opening the dashboard, complete the private manifest and operator
checkpoints in `pilot-runbook.md`; the repository template contains zero hashes
and is deliberately not submission evidence.

Submit the item for review as Unlisted. Do not change the ZIP, listing claims, or
privacy disclosures while the review is pending unless the submission is
cancelled and rechecked.

After approval, invite a small named pilot cohort. For each reported issue record
the extension version, Chrome version, vendor, destination mode, and redacted
error category. Never request a user's password, session token, invoice, or full
service-worker log.

## 5. Public-launch gate

Move from Unlisted to Public only when:

- all vendors named in the listing have reviewed fixture coverage and no explicit health hold;
- disconnect, permission revocation, schedule-off persistence, de-duplication,
  destination failure, and expired-session paths passed;
- the privacy and support channels have been exercised;
- review feedback is closed and no high-severity dependency/security issue is
  open; and
- the previous known-good ZIP and checksum are retained for rollback.

Vendor compatibility is not permanent. Re-run the live matrix before every
release and remove a public support claim immediately if its endpoint or auth flow
is no longer verified.
