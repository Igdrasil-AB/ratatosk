# Collector release and Chrome smoke-test checklist

Complete this checklist against the exact commit and ZIP intended for submission.
Record evidence in the release or pull request; never attach real invoices or
tokens.

The strict pilot template and rollback/stop procedure are in
`pilot-manifest.template.json` and `pilot-runbook.md`. A ready private manifest
must pass `npm run validate:pilot -- <path> --ready` before dashboard work.

## Automated gate

```bash
npm ci
npm run release:collector
npm audit --audit-level=high
unzip -l artifacts/ratatosk-collector-*.zip
```

- [ ] CI, typecheck, validation, and tests pass.
- [ ] A fresh `store/semantic-dom-acceptance.json` matches the exact Collector
      version, discovery/acquisition revisions, and packaged ZIP SHA-256; its
      opaque semantic SPA, server-rendered documents, structured API, Igdrasil
      readback, explicit ClickUp completion, extension-generated plan/run
      snapshots, immediate-second-run, and configured-cadence cases pass with
      zero repeated actions, ledger additions, or page-owned downloads.
- [ ] Collector and its checksum are produced under `artifacts/`.
- [ ] `manifest.json` is at the ZIP root.
- [ ] The archive contains no `.map`, private key, environment file, or
      development fixture.
- [ ] Manifest permissions are exactly `storage`, `alarms`, `notifications`,
      `scripting`, `downloads`, `activeTab`, observation-only `webRequest`,
      response-header-only `declarativeNetRequest`, and `sidePanel` for the
      persistent Collector UI;
      `webRequestBlocking` is absent.
- [ ] Manifest has only the reviewed optional HTTPS envelope and no `<all_urls>`;
      verify installation grants no supplier-site access.
- [ ] Optional `tabs` metadata access is not granted at install time; verify the
      side panel explains the Chrome warning before requesting it and supports revocation.

## Fresh-profile Chrome test

Use the current stable Chrome release and a fresh profile.

- [ ] Load only `dist/collector` from `chrome://extensions`.
- [ ] Confirm the install and extensions page show no granted supplier sites or
      debugging capability before an exact-site prompt is approved.
- [ ] Open the popup and confirm a destination is required before vendor connect.
- [ ] Choose local Downloads and confirm the destination wording before saving.
- [ ] Deny one vendor's host prompt; confirm it remains disconnected and no fetch
      occurs.
- [ ] Grant a pilot vendor's host prompt using a dedicated test account.
- [ ] Run now; confirm exactly the expected test documents are downloaded.
- [ ] Run again; confirm duplicates are not downloaded.
- [ ] For every semantic DOM case, confirm listing activates no document
      control; the first action follows stable identity reservation; the second
      run and one configured cadence activate zero accepted identities. Copy
      the redacted diagnostic after each run and record
      `counts.documentActions`; second and cadence values must both be zero.
- [ ] Confirm a synthetic Chrome-native supplier response is blocked before
      Chrome creates a download and is rejected, while a simultaneous unrelated
      user download—including the same URL—remains untouched.
- [ ] Sign out of the vendor; confirm the reconnect state and notification.
- [ ] Disconnect the vendor; confirm its optional host permission is revoked.
- [ ] From an unsupported synthetic supplier home page, select **Search This
      App**; verify the exact-origin prompt, maximum fifteen-page/depth-three search,
      temporary-tab cleanup, domain/candidate preview, redacted failure diagnostic,
      paginated-collection completeness, second exact-host confirmation if needed,
      valid-PDF gate, provisional source row, explicit Forget History cleanup, and
      source-profile/unused-host cleanup on disconnect without implicit history deletion.
- [ ] Set schedule to off, restart Chrome, and confirm it remains off.
- [ ] Set each supported schedule and confirm the displayed next-run state.

## Igdrasil test

- [ ] Use a dedicated Igdrasil test company and non-sensitive documents.
- [ ] Connect from `https://accounting.igdrasil.se` and confirm the popup identifies
      Igdrasil as the destination.
- [ ] Complete the same flow once with an existing company and once as a new user;
      confirm onboarding returns to the Ratatosk connection page.
- [ ] Collect one known test invoice and confirm it arrives in the intended company.
- [ ] Confirm a repeated run is de-duplicated.
- [ ] Disconnect from Igdrasil; confirm the upload token is revoked, token and
      destination are cleared, and no vendor can run until another destination
      is selected.

## Reviewer instructions

- [ ] Provide a test account with the least access necessary and synthetic data.
- [ ] Explain how to select a destination, connect the test vendor, run collection,
      verify the result, disconnect, and delete the test data.
- [ ] Do not ask reviewers to use personal accounts or real financial documents.

## Pilot exit criteria

- [ ] Every publicly named vendor has fixture coverage; record current live tests when available.
- [ ] No unresolved high-severity dependency or security issue.
- [ ] Privacy policy, store disclosures, popup wording, and emitted manifest agree.
- [ ] Support and privacy request channels are monitored.
- [ ] Rollback artifact and previous known-good version are retained.
