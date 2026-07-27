import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { V2MockupRendererProfile, type V2MockupRendererProfileT } from "@norns/contracts";
import { z } from "zod";
import { canonicalJson } from "../persistence/migration/canonicalJson.js";

export const MOCKUP_DESKTOP_VIEWPORT = { width: 1440, height: 1024 } as const;
export const MOCKUP_MOBILE_VIEWPORT = { width: 390, height: 844 } as const;
export const MOCKUP_FIXED_CLOCK = "2000-01-01T00:00:00.000Z";
export const MOCKUP_RENDERER_REVISION = createHash("sha256")
  .update("norns-deterministic-raster-v1")
  .digest("hex");
export const MOCKUP_FONT_REVISION = createHash("sha256")
  .update("norns-built-in-block-font-v1")
  .digest("hex");

const boundedText = z.string().trim().min(1).max(4_000);

export const Phase6LayoutManifest = z
  .object({
    schema_version: z.literal(1),
    title: boundedText.max(160),
    summary: boundedText.max(1_000),
    target: z.enum(["desktop", "mobile", "responsive"]),
    sections: z
      .array(
        z
          .object({
            heading: boundedText.max(120),
            body: boundedText.max(800),
            emphasis: z.enum(["normal", "primary", "warning"]),
          })
          .strict(),
      )
      .min(1)
      .max(12),
    interaction_notes: z.array(boundedText.max(500)).min(1).max(32),
    source_artifact_ids: z.array(z.string().trim().min(1)).max(32),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    if (new Set(manifest.source_artifact_ids).size !== manifest.source_artifact_ids.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["source_artifact_ids"],
        message: "source artifact ids must be distinct",
      });
    }
  });
export type Phase6LayoutManifestT = z.infer<typeof Phase6LayoutManifest>;

export interface RenderedMockup {
  canonical_layout: string;
  profile: V2MockupRendererProfileT;
  desktop: Buffer;
  mobile: Buffer;
}

type Rgba = readonly [number, number, number, number];

class Raster {
  readonly pixels: Buffer;

  constructor(
    readonly width: number,
    readonly height: number,
    background: Rgba,
  ) {
    this.pixels = Buffer.alloc(width * height * 4);
    this.fill(0, 0, width, height, background);
  }

  fill(x: number, y: number, width: number, height: number, color: Rgba): void {
    const left = Math.max(0, Math.floor(x));
    const top = Math.max(0, Math.floor(y));
    const right = Math.min(this.width, Math.ceil(x + width));
    const bottom = Math.min(this.height, Math.ceil(y + height));
    for (let row = top; row < bottom; row += 1) {
      for (let column = left; column < right; column += 1) {
        const offset = (row * this.width + column) * 4;
        this.pixels[offset] = color[0];
        this.pixels[offset + 1] = color[1];
        this.pixels[offset + 2] = color[2];
        this.pixels[offset + 3] = color[3];
      }
    }
  }

  textBars(x: number, y: number, text: string, maxWidth: number, color: Rgba): number {
    const words = text.replace(/\s+/g, " ").trim().split(" ");
    let cursorX = x;
    let cursorY = y;
    const height = 6;
    for (const word of words) {
      const width = Math.max(10, Math.min(70, word.length * 5));
      if (cursorX + width > x + maxWidth) {
        cursorX = x;
        cursorY += 14;
      }
      this.fill(cursorX, cursorY, width, height, color);
      cursorX += width + 7;
    }
    return cursorY + height;
  }
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.byteLength);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, checksum]);
}

function encodePng(raster: Raster): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(raster.width, 0);
  ihdr.writeUInt32BE(raster.height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const scanlines = Buffer.alloc((raster.width * 4 + 1) * raster.height);
  for (let row = 0; row < raster.height; row += 1) {
    const target = row * (raster.width * 4 + 1);
    scanlines[target] = 0;
    raster.pixels.copy(scanlines, target + 1, row * raster.width * 4, (row + 1) * raster.width * 4);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(scanlines, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function palette(seed: string): { accent: Rgba; soft: Rgba } {
  const red = 70 + (Number.parseInt(seed.slice(0, 2), 16) % 100);
  const green = 70 + (Number.parseInt(seed.slice(2, 4), 16) % 100);
  const blue = 90 + (Number.parseInt(seed.slice(4, 6), 16) % 100);
  return {
    accent: [red, green, blue, 255],
    soft: [Math.min(245, red + 100), Math.min(245, green + 100), Math.min(245, blue + 100), 255],
  };
}

function renderViewport(
  layout: Phase6LayoutManifestT,
  seed: string,
  viewport: typeof MOCKUP_DESKTOP_VIEWPORT | typeof MOCKUP_MOBILE_VIEWPORT,
): Buffer {
  const canvas = new Raster(viewport.width, viewport.height, [246, 247, 250, 255]);
  const colors = palette(seed);
  const mobile = viewport.width === MOCKUP_MOBILE_VIEWPORT.width;
  const margin = mobile ? 18 : 54;
  const rail = mobile ? 0 : 244;
  if (!mobile) {
    canvas.fill(0, 0, rail, viewport.height, [27, 31, 43, 255]);
    canvas.fill(30, 38, 120, 14, colors.accent);
    for (let index = 0; index < 7; index += 1) {
      canvas.fill(30, 104 + index * 52, 150 - (index % 3) * 17, 9, [117, 125, 146, 255]);
    }
  } else {
    canvas.fill(0, 0, viewport.width, 64, [27, 31, 43, 255]);
    canvas.fill(18, 24, 96, 12, colors.accent);
    canvas.fill(viewport.width - 46, 22, 28, 18, [117, 125, 146, 255]);
  }
  const contentX = rail + margin;
  const contentWidth = viewport.width - contentX - margin;
  let y = mobile ? 92 : 62;
  canvas.fill(
    contentX,
    y,
    Math.min(contentWidth, mobile ? 230 : 520),
    mobile ? 17 : 22,
    [35, 39, 52, 255],
  );
  y += mobile ? 39 : 52;
  y = canvas.textBars(contentX, y, layout.summary, contentWidth, [129, 136, 154, 255]) + 26;

  const columns = mobile ? 1 : 2;
  const gap = mobile ? 14 : 22;
  const cardWidth = Math.floor((contentWidth - gap * (columns - 1)) / columns);
  for (const [index, section] of layout.sections.entries()) {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const cardX = contentX + column * (cardWidth + gap);
    const cardY = y + row * (mobile ? 154 : 180);
    const cardHeight = mobile ? 136 : 158;
    if (cardY + cardHeight > viewport.height - margin) break;
    canvas.fill(cardX, cardY, cardWidth, cardHeight, [255, 255, 255, 255]);
    canvas.fill(
      cardX,
      cardY,
      5,
      cardHeight,
      section.emphasis === "normal" ? colors.soft : colors.accent,
    );
    canvas.fill(
      cardX + 18,
      cardY + 18,
      Math.min(cardWidth - 36, section.heading.length * 7),
      10,
      [50, 55, 70, 255],
    );
    canvas.textBars(cardX + 18, cardY + 46, section.body, cardWidth - 36, [151, 157, 173, 255]);
    if (section.emphasis !== "normal") {
      canvas.fill(cardX + 18, cardY + cardHeight - 28, mobile ? 92 : 120, 12, colors.accent);
    }
  }
  return encodePng(canvas);
}

/** Pure, networkless, scriptless rendering of a strict canonical layout model. */
export function renderDeterministicMockup(input: Phase6LayoutManifestT): RenderedMockup {
  const layout = Phase6LayoutManifest.parse(input);
  const canonicalLayout = canonicalJson(layout);
  const seed = createHash("sha256").update(canonicalLayout).digest("hex");
  const profile = V2MockupRendererProfile.parse({
    renderer: "norns-deterministic-v1",
    renderer_revision: MOCKUP_RENDERER_REVISION,
    font_revision: MOCKUP_FONT_REVISION,
    pixel_ratio: 1,
    network: "disabled",
    scripts: "disabled",
    locale: "en-US",
    timezone: "UTC",
    fixed_clock: MOCKUP_FIXED_CLOCK,
    seed,
  });
  return {
    canonical_layout: canonicalLayout,
    profile,
    desktop: renderViewport(layout, seed, MOCKUP_DESKTOP_VIEWPORT),
    mobile: renderViewport(layout, seed, MOCKUP_MOBILE_VIEWPORT),
  };
}
