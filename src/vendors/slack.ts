import { defineVendor } from "./define";

/**
 * Slack — billing is scoped per workspace, so this recipe uses `config` to
 * discover the workspaces the signed-in user administers and fetches invoices
 * for each. Good example of a multi-scope vendor.
 *
 * ⚠️ ILLUSTRATIVE: endpoints are representative of Slack's admin billing surface
 * but MUST be re-captured from DevTools before relying on them. See
 * docs/adding-a-vendor.md.
 */
export default defineVendor({
  id: "slack",
  name: "Slack",
  homepage: "https://slack.com",
  category: "communication",
  icon: "slack", // simple-icons dropped Slack → real mark comes from icon-overrides
  hosts: ["https://*.slack.com/*"],
  notes: "Illustrative endpoints — verify against the live workspace admin billing page.",

  auth: {
    check: {
      request: { url: "https://app.slack.com/api/team.info" },
      expect: { and: [{ statusIn: [200] }, { jsonPath: "ok", equals: true }] },
    },
    loginUrl: "https://slack.com/signin",
  },

  config: [
    {
      id: "workspace",
      discover: {
        request: { url: "https://app.slack.com/api/admin.workspaces.list?limit=50&cursor={cursor}" },
        items: "workspaces",
        value: "domain", // becomes {workspace}
        label: "name",
        paginate: { cursor: "response_metadata.next_cursor", maxPages: 10 },
      },
    },
  ],

  invoices: {
    strategy: "network",
    list: {
      request: { url: "https://{workspace}.slack.com/api/billing.invoices.list" },
      items: "invoices",
      map: {
        id: "id",
        issuedAt: { path: "date_issued", transforms: [{ kind: "date" }] },
        total: { path: "amount", transforms: [{ kind: "divide", by: 100 }] },
        currency: "currency",
        documentUrl: "pdf_url",
      },
      paginate: { cursor: "response_metadata.next_cursor", maxPages: 10 },
    },
    document: { contentType: "application/pdf" },
  },
});
