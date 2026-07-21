import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hasVendorPermissions,
  hasTabAwarenessPermission,
  missingHostPermissions,
  requestHostPermissions,
  requestTabAwarenessPermission,
  revokeTabAwarenessPermission,
  revokeVendorPermissions,
  vendorPermissionOrigins,
} from "../../collector/src/platform/permissions";

describe("optional host permissions", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("starts the Chrome request synchronously so callers retain the click gesture", async () => {
    let resolveRequest!: (granted: boolean) => void;
    const request = vi.fn(() => new Promise<boolean>((resolve) => { resolveRequest = resolve; }));
    vi.stubGlobal("chrome", { permissions: { request } });

    const pending = requestHostPermissions(["https://claude.ai/*"]);

    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith({ origins: ["https://claude.ai/*"] });
    resolveRequest(true);
    await expect(pending).resolves.toBe(true);
  });

  it("requests only optional tab metadata for persistent side-panel awareness", async () => {
    const request = vi.fn(async () => true);
    vi.stubGlobal("chrome", { permissions: { request } });

    await expect(requestTabAwarenessPermission()).resolves.toBe(true);
    expect(request).toHaveBeenCalledWith({ permissions: ["tabs"] });
  });

  it("checks and revokes persistent tab awareness without touching host access", async () => {
    const contains = vi.fn((_request, callback: (granted: boolean) => void) => callback(true));
    const remove = vi.fn((_request, callback: (removed: boolean) => void) => callback(true));
    vi.stubGlobal("chrome", { permissions: { contains, remove } });

    await expect(hasTabAwarenessPermission()).resolves.toBe(true);
    await expect(revokeTabAwarenessPermission()).resolves.toBe(true);
    expect(contains).toHaveBeenCalledWith({ permissions: ["tabs"] }, expect.any(Function));
    expect(remove).toHaveBeenCalledWith({ permissions: ["tabs"] }, expect.any(Function));
  });

  it("identifies newly required recipe hosts for existing connections", async () => {
    const contains = vi.fn((request: { origins: string[] }, callback: (granted: boolean) => void) => {
      callback(request.origins[0] !== "https://stripe-upload-api.s3.us-west-1.amazonaws.com/*");
    });
    vi.stubGlobal("chrome", { permissions: { contains } });

    await expect(missingHostPermissions([
      "https://chatgpt.com/*",
      "https://pay.stripe.com/*",
      "https://stripe-upload-api.s3.us-west-1.amazonaws.com/*",
    ])).resolves.toEqual(["https://stripe-upload-api.s3.us-west-1.amazonaws.com/*"]);
  });

  it("merges learned provider origins into the connection permission contract", () => {
    expect(vendorPermissionOrigins(
      { hosts: ["https://vendor.example/*"] } as never,
      {
        vendorId: "vendor",
        connectedAt: 1,
        documentOrigins: ["https://stripe-upload-api.s3.eu-north-1.amazonaws.com/*"],
      },
    )).toEqual([
      "https://vendor.example/*",
      "https://stripe-upload-api.s3.eu-north-1.amazonaws.com/*",
    ]);
  });

  it("revokes learned provider origins together with the recipe hosts", async () => {
    const remove = vi.fn((_request, callback: (removed: boolean) => void) => callback(true));
    vi.stubGlobal("chrome", { permissions: { remove } });

    await expect(revokeVendorPermissions(
      { hosts: ["https://vendor.example/*"] } as never,
      {
        vendorId: "vendor",
        connectedAt: 1,
        documentOrigins: ["https://stripe-upload-api.s3.eu-north-1.amazonaws.com/*"],
      },
    )).resolves.toBe(true);
    expect(remove).toHaveBeenCalledWith({ origins: [
      "https://vendor.example/*",
      "https://stripe-upload-api.s3.eu-north-1.amazonaws.com/*",
    ] }, expect.any(Function));
  });

  it("checks learned provider origins as part of vendor readiness", async () => {
    const contains = vi.fn((_request, callback: (granted: boolean) => void) => callback(false));
    vi.stubGlobal("chrome", { permissions: { contains } });
    const connection = {
      vendorId: "vendor",
      connectedAt: 1,
      documentOrigins: ["https://stripe-upload-api.s3.eu-north-1.amazonaws.com/*"],
    };

    await expect(hasVendorPermissions({ hosts: ["https://vendor.example/*"] } as never, connection)).resolves.toBe(false);
    expect(contains).toHaveBeenCalledWith({ origins: [
      "https://vendor.example/*",
      "https://stripe-upload-api.s3.eu-north-1.amazonaws.com/*",
    ] }, expect.any(Function));
  });
});
