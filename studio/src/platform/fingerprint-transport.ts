import type { SupplierFingerprintSubmissionV1 } from "../../../src/core/recorder/supplier-fingerprint";

/**
 * Delivery is deliberately behind an interface: the approved, versioned
 * submission is stable while the Svala destination and authentication policy
 * are still undecided. This implementation performs no network request.
 */
export interface SupplierFingerprintTransport {
  readonly target: "svala";
  readonly configured: boolean;
  deliver(submission: SupplierFingerprintSubmissionV1): Promise<{ delivered: true } | { delivered: false; reason: "not_configured" }>;
}

export const svalaFingerprintTransport: SupplierFingerprintTransport = {
  target: "svala",
  configured: false,
  async deliver(_submission) {
    return { delivered: false, reason: "not_configured" };
  },
};
