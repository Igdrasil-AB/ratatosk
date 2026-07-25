import { describe, expect, it } from "vitest";
import {
  AuthFailure,
  collectionFailureEvidence,
  DocumentInvalid,
  DomActionFailed,
  RetrievalIncomplete,
  UnexpectedResponse,
} from "../../src/core/errors";

describe("privacy-safe collection failure evidence", () => {
  it("classifies HTTP failures without retaining the supplied message", () => {
    const evidence = collectionFailureEvidence(
      new UnexpectedResponse(
        403,
        "GET https://vendor.example/invoice/acct_secret?token=secret failed",
        "vendor",
        "text/html; charset=utf-8",
      ),
      "document_fetch",
    );

    expect(evidence).toEqual({
      stage: "document_fetch",
      cause: "unexpected_response",
      httpStatus: 403,
      responseType: "html",
    });
    expect(JSON.stringify(evidence)).not.toMatch(/vendor|invoice|acct|token|secret|https?:\/\//i);
  });

  it("distinguishes document validation from transport", () => {
    expect(collectionFailureEvidence(
      new DocumentInvalid(200, "application/json", "vendor"),
      "document_fetch",
    )).toEqual({
      stage: "document_validation",
      cause: "document_invalid",
      httpStatus: 200,
      responseType: "json",
    });
  });

  it("distinguishes semantic action failure from selector drift", () => {
    expect(collectionFailureEvidence(
      new DomActionFailed("supplier detail omitted", "vendor"),
      "invoice_list",
    )).toEqual({
      stage: "invoice_list",
      cause: "action_failed",
    });
  });

  it("normalizes authentication and carries only structural retrieval proof", () => {
    const proof = {
      completeness: "partial" as const,
      termination: "time_cap" as const,
      pagesVisited: 2,
      observedItems: 8,
      resolvedItems: 4,
      unresolvedItems: 4,
    };

    expect(collectionFailureEvidence(
      new AuthFailure("blocked_or_challenged", "vendor"),
      "authentication",
    )).toEqual({
      stage: "authentication",
      cause: "auth_blocked",
    });
    expect(collectionFailureEvidence(
      new RetrievalIncomplete("route contained secret", "vendor", proof),
      "invoice_list",
    )).toEqual({
      stage: "invoice_list",
      cause: "retrieval_incomplete",
      retrieval: proof,
    });
  });
});
