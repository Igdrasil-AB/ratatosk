# Reviewer test instructions template

Replace the bracketed owner-only fields before pasting this into the Chrome Web
Store Test instructions tab. Use a dedicated account containing synthetic invoice
data and rotate its password after review. Do not put these credentials in Git.

## Purpose

Ratatosk collects the signed-in user's own supplier invoices from a vendor the
user explicitly connects and saves them to the destination the user selects.
This submission contains Collector only. The separate Ratatosk Studio developer
tool and its `debugger` permission are not included.

## Test account

- Vendor: `[one vendor named in the submitted listing]`
- Sign-in URL: `[vendor login URL]`
- Username: `[review-only synthetic account username]`
- Password: `[provide only in the private dashboard field]`
- Expected synthetic invoices: `[count and non-sensitive labels]`
- Account expiry date: `[date after the expected review window]`

## Steps

1. Install Ratatosk and open its toolbar popup.
2. Select **Choose destination**.
3. Select **This computer — Downloads folder**. Keep the folder `Ratatosk` and
   folder mode `Date collected`.
4. Open **Vendors**. Review the disclosure explaining the billing data, existing
   browser session, temporary auth values, destination, and revocable host access.
5. Choose **Connect** beside `[vendor]` and approve only the displayed vendor and
   Stripe file hosts.
6. If the provided vendor account is not already signed in, use the review-only
   credentials above at the vendor's own login page. Ratatosk never receives the
   password or two-factor code.
7. Return to Ratatosk and choose **Sync** for `[vendor]`.
8. Confirm `[expected count]` synthetic PDF file(s) appear under the configured
   Ratatosk Downloads folder.
9. Choose **Sync** again and confirm no duplicate file is created.
10. Disconnect `[vendor]` and confirm it returns to the Connect state. Chrome's
    extension details should no longer show that vendor's optional host access.
11. Set the schedule to **Off**, restart Chrome, and confirm Off remains selected.

## Expected result

Only the synthetic invoices listed above are downloaded. No analytics or author
telemetry request is made. Denying the optional host prompt leaves the vendor
disconnected. Disconnect removes the vendor connection, its optional host access,
and its local collection history.

## Support during review

- Contact: support@igdrasil.se
- Privacy: legal@igdrasil.se
- Include the item id and review case id, but do not email credentials, tokens, or
  invoice documents.
