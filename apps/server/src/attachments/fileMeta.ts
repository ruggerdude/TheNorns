import { createHash } from "node:crypto";
import { extractText, getDocumentProxy } from "unpdf";
import { type AttachmentImageMime, isAllowedImageMime, sniffImage } from "./imageMeta.js";

export type AttachmentFileMime =
  | "text/plain"
  | "text/markdown"
  | "application/json"
  | "text/csv"
  | "application/pdf"
  | "application/octet-stream";

export type AttachmentMime = AttachmentImageMime | AttachmentFileMime;

export interface PreparedAttachment {
  mime: AttachmentMime;
  width: number | null;
  height: number | null;
  extractedText: string | null;
  extractedTextSha256: string | null;
  extractionTruncated: boolean;
}

export const ALLOWED_FILE_MIMES: readonly AttachmentFileMime[] = [
  "text/plain",
  "text/markdown",
  "application/json",
  "text/csv",
  "application/pdf",
  "application/octet-stream",
];

export const FILE_EXTRACTION_CAPS = {
  maxTextBytes: 2 * 1024 * 1024,
  maxPdfBytes: 10 * 1024 * 1024,
  maxExtractedCharacters: 200_000,
  maxPdfPages: 200,
} as const;

export class AttachmentFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttachmentFileError";
  }
}

export function isAllowedFileMime(mime: string): mime is AttachmentFileMime {
  return (ALLOWED_FILE_MIMES as readonly string[]).includes(mime);
}

export function isAllowedAttachmentMime(mime: string): mime is AttachmentMime {
  return isAllowedImageMime(mime) || isAllowedFileMime(mime);
}

export function isImageAttachmentMime(mime: string): mime is AttachmentImageMime {
  return isAllowedImageMime(mime);
}

export function maxBytesForMime(mime: AttachmentMime, maxImageBytes: number): number {
  if (isAllowedImageMime(mime)) return maxImageBytes;
  if (mime === "application/octet-stream") return FILE_EXTRACTION_CAPS.maxPdfBytes;
  return mime === "application/pdf"
    ? FILE_EXTRACTION_CAPS.maxPdfBytes
    : FILE_EXTRACTION_CAPS.maxTextBytes;
}

export async function prepareAttachment(
  declaredMime: AttachmentMime,
  bytes: Buffer,
): Promise<PreparedAttachment> {
  if (isAllowedImageMime(declaredMime)) {
    const detected = sniffImage(bytes);
    if (!detected || detected.mime !== declaredMime) {
      throw new AttachmentFileError(`payload is not a valid ${declaredMime} image`);
    }
    return {
      mime: detected.mime,
      width: detected.width,
      height: detected.height,
      extractedText: null,
      extractedTextSha256: null,
      extractionTruncated: false,
    };
  }

  if (declaredMime === "application/octet-stream") {
    return {
      mime: declaredMime,
      width: null,
      height: null,
      extractedText: null,
      extractedTextSha256: null,
      extractionTruncated: false,
    };
  }
  const extracted =
    declaredMime === "application/pdf"
      ? await extractPdfText(bytes)
      : extractUtf8Text(declaredMime, bytes);
  const bounded = boundExtractedText(extracted);
  return {
    mime: declaredMime,
    width: null,
    height: null,
    extractedText: bounded.text,
    extractedTextSha256: createHash("sha256").update(bounded.text, "utf8").digest("hex"),
    extractionTruncated: bounded.truncated,
  };
}

function extractUtf8Text(mime: AttachmentFileMime, bytes: Buffer): string {
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new AttachmentFileError(`payload is not valid UTF-8 ${mime}`);
  }
  const normalized = normalizeExtractedText(decoded);
  if (normalized.includes("\u0000")) {
    throw new AttachmentFileError(`${mime} payload contains binary NUL bytes`);
  }
  if (mime === "application/json") {
    try {
      JSON.parse(normalized);
    } catch {
      throw new AttachmentFileError("payload is not valid JSON");
    }
  }
  return requireReadableText(normalized, mime);
}

async function extractPdfText(bytes: Buffer): Promise<string> {
  if (bytes.length < 5 || bytes.toString("ascii", 0, 5) !== "%PDF-") {
    throw new AttachmentFileError("payload is not a valid PDF document");
  }
  let document: Awaited<ReturnType<typeof getDocumentProxy>> | null = null;
  try {
    document = await getDocumentProxy(new Uint8Array(bytes), {
      stopAtErrors: true,
      verbosity: 0,
      useSystemFonts: false,
      disableFontFace: true,
      disableAutoFetch: true,
      disableStream: true,
    });
    if (document.numPages > FILE_EXTRACTION_CAPS.maxPdfPages) {
      throw new AttachmentFileError(
        `PDF has ${document.numPages} pages; at most ${FILE_EXTRACTION_CAPS.maxPdfPages} are supported`,
      );
    }
    const extracted = await extractText(document, { mergePages: true });
    return requireReadableText(normalizeExtractedText(extracted.text), "application/pdf");
  } catch (error) {
    if (error instanceof AttachmentFileError) throw error;
    throw new AttachmentFileError("PDF text extraction failed");
  } finally {
    if (document) await document.cleanup();
  }
}

function normalizeExtractedText(text: string): string {
  return text
    .replace(/^\uFEFF/u, "")
    .replace(/\r\n?/gu, "\n")
    .trim();
}

function requireReadableText(text: string, mime: AttachmentFileMime): string {
  if (text.length === 0) {
    throw new AttachmentFileError(`${mime} attachment contains no model-readable text`);
  }
  return text;
}

function boundExtractedText(text: string): { text: string; truncated: boolean } {
  if (text.length <= FILE_EXTRACTION_CAPS.maxExtractedCharacters) {
    return { text, truncated: false };
  }
  const marker = "\n\n[Attachment text truncated by The Norns]";
  return {
    text: `${text.slice(0, FILE_EXTRACTION_CAPS.maxExtractedCharacters - marker.length)}${marker}`,
    truncated: true,
  };
}
