// FRONT DOOR P4 (D3): format sniffing + dimension extraction for the four
// accepted image types. This is deliberately dependency-free header parsing —
// enough to (a) confirm the bytes really are the format the caller declared
// (a caller cannot smuggle a non-image or a mislabelled type past the mime
// cap) and (b) record width/height for the UI. Dimensions are best-effort:
// when a variant's header can't be parsed the format is still trusted and the
// dimensions are recorded as null (the columns are nullable).

export type AttachmentImageMime = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

export interface DetectedImage {
  mime: AttachmentImageMime;
  width: number | null;
  height: number | null;
}

export const ALLOWED_IMAGE_MIMES: readonly AttachmentImageMime[] = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
];

export function isAllowedImageMime(mime: string): mime is AttachmentImageMime {
  return (ALLOWED_IMAGE_MIMES as readonly string[]).includes(mime);
}

/**
 * Detect the true image format from the leading bytes and, where possible, the
 * pixel dimensions. Returns null when the bytes match none of the four
 * accepted formats.
 */
export function sniffImage(bytes: Buffer): DetectedImage | null {
  if (isPng(bytes)) return { mime: "image/png", ...pngDimensions(bytes) };
  if (isGif(bytes)) return { mime: "image/gif", ...gifDimensions(bytes) };
  if (isJpeg(bytes)) return { mime: "image/jpeg", ...jpegDimensions(bytes) };
  if (isWebp(bytes)) return { mime: "image/webp", ...webpDimensions(bytes) };
  return null;
}

type Dim = { width: number | null; height: number | null };
const NO_DIM: Dim = { width: null, height: null };

// ---- PNG -----------------------------------------------------------------
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function isPng(b: Buffer): boolean {
  return b.length >= 8 && b.subarray(0, 8).equals(PNG_SIGNATURE);
}

function pngDimensions(b: Buffer): Dim {
  // IHDR is the first chunk; width/height are big-endian uint32 at 16 and 20.
  if (b.length < 24 || b.toString("ascii", 12, 16) !== "IHDR") return NO_DIM;
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

// ---- GIF -----------------------------------------------------------------
function isGif(b: Buffer): boolean {
  if (b.length < 6) return false;
  const header = b.toString("ascii", 0, 6);
  return header === "GIF87a" || header === "GIF89a";
}

function gifDimensions(b: Buffer): Dim {
  // Logical screen descriptor: little-endian uint16 width at 6, height at 8.
  if (b.length < 10) return NO_DIM;
  return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
}

// ---- JPEG ----------------------------------------------------------------
function isJpeg(b: Buffer): boolean {
  return b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
}

function jpegDimensions(b: Buffer): Dim {
  // Walk the marker segments to the first Start-Of-Frame; height/width are
  // big-endian uint16 at SOF offsets +5 and +7.
  let offset = 2;
  while (offset + 9 < b.length) {
    if (b[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = b[offset + 1] ?? 0;
    // SOF0..SOF15 carry the frame dimensions, excluding the non-SOF markers.
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      return { height: b.readUInt16BE(offset + 5), width: b.readUInt16BE(offset + 7) };
    }
    // Standalone markers (RSTn, SOI, EOI, TEM) carry no length payload.
    if ((marker >= 0xd0 && marker <= 0xd9) || marker === 0x01) {
      offset += 2;
      continue;
    }
    const segmentLength = b.readUInt16BE(offset + 2);
    if (segmentLength < 2) return NO_DIM;
    offset += 2 + segmentLength;
  }
  return NO_DIM;
}

// ---- WEBP ----------------------------------------------------------------
function isWebp(b: Buffer): boolean {
  return (
    b.length >= 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP"
  );
}

function webpDimensions(b: Buffer): Dim {
  if (b.length < 16) return NO_DIM;
  const format = b.toString("ascii", 12, 16);
  if (format === "VP8 ") {
    // Lossy: 16-bit LE width/height (14 low bits) after the start-code at 26/28.
    if (b.length < 30) return NO_DIM;
    return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  }
  if (format === "VP8L") {
    // Lossless: 14-bit (dim-1) fields packed after the 0x2f signature byte.
    if (b.length < 25 || b[20] !== 0x2f) return NO_DIM;
    const bits = b.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (format === "VP8X") {
    // Extended: 24-bit LE (canvas-dim - 1) at 24 (width) and 27 (height).
    if (b.length < 30) return NO_DIM;
    return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
  }
  return NO_DIM;
}
