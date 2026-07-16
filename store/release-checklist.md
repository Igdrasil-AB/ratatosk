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
- [ ] Collector and its checksum are produced under `artifacts/`.
- [ ] `manifest.json` is at the ZIP root.
- [ ] The archive contains no `studio`, `.map`, private key, environment file, or
      development fixture.
- [ ] Manifest permissions are exactly `storage`, `alarms`, `notifications`,
      `scripting`, and `downloads`.
- [ ] Manifest has optional vendor hosts only and no `<all_urls>`.

## Fresh-profile Chrome test

Use the current stable Chrome release and a fresh profile.

- [ ] Load only `dist/collector` from `chrome://extensions`.
- [ ] Confirm the install and extensions page show no all-sites or debugging
      capability.
- [ ] Open the popup and confirm a destination is required before vendor connect.
- [ ] Choose local Downloads and confirm the destination wording before saving.
- [ ] Deny one vendor's host prompt; confirm it remains disconnected and no fetch
      occurs.
- [ ] Grant a pilot vendor's host prompt using a dedicated test account.
- [ ] Run now; confirm exactly the expected test documents are downloaded.
- [ ] Run again; confirm duplicates are not downloaded.
- [ ] Sign out of the vendor; confirm the reconnect state and notification.
- [ ] Disconnect the vendor; confirm its optional host permission is revoked.
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
- [ ] State that Studio is a separate development artifact and is not in the ZIP.
- [ ] Do not ask reviewers to use personal accounts or real financial documents.

## Pilot exit criteria

- [ ] Every publicly named vendor passed a current live test.
- [ ] No unresolved high-severity dependency or security issue.
- [ ] Privacy policy, store disclosures, popup wording, and emitted manifest agree.
- [ ] Support and privacy request channels are monitored.
- [ ] Rollback artifact and previous known-good version are retained.
