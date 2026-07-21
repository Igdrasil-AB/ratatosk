import pkg from "../package.json";
import studioManifest from "../studio/manifest.config";
import { validateStudioManifest } from "./manifest-validation";

const manifest = studioManifest as unknown as Parameters<typeof validateStudioManifest>[0] & {
  manifest_version?: number;
  version?: string;
};

if (manifest.manifest_version !== 3) throw new Error("Studio source manifest is not Manifest V3");
if (manifest.version !== pkg.version) {
  throw new Error(`Studio source manifest version ${manifest.version} does not match ${pkg.version}`);
}
validateStudioManifest(manifest);
console.log("✓ Studio release manifest matches the reviewed authoring-only boundary");
