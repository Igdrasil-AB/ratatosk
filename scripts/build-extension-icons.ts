import { inflateSync, deflateSync } from "node:zlib";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const sizes = [16, 32, 48, 128];
const sourcePath = "assets/brand/invoice-squirrel.png";
const rusticBackgroundPath = "assets/brand/root-reconciliation-ledger-roots.png";
const source = decodeRgbaPng(readFileSync(sourcePath));
const bounds = opaqueBounds(source);

mkdirSync("public/icons", { recursive: true });
for (const size of sizes) {
  // Chrome's store guidance calls for 16 px of transparent padding around the
  // artwork in the 128 px icon. Scale that 75% artwork box proportionally for
  // every toolbar size while keeping the mascot's pixel-art edges crisp.
  const artworkSize = Math.max(1, Math.round(size * 0.75));
  const icon = fitNearestNeighbor(source, bounds, size, artworkSize);
  writeFileSync(`public/icons/${size}.png`, encodeRgbaPng(icon));
}

mkdirSync("store/assets", { recursive: true });
const rusticBackground = decodeRgbaPng(readFileSync(rusticBackgroundPath));
const promo = buildSmallPromo(rusticBackground, source, bounds);
writeFileSync("store/assets/ratatosk-small-promo-440x280.png", encodeRgbaPng(promo));
mkdirSync("public/brand", { recursive: true });
const popupHeader = buildRootsHeader(rusticBackground);
writeFileSync("public/brand/roots-header.png", encodeRgbaPng(popupHeader));

console.log(`✓ Ratatosk squirrel icons generated from ${sourcePath} (${sizes.join(", ")} px)`);
console.log(`✓ Chrome Web Store small promo generated from ${rusticBackgroundPath} (440×280 px)`);
console.log(`✓ Collector rustic roots header generated from ${rusticBackgroundPath} (720×144 px)`);

interface RgbaImage {
  width: number;
  height: number;
  pixels: Uint8Array;
}

interface Bounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function decodeRgbaPng(bytes: Uint8Array): RgbaImage {
  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!signature.every((byte, index) => bytes[index] === byte)) throw new Error("invalid PNG signature");

  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Uint8Array[] = [];
  for (let offset = 8; offset < bytes.length;) {
    const length = readU32(bytes, offset);
    const type = new TextDecoder().decode(bytes.subarray(offset + 4, offset + 8));
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = readU32(data, 0);
      height = readU32(data, 4);
      const [bitDepth, colorType, compression, filter, interlace] = data.subarray(8, 13);
      channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
      if (bitDepth !== 8 || channels === 0 || compression !== 0 || filter !== 0 || interlace !== 0) {
        throw new Error("source artwork must be a non-interlaced 8-bit RGB or RGBA PNG");
      }
    } else if (type === "IDAT") {
      idat.push(data);
    }
    offset += length + 12;
    if (type === "IEND") break;
  }
  if (!width || !height || !idat.length) throw new Error("incomplete PNG source");

  const scanlines = new Uint8Array(inflateSync(concat(idat)));
  const stride = width * channels;
  const expected = height * (stride + 1);
  if (scanlines.length !== expected) throw new Error(`unexpected PNG data length ${scanlines.length}; expected ${expected}`);

  const decoded = new Uint8Array(width * height * channels);
  for (let y = 0; y < height; y++) {
    const filter = scanlines[y * (stride + 1)];
    const input = scanlines.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = decoded.subarray(y * stride, (y + 1) * stride);
    const previous = y === 0 ? undefined : decoded.subarray((y - 1) * stride, y * stride);
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? row[x - channels] : 0;
      const above = previous?.[x] ?? 0;
      const upperLeft = previous && x >= channels ? previous[x - channels] : 0;
      const predictor = filter === 0 ? 0
        : filter === 1 ? left
          : filter === 2 ? above
            : filter === 3 ? Math.floor((left + above) / 2)
              : filter === 4 ? paeth(left, above, upperLeft)
                : NaN;
      if (Number.isNaN(predictor)) throw new Error(`unsupported PNG filter ${filter}`);
      row[x] = (input[x] + predictor) & 255;
    }
  }
  if (channels === 4) return { width, height, pixels: decoded };

  const pixels = new Uint8Array(width * height * 4);
  for (let input = 0, output = 0; input < decoded.length; input += 3, output += 4) {
    pixels[output] = decoded[input];
    pixels[output + 1] = decoded[input + 1];
    pixels[output + 2] = decoded[input + 2];
    pixels[output + 3] = 255;
  }
  return { width, height, pixels };
}

function buildSmallPromo(background: RgbaImage, mascot: RgbaImage, mascotBounds: Bounds): RgbaImage {
  const width = 440;
  const height = 280;
  const pixels = new Uint8Array(width * height * 4);
  const sourceAspect = background.width / background.height;
  const targetAspect = width / height;
  const cropWidth = sourceAspect > targetAspect ? Math.round(background.height * targetAspect) : background.width;
  const cropHeight = sourceAspect > targetAspect ? background.height : Math.round(background.width / targetAspect);
  // Bias the crop to the right so the reconciliation roots remain visible.
  const cropLeft = Math.max(0, Math.round((background.width - cropWidth) * 0.72));
  const cropTop = Math.max(0, Math.round((background.height - cropHeight) * 0.52));

  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const sourceX = cropLeft + Math.min(cropWidth - 1, Math.floor((x / width) * cropWidth));
    const sourceY = cropTop + Math.min(cropHeight - 1, Math.floor((y / height) * cropHeight));
    const sourceOffset = (sourceY * background.width + sourceX) * 4;
    const targetOffset = (y * width + x) * 4;
    const luminance = (background.pixels[sourceOffset] * 0.24)
      + (background.pixels[sourceOffset + 1] * 0.68)
      + (background.pixels[sourceOffset + 2] * 0.08);
    const ink = 1 - (luminance / 255);
    // Retain the paper/ledger texture while tinting it into Igdrasil's deep
    // green palette. The right-side roots stay legible at thumbnail size.
    pixels[targetOffset] = Math.round(24 - ink * 12);
    pixels[targetOffset + 1] = Math.round(92 - ink * 42);
    pixels[targetOffset + 2] = Math.round(69 - ink * 32);
    pixels[targetOffset + 3] = 255;
  }

  compositeNearestNeighbor(pixels, width, height, mascot, mascotBounds, 58, 51, 168);
  return { width, height, pixels };
}

function buildRootsHeader(background: RgbaImage): RgbaImage {
  const width = 720;
  const height = 144;
  const pixels = new Uint8Array(width * height * 4);
  const cropWidth = background.width;
  const cropHeight = Math.round(cropWidth / (width / height));
  const cropTop = Math.max(0, Math.round((background.height - cropHeight) * 0.58));

  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const sourceX = Math.min(cropWidth - 1, Math.floor((x / width) * cropWidth));
    const sourceY = cropTop + Math.min(cropHeight - 1, Math.floor((y / height) * cropHeight));
    const sourceOffset = (sourceY * background.width + sourceX) * 4;
    const targetOffset = (y * width + x) * 4;
    // Preserve the rustic artwork's original parchment, graphite, and warm-red
    // palette. The Store tile has its own contrast treatment; the in-product
    // header should feel like the source art rather than a branded color wash.
    pixels[targetOffset] = background.pixels[sourceOffset];
    pixels[targetOffset + 1] = background.pixels[sourceOffset + 1];
    pixels[targetOffset + 2] = background.pixels[sourceOffset + 2];
    pixels[targetOffset + 3] = 255;
  }
  return { width, height, pixels };
}

function compositeNearestNeighbor(
  target: Uint8Array,
  targetWidth: number,
  targetHeight: number,
  source: RgbaImage,
  bounds: Bounds,
  offsetX: number,
  offsetY: number,
  maxSize: number,
): void {
  const sourceWidth = bounds.right - bounds.left + 1;
  const sourceHeight = bounds.bottom - bounds.top + 1;
  const scale = Math.min(maxSize / sourceWidth, maxSize / sourceHeight);
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));

  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const targetX = offsetX + x;
    const targetY = offsetY + y;
    if (targetX < 0 || targetY < 0 || targetX >= targetWidth || targetY >= targetHeight) continue;
    const sourceX = bounds.left + Math.min(sourceWidth - 1, Math.floor(x / scale));
    const sourceY = bounds.top + Math.min(sourceHeight - 1, Math.floor(y / scale));
    const sourceOffset = (sourceY * source.width + sourceX) * 4;
    const alpha = source.pixels[sourceOffset + 3] / 255;
    if (alpha === 0) continue;
    const targetOffset = (targetY * targetWidth + targetX) * 4;
    for (let channel = 0; channel < 3; channel++) {
      target[targetOffset + channel] = Math.round(
        (source.pixels[sourceOffset + channel] * alpha) + (target[targetOffset + channel] * (1 - alpha)),
      );
    }
    target[targetOffset + 3] = 255;
  }
}

function opaqueBounds(image: RgbaImage): Bounds {
  let left = image.width;
  let top = image.height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
    if (image.pixels[(y * image.width + x) * 4 + 3] === 0) continue;
    left = Math.min(left, x);
    top = Math.min(top, y);
    right = Math.max(right, x);
    bottom = Math.max(bottom, y);
  }
  if (right < left || bottom < top) throw new Error("source icon is fully transparent");
  return { left, top, right, bottom };
}

function fitNearestNeighbor(source: RgbaImage, bounds: Bounds, canvasSize: number, artworkSize: number): RgbaImage {
  const sourceWidth = bounds.right - bounds.left + 1;
  const sourceHeight = bounds.bottom - bounds.top + 1;
  const scale = Math.min(artworkSize / sourceWidth, artworkSize / sourceHeight);
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  const offsetX = Math.floor((canvasSize - width) / 2);
  const offsetY = Math.floor((canvasSize - height) / 2);
  const pixels = new Uint8Array(canvasSize * canvasSize * 4);

  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const sourceX = bounds.left + Math.min(sourceWidth - 1, Math.floor(x / scale));
    const sourceY = bounds.top + Math.min(sourceHeight - 1, Math.floor(y / scale));
    const sourceOffset = (sourceY * source.width + sourceX) * 4;
    const targetOffset = ((offsetY + y) * canvasSize + offsetX + x) * 4;
    pixels.set(source.pixels.subarray(sourceOffset, sourceOffset + 4), targetOffset);
  }
  return { width: canvasSize, height: canvasSize, pixels };
}

function encodeRgbaPng(image: RgbaImage): Uint8Array {
  const scanlines = new Uint8Array(image.height * (image.width * 4 + 1));
  for (let y = 0; y < image.height; y++) {
    const row = y * (image.width * 4 + 1);
    scanlines[row] = 0;
    scanlines.set(image.pixels.subarray(y * image.width * 4, (y + 1) * image.width * 4), row + 1);
  }
  return concat([
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", concat([u32(image.width), u32(image.height), new Uint8Array([8, 6, 0, 0, 0])])),
    chunk("IDAT", new Uint8Array(deflateSync(scanlines, { level: 9 }))),
    chunk("IEND", new Uint8Array()),
  ]);
}

function paeth(left: number, above: number, upperLeft: number): number {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  return leftDistance <= aboveDistance && leftDistance <= upperLeftDistance ? left
    : aboveDistance <= upperLeftDistance ? above
      : upperLeft;
}

function readU32(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const payload = concat([typeBytes, data]);
  return concat([u32(data.length), payload, u32(crc32(payload))]);
}
function u32(value: number): Uint8Array { return new Uint8Array([(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255]); }
function concat(parts: Uint8Array[]): Uint8Array { const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0)); let offset = 0; for (const part of parts) { out.set(part, offset); offset += part.length; } return out; }
function crc32(data: Uint8Array): number { let crc = 0xffffffff; for (const byte of data) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); } return (crc ^ 0xffffffff) >>> 0; }
