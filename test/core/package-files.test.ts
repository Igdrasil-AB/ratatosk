import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertPackageFileSafe, collectPackageFiles } from "../../scripts/package-files";

describe("extension package file collection", () => {
  const temporary: string[] = [];

  afterEach(() => {
    for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  it("rejects a symlink to a file outside the build root before reading it", () => {
    const base = mkdtempSync(join(tmpdir(), "ratatosk-package-"));
    temporary.push(base);
    const root = join(base, "dist", "collector");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "manifest.json"), "{}");
    const outside = join(base, "outside-secret.txt");
    writeFileSync(outside, "must not ship");
    symlinkSync(outside, join(root, "innocent.txt"));

    expect(() => collectPackageFiles(root)).toThrow(/symbolic link must not ship/);
  });

  it("returns ordinary nested files in deterministic order", () => {
    const base = mkdtempSync(join(tmpdir(), "ratatosk-package-"));
    temporary.push(base);
    const root = join(base, "dist", "studio");
    mkdirSync(join(root, "assets"), { recursive: true });
    writeFileSync(join(root, "manifest.json"), "{}");
    writeFileSync(join(root, "assets", "app.js"), "code");

    expect(collectPackageFiles(root)).toEqual([
      join(root, "assets", "app.js"),
      join(root, "manifest.json"),
    ]);
  });

  it.each(["private.pem", "signing.key", "identity.p12", "credentials.json", "service-account.json", "id_ed25519"])(
    "rejects sensitive release asset %s before packaging",
    (name) => {
      expect(() => assertPackageFileSafe(`public/${name}`, new TextEncoder().encode("secret"))).toThrow(
        /credential|private-key/,
      );
    },
  );

  it("rejects private-key material hidden behind an ordinary filename", () => {
    const disguised = new TextEncoder().encode("-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n-----END OPENSSH PRIVATE KEY-----");
    expect(() => assertPackageFileSafe("assets/readme.txt", disguised)).toThrow(/private-key material/);
  });
});
