import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { Type, type Static } from '@sinclair/typebox';

export const MarketplaceListingConfigSchema = Type.Object({
  visibility: Type.Literal('PRIVATE_DOMAIN_ONLY'),
  oauthConsentScreen: Type.Object({
    userType: Type.Literal('INTERNAL'),
    appName: Type.String({ minLength: 1, maxLength: 50 }),
    userSupportEmailInstruction: Type.String({ minLength: 1 }),
    appDomainAndLogoInstruction: Type.String({ minLength: 1 }),
    developerContactEmails: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    oauthScopes: Type.Array(Type.String({ minLength: 1, pattern: '^https://' }), { minItems: 1 }),
  }),
  storeListing: Type.Object({
    language: Type.String({ minLength: 1 }),
    appName: Type.String({ minLength: 1, maxLength: 50 }),
    category: Type.String({ minLength: 1 }),
    shortDescription: Type.String({ minLength: 1, maxLength: 200 }),
    detailedDescription: Type.String({ minLength: 1, maxLength: 16000 }),
    urls: Type.Object({
      homepageUrl: Type.String({ pattern: '^https://' }),
      supportUrl: Type.String({ pattern: '^https://' }),
      privacyPolicyUrl: Type.String({ pattern: '^https://' }),
      termsOfServiceUrl: Type.String({ pattern: '^https://' }),
    }),
    assets: Type.Object({
      applicationIcon32: Type.Object({
        path: Type.String(),
        width: Type.Literal(32),
        height: Type.Literal(32),
      }),
      applicationIcon128: Type.Object({
        path: Type.String(),
        width: Type.Literal(128),
        height: Type.Literal(128),
      }),
      cardBanner220x140: Type.Object({
        path: Type.String(),
        width: Type.Literal(220),
        height: Type.Literal(140),
      }),
      screenshots: Type.Array(
        Type.Object({
          path: Type.String(),
          width: Type.Literal(1280),
          height: Type.Literal(800),
        }),
        { minItems: 1 }
      ),
      companionLogoProd48: Type.Object({
        path: Type.String(),
        url: Type.String({ pattern: '^https://' }),
        width: Type.Literal(48),
        height: Type.Literal(48),
      }),
      companionLogoDev48: Type.Object({
        path: Type.String(),
        url: Type.String({ pattern: '^https://' }),
        width: Type.Literal(48),
        height: Type.Literal(48),
      }),
    }),
  }),
});

export type MarketplaceListingConfig = Static<typeof MarketplaceListingConfigSchema>;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Precomputed CRC32 lookup table (IEEE 802.3 standard)
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC_TABLE[n] = c;
}

/**
 * Computes standard IEEE 802.3 32-bit CRC.
 */
export function crc32(buf: Buffer | Uint8Array, offset = 0, length = buf.length - offset): number {
  let crc = 0xffffffff;
  const end = offset + length;
  for (let i = offset; i < end; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * RFC 2083 Paeth predictor filter.
 */
export function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

export interface DecodedPng {
  width: number;
  height: number;
  data: Buffer; // RGBA 8-bit buffer of size width * height * 4
}

/**
 * Decodes a PNG buffer into raw RGBA pixel data.
 * Supports all 5 RFC 2083 filter types: 0 (None), 1 (Sub), 2 (Up), 3 (Average), 4 (Paeth).
 */
export function decodePng(buf: Buffer): DecodedPng {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('Invalid PNG signature');
  }

  let width = 0;
  let height = 0;
  let colorType = 0;
  const idatBuffers: Buffer[] = [];

  let offset = 8;
  while (offset + 8 <= buf.length) {
    const chunkLength = buf.readUInt32BE(offset);
    const chunkType = buf.subarray(offset + 4, offset + 8).toString('ascii');
    const dataStart = offset + 8;
    const dataEnd = dataStart + chunkLength;

    if (dataEnd + 4 > buf.length) {
      throw new Error(`Truncated chunk "${chunkType}" in PNG data`);
    }

    if (chunkType === 'IHDR') {
      width = buf.readUInt32BE(dataStart);
      height = buf.readUInt32BE(dataStart + 4);
      const bitDepth = buf.readUInt8(dataStart + 8);
      colorType = buf.readUInt8(dataStart + 9);
      const compression = buf.readUInt8(dataStart + 10);
      const filter = buf.readUInt8(dataStart + 11);
      const interlace = buf.readUInt8(dataStart + 12);

      if (bitDepth !== 8) {
        throw new Error(`Unsupported PNG bit depth: ${bitDepth}`);
      }
      if (colorType !== 6 && colorType !== 2) {
        throw new Error(`Unsupported PNG color type: ${colorType} (only RGBA:6 and RGB:2 supported)`);
      }
      if (compression !== 0 || filter !== 0 || interlace !== 0) {
        throw new Error('Interlaced or unsupported PNG compression/filter parameters');
      }
    } else if (chunkType === 'IDAT') {
      idatBuffers.push(buf.subarray(dataStart, dataEnd));
    } else if (chunkType === 'IEND') {
      break;
    }

    offset = dataEnd + 4; // skip chunk data + 4 bytes CRC
  }

  if (width === 0 || height === 0) {
    throw new Error('Missing or invalid IHDR chunk in PNG');
  }

  const inflated = zlib.inflateSync(Buffer.concat(idatBuffers));
  const srcBpp = colorType === 6 ? 4 : 3;
  const stride = 1 + width * srcBpp;
  const expectedLength = height * stride;

  if (inflated.length !== expectedLength) {
    throw new Error(
      `Decompressed IDAT size mismatch: expected ${expectedLength} bytes, got ${inflated.length}`
    );
  }

  const outputData = Buffer.alloc(width * height * 4);
  const reconstructedRow = Buffer.alloc(width * srcBpp);
  const priorRow = Buffer.alloc(width * srcBpp);

  for (let y = 0; y < height; y++) {
    const rowStart = y * stride;
    const filterType = inflated[rowStart];

    for (let x = 0; x < width * srcBpp; x++) {
      const raw = inflated[rowStart + 1 + x];
      const a = x >= srcBpp ? reconstructedRow[x - srcBpp] : 0;
      const b = priorRow[x];
      const c = x >= srcBpp ? priorRow[x - srcBpp] : 0;

      let val: number;
      switch (filterType) {
        case 0: // None
          val = raw;
          break;
        case 1: // Sub
          val = (raw + a) & 0xff;
          break;
        case 2: // Up
          val = (raw + b) & 0xff;
          break;
        case 3: // Average
          val = (raw + Math.floor((a + b) / 2)) & 0xff;
          break;
        case 4: // Paeth
          val = (raw + paethPredictor(a, b, c)) & 0xff;
          break;
        default:
          throw new Error(`Unknown PNG filter type ${filterType} at scanline ${y}`);
      }

      reconstructedRow[x] = val;
    }

    // Copy reconstructed scanline into output RGBA buffer
    const outRowStart = y * width * 4;
    if (colorType === 6) {
      reconstructedRow.copy(outputData, outRowStart, 0, width * 4);
    } else {
      // Expand RGB (colorType 2) to RGBA
      for (let px = 0; px < width; px++) {
        outputData[outRowStart + px * 4] = reconstructedRow[px * 3];
        outputData[outRowStart + px * 4 + 1] = reconstructedRow[px * 3 + 1];
        outputData[outRowStart + px * 4 + 2] = reconstructedRow[px * 3 + 2];
        outputData[outRowStart + px * 4 + 3] = 255;
      }
    }

    reconstructedRow.copy(priorRow);
  }

  return { width, height, data: outputData };
}

/**
 * Builds a PNG chunk buffer given chunk type and chunk data.
 */
export function makeChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);

  const crcPayload = Buffer.concat([typeBuf, data]);
  const crcVal = crc32(crcPayload);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crcVal, 0);

  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

/**
 * Encodes raw RGBA data into a deterministic PNG buffer.
 * Uses filter type 0 (None), zlib deflate level 9, and standard IEEE 802.3 CRC32 chunk checksums.
 */
export function encodePng(width: number, height: number, data: Buffer): Buffer {
  if (data.length !== width * height * 4) {
    throw new Error(
      `Pixel data size mismatch: expected ${width * height * 4} bytes for RGBA, got ${data.length}`
    );
  }

  // Construct raw uncompressed scanlines with filter type 0 (None)
  const rawScanlines = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const scanlineOffset = y * (1 + width * 4);
    rawScanlines[scanlineOffset] = 0; // Filter type 0: None
    data.copy(rawScanlines, scanlineOffset + 1, y * width * 4, (y + 1) * width * 4);
  }

  const deflated = zlib.deflateSync(rawScanlines, { level: 9 });

  // IHDR chunk
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData.writeUInt8(8, 8); // bit depth: 8
  ihdrData.writeUInt8(6, 9); // color type: 6 (RGBA)
  ihdrData.writeUInt8(0, 10); // compression method: 0 (deflate)
  ihdrData.writeUInt8(0, 11); // filter method: 0 (adaptive)
  ihdrData.writeUInt8(0, 12); // interlace method: 0 (none)
  const ihdrChunk = makeChunk('IHDR', ihdrData);

  // IDAT chunk
  const idatChunk = makeChunk('IDAT', deflated);

  // IEND chunk
  const iendChunk = makeChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([PNG_SIGNATURE, ihdrChunk, idatChunk, iendChunk]);
}

const FONT_5X7_BASE64 =
  'AAAAAAAAAF8AAAAHAAcAFH8UfxQkKn8qEiMTCGRiNklWIFAACAcDAAAcIkEAAEEiHAAqHH8cKggIPggIAIBwMAAICAgICAAAYGAAIBAIBAI+UUlFPgBCf0AAcklJSUYhQUlNMxgUEn8QJ0VFRTk8SklJMUEhEQkHNklJSTZGSUkpHgAAFAAAAEA0AAAACBQiQRQUFBQUAEEiFAgCAVkJBj5BXVlOfBIREnx/SUlJNj5BQUEif0FBQT5/SUlJQX8JCQkBPkFBUXN/CAgIfwBBf0EAIEBBPwF/CBQiQX9AQEBAfwIcAn9/BAgQfz5BQUE+fwkJCQY+QVEhXn8JGSlGJklJSTIDAX8BAz9AQEA/HyBAIB8/QDhAP2MUCBRjAwR4BANhWUlNQwB/QUFBAgQIECAAQUFBfwQCAQIEQEBAQEAAAwcIACBUVHhAfyhERDg4REREKDhERCh/OFRUVBgACH4JAhikpJx4fwgEBHgARH1AACBAQD0AfxAoRAAAQX9AAHwEeAR4fAgEBHg4REREOPwYJCQYGCQkGPx8CAQECEhUVFQkBAQ/RCQ8QEAgfBwgQCAcPEAwQDxEKBAoREyQkJB8RGRUTEQACDZBAAAAdwAAAEE2CAACAQIEAg==';
const FONT_5X7 = Buffer.from(FONT_5X7_BASE64, 'base64');

export class PixelCanvas {
  public readonly width: number;
  public readonly height: number;
  public readonly data: Buffer;

  constructor(
    width: number,
    height: number,
    initColor: [number, number, number, number] = [255, 255, 255, 255]
  ) {
    this.width = width;
    this.height = height;
    this.data = Buffer.alloc(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      this.data[i * 4] = initColor[0];
      this.data[i * 4 + 1] = initColor[1];
      this.data[i * 4 + 2] = initColor[2];
      this.data[i * 4 + 3] = initColor[3];
    }
  }

  setPixel(x: number, y: number, r: number, g: number, b: number, a = 255): void {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return;
    const idx = (y * this.width + x) * 4;
    this.data[idx] = r;
    this.data[idx + 1] = g;
    this.data[idx + 2] = b;
    this.data[idx + 3] = a;
  }

  blendPixel(x: number, y: number, r: number, g: number, b: number, a: number): void {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height || a <= 0) return;
    if (a >= 255) {
      this.setPixel(x, y, r, g, b, 255);
      return;
    }
    const idx = (y * this.width + x) * 4;
    const alpha = a / 255;
    const invAlpha = 1 - alpha;
    this.data[idx] = Math.round(r * alpha + this.data[idx] * invAlpha);
    this.data[idx + 1] = Math.round(g * alpha + this.data[idx + 1] * invAlpha);
    this.data[idx + 2] = Math.round(b * alpha + this.data[idx + 2] * invAlpha);
    this.data[idx + 3] = 255;
  }

  fillRect(
    x: number,
    y: number,
    w: number,
    h: number,
    r: number,
    g: number,
    b: number,
    a = 255
  ): void {
    const x0 = Math.max(0, Math.floor(x));
    const y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(this.width, Math.floor(x + w));
    const y1 = Math.min(this.height, Math.floor(y + h));

    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) {
        this.blendPixel(px, py, r, g, b, a);
      }
    }
  }

  strokeRect(
    x: number,
    y: number,
    w: number,
    h: number,
    r: number,
    g: number,
    b: number,
    a = 255,
    thickness = 1
  ): void {
    this.fillRect(x, y, w, thickness, r, g, b, a);
    this.fillRect(x, y + h - thickness, w, thickness, r, g, b, a);
    this.fillRect(x, y, thickness, h, r, g, b, a);
    this.fillRect(x + w - thickness, y, thickness, h, r, g, b, a);
  }

  drawRoundedRect(
    x: number,
    y: number,
    w: number,
    h: number,
    radius: number,
    fill?: [number, number, number, number],
    stroke?: [number, number, number, number],
    thickness = 1
  ): void {
    const x0 = Math.max(0, Math.floor(x));
    const y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(this.width, Math.floor(x + w));
    const y1 = Math.min(this.height, Math.floor(y + h));
    const r = Math.min(radius, Math.floor(w / 2), Math.floor(h / 2));

    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) {
        let inside = true;
        let isStroke = false;
        const dxL = px - (x + r);
        const dxR = px - (x + w - 1 - r);
        const dyT = py - (y + r);
        const dyB = py - (y + h - 1 - r);

        if (px < x + r && py < y + r) {
          const dist = Math.sqrt(dxL * dxL + dyT * dyT);
          if (dist > r) inside = false;
          else if (stroke && dist >= r - thickness) isStroke = true;
        } else if (px >= x + w - r && py < y + r) {
          const dist = Math.sqrt(dxR * dxR + dyT * dyT);
          if (dist > r) inside = false;
          else if (stroke && dist >= r - thickness) isStroke = true;
        } else if (px < x + r && py >= y + h - r) {
          const dist = Math.sqrt(dxL * dxL + dyB * dyB);
          if (dist > r) inside = false;
          else if (stroke && dist >= r - thickness) isStroke = true;
        } else if (px >= x + w - r && py >= y + h - r) {
          const dist = Math.sqrt(dxR * dxR + dyB * dyB);
          if (dist > r) inside = false;
          else if (stroke && dist >= r - thickness) isStroke = true;
        } else if (stroke) {
          if (
            px < x + thickness ||
            px >= x + w - thickness ||
            py < y + thickness ||
            py >= y + h - thickness
          ) {
            isStroke = true;
          }
        }

        if (inside) {
          if (isStroke && stroke) {
            this.blendPixel(px, py, stroke[0], stroke[1], stroke[2], stroke[3]);
          } else if (fill) {
            this.blendPixel(px, py, fill[0], fill[1], fill[2], fill[3]);
          }
        }
      }
    }
  }

  drawCircle(
    cx: number,
    cy: number,
    radius: number,
    fill?: [number, number, number, number],
    stroke?: [number, number, number, number],
    thickness = 1
  ): void {
    const x0 = Math.max(0, Math.floor(cx - radius));
    const y0 = Math.max(0, Math.floor(cy - radius));
    const x1 = Math.min(this.width, Math.ceil(cx + radius));
    const y1 = Math.min(this.height, Math.ceil(cy + radius));

    for (let py = y0; py <= y1; py++) {
      for (let px = x0; px <= x1; px++) {
        const dx = px - cx;
        const dy = py - cy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist <= radius) {
          if (stroke && dist >= radius - thickness) {
            this.blendPixel(px, py, stroke[0], stroke[1], stroke[2], stroke[3]);
          } else if (fill) {
            this.blendPixel(px, py, fill[0], fill[1], fill[2], fill[3]);
          }
        }
      }
    }
  }

  blit(src: DecodedPng, dstX: number, dstY: number): void {
    for (let sy = 0; sy < src.height; sy++) {
      const dy = dstY + sy;
      if (dy < 0 || dy >= this.height) continue;
      for (let sx = 0; sx < src.width; sx++) {
        const dx = dstX + sx;
        if (dx < 0 || dx >= this.width) continue;
        const sIdx = (sy * src.width + sx) * 4;
        const r = src.data[sIdx];
        const g = src.data[sIdx + 1];
        const b = src.data[sIdx + 2];
        const a = src.data[sIdx + 3];
        this.blendPixel(dx, dy, r, g, b, a);
      }
    }
  }

  drawChar(
    ch: string,
    x: number,
    y: number,
    color: [number, number, number, number],
    scale = 1
  ): void {
    const code = ch.charCodeAt(0);
    if (code < 32 || code > 126) return;
    const offset = (code - 32) * 5;

    for (let col = 0; col < 5; col++) {
      const colByte = FONT_5X7[offset + col];
      for (let row = 0; row < 7; row++) {
        if ((colByte >> row) & 1) {
          if (scale === 1) {
            this.blendPixel(x + col, y + row, color[0], color[1], color[2], color[3]);
          } else {
            this.fillRect(
              x + col * scale,
              y + row * scale,
              scale,
              scale,
              color[0],
              color[1],
              color[2],
              color[3]
            );
          }
        }
      }
    }
  }

  drawText(
    text: string,
    x: number,
    y: number,
    color: [number, number, number, number],
    scale = 1
  ): void {
    let curX = x;
    const charWidth = 6 * scale;
    for (let i = 0; i < text.length; i++) {
      this.drawChar(text[i], curX, y, color, scale);
      curX += charWidth;
    }
  }
}

/**
 * Composes a full 1280x800 Google Workspace Marketplace screenshot depicting
 * the INC-IO Docs Workspace Add-on running inside Google Workspace.
 */
export function composeScreenshot1280x800(brandingDir: string, icon48Buf: Buffer): Buffer {
  const width = 1280;
  const height = 800;
  const canvas = new PixelCanvas(width, height, [241, 243, 244, 255]); // Workspace light-gray background

  // 1. Left / Main Workspace Canvas (x: 0 to 899)
  // -------------------------------------------------------------
  // Header bar (y: 0 to 64)
  canvas.fillRect(0, 0, 900, 64, 255, 255, 255, 255);
  canvas.fillRect(0, 64, 900, 1, 224, 224, 224, 255); // divider

  // Google Docs icon (blue doc glyph with corner fold)
  canvas.drawRoundedRect(22, 14, 26, 36, 4, [66, 133, 244, 255]);
  canvas.fillRect(38, 14, 10, 10, 168, 200, 250, 255); // dog ear
  canvas.fillRect(28, 26, 14, 2, 255, 255, 255, 255);
  canvas.fillRect(28, 31, 14, 2, 255, 255, 255, 255);
  canvas.fillRect(28, 36, 10, 2, 255, 255, 255, 255);

  // Document Title & Menu Bar
  canvas.drawText('INC-IO Q4 Architecture & Deployment Specification', 58, 16, [32, 33, 36, 255], 2);
  canvas.drawText(
    'File   Edit   View   Insert   Format   Tools   Extensions   Help',
    58,
    42,
    [95, 99, 104, 255],
    1
  );
  canvas.drawText('[v] Saved to Drive', 520, 42, [95, 99, 104, 255], 1);

  // Header Right Actions
  canvas.drawRoundedRect(710, 18, 32, 28, 14, [241, 243, 244, 255]);
  canvas.drawText('=', 722, 26, [95, 99, 104, 255], 1);
  canvas.drawRoundedRect(750, 18, 32, 28, 14, [241, 243, 244, 255]);
  canvas.drawText('O', 762, 26, [95, 99, 104, 255], 1);
  canvas.drawRoundedRect(792, 16, 92, 32, 16, [194, 231, 255, 255]);
  canvas.drawText('Share', 820, 26, [0, 29, 53, 255], 1);

  // Secondary Toolbar Ribbon (y: 65 to 100)
  canvas.fillRect(0, 65, 900, 36, 237, 242, 250, 255);
  canvas.fillRect(0, 101, 900, 1, 224, 224, 224, 255);

  canvas.drawRoundedRect(20, 72, 24, 22, 3, [255, 255, 255, 255], [218, 220, 224, 255]);
  canvas.drawText('<', 29, 78, [95, 99, 104, 255], 1);
  canvas.drawRoundedRect(48, 72, 24, 22, 3, [255, 255, 255, 255], [218, 220, 224, 255]);
  canvas.drawText('>', 57, 78, [95, 99, 104, 255], 1);
  canvas.drawRoundedRect(78, 72, 48, 22, 3, [255, 255, 255, 255], [218, 220, 224, 255]);
  canvas.drawText('100%', 86, 78, [68, 71, 70, 255], 1);
  canvas.drawRoundedRect(132, 72, 90, 22, 3, [255, 255, 255, 255], [218, 220, 224, 255]);
  canvas.drawText('Normal text v', 138, 78, [68, 71, 70, 255], 1);
  canvas.drawRoundedRect(228, 72, 75, 22, 3, [255, 255, 255, 255], [218, 220, 224, 255]);
  canvas.drawText('Roboto v', 236, 78, [68, 71, 70, 255], 1);
  canvas.drawRoundedRect(309, 72, 36, 22, 3, [255, 255, 255, 255], [218, 220, 224, 255]);
  canvas.drawText('11', 320, 78, [68, 71, 70, 255], 1);
  canvas.drawRoundedRect(351, 72, 22, 22, 3, [255, 255, 255, 255], [218, 220, 224, 255]);
  canvas.drawText('B', 359, 78, [31, 31, 31, 255], 1);
  canvas.drawRoundedRect(377, 72, 22, 22, 3, [255, 255, 255, 255], [218, 220, 224, 255]);
  canvas.drawText('I', 386, 78, [31, 31, 31, 255], 1);
  canvas.drawRoundedRect(403, 72, 22, 22, 3, [255, 255, 255, 255], [218, 220, 224, 255]);
  canvas.drawText('U', 411, 78, [31, 31, 31, 255], 1);
  canvas.drawRoundedRect(433, 72, 36, 22, 3, [255, 255, 255, 255], [218, 220, 224, 255]);
  canvas.drawText('== v', 440, 78, [95, 99, 104, 255], 1);
  canvas.drawRoundedRect(475, 72, 36, 22, 3, [255, 255, 255, 255], [218, 220, 224, 255]);
  canvas.drawText('|||', 484, 78, [95, 99, 104, 255], 1);

  // Document Page (Centered white page with subtle drop shadow)
  canvas.fillRect(78, 118, 744, 682, 220, 222, 225, 255);
  canvas.fillRect(80, 120, 740, 680, 255, 255, 255, 255);
  canvas.strokeRect(80, 120, 740, 680, 218, 220, 224, 255, 1);

  // Page Content
  canvas.drawText('INC-IO Docs -- Workspace Architecture Spec', 130, 148, [32, 33, 36, 255], 2);
  canvas.drawText(
    'Schema-driven document filing and workflow automation for Google Drive & Gmail',
    130,
    173,
    [95, 99, 104, 255],
    1
  );
  canvas.fillRect(130, 190, 640, 1, 224, 224, 224, 255);

  canvas.drawText('1. Executive Architecture & Space Organization', 130, 206, [26, 115, 232, 255], 2);
  canvas.drawText(
    'INC-IO Docs organizes files and correspondence into structured DocumentSpaces',
    130,
    232,
    [60, 64, 67, 255],
    1
  );
  canvas.drawText(
    '(such as Projects and Proposals) without leaving Google Drive or Gmail.',
    130,
    247,
    [60, 64, 67, 255],
    1
  );
  canvas.drawText(
    'Dynamic DocumentType schemas evaluate context to capture verified metadata.',
    130,
    262,
    [60, 64, 67, 255],
    1
  );

  // Structured Table
  canvas.drawRoundedRect(130, 288, 640, 136, 6, [255, 255, 255, 255], [218, 220, 224, 255]);
  canvas.drawRoundedRect(130, 288, 640, 30, 6, [232, 240, 254, 255]);
  canvas.fillRect(130, 318, 640, 1, 218, 220, 224, 255);

  canvas.drawText('DOCUMENT SPACE TYPE', 145, 298, [11, 87, 208, 255], 1);
  canvas.drawText('TARGET DESTINATION PATH', 320, 298, [11, 87, 208, 255], 1);
  canvas.drawText('VALIDATION', 560, 298, [11, 87, 208, 255], 1);
  canvas.drawText('STATUS', 680, 298, [11, 87, 208, 255], 1);

  canvas.drawText('Projects', 145, 330, [31, 31, 31, 255], 1);
  canvas.drawText('Projects / <Contact> / <Folder>', 320, 330, [68, 71, 70, 255], 1);
  canvas.drawText('ISO-9001 Strict', 560, 330, [68, 71, 70, 255], 1);
  canvas.drawText('Active', 680, 330, [30, 142, 62, 255], 1);
  canvas.fillRect(130, 350, 640, 1, 240, 240, 240, 255);

  canvas.drawText('Proposals', 145, 362, [31, 31, 31, 255], 1);
  canvas.drawText('Proposals / <Year> / <Lead>', 320, 362, [68, 71, 70, 255], 1);
  canvas.drawText('Executive Audit', 560, 362, [68, 71, 70, 255], 1);
  canvas.drawText('Active', 680, 362, [30, 142, 62, 255], 1);
  canvas.fillRect(130, 382, 640, 1, 240, 240, 240, 255);

  canvas.drawText('Corporate Archive', 145, 394, [31, 31, 31, 255], 1);
  canvas.drawText('Operations / Archive / <Year>', 320, 394, [68, 71, 70, 255], 1);
  canvas.drawText('Standard Governance', 560, 394, [68, 71, 70, 255], 1);
  canvas.drawText('Active', 680, 394, [30, 142, 62, 255], 1);

  // Section 2
  canvas.drawText(
    '2. Automated Filing Lifecycle & Gmail PDF Archival',
    130,
    440,
    [26, 115, 232, 255],
    2
  );
  canvas.drawText(
    'Selected Drive files and Gmail message threads are evaluated against schema',
    130,
    466,
    [60, 64, 67, 255],
    1
  );
  canvas.drawText(
    'rules, moving assets into sanitized target directories with zero manual steps.',
    130,
    481,
    [60, 64, 67, 255],
    1
  );
  canvas.drawText(
    'Messages are converted to PDF format with inline CID images preserved.',
    130,
    496,
    [60, 64, 67, 255],
    1
  );

  // Architecture Process Flow
  canvas.drawRoundedRect(130, 524, 640, 116, 8, [248, 253, 249, 255], [206, 234, 214, 255]);

  canvas.drawRoundedRect(150, 544, 160, 76, 6, [255, 255, 255, 255], [189, 193, 198, 255]);
  canvas.drawText('STEP 1: CONTEXT', 160, 554, [11, 87, 208, 255], 1);
  canvas.drawText('Drive File Selected /', 160, 574, [31, 31, 31, 255], 1);
  canvas.drawText('Gmail Message Open', 160, 591, [31, 31, 31, 255], 1);

  canvas.drawText('===>', 320, 578, [11, 87, 208, 255], 2);

  canvas.drawRoundedRect(375, 544, 175, 76, 6, [255, 255, 255, 255], [189, 193, 198, 255]);
  canvas.drawText('STEP 2: VALIDATION', 385, 554, [11, 87, 208, 255], 1);
  canvas.drawText('DocumentType Rules &', 385, 574, [31, 31, 31, 255], 1);
  canvas.drawText('Metadata Field Input', 385, 591, [31, 31, 31, 255], 1);

  canvas.drawText('===>', 560, 578, [11, 87, 208, 255], 2);

  canvas.drawRoundedRect(615, 544, 140, 76, 6, [255, 255, 255, 255], [189, 193, 198, 255]);
  canvas.drawText('STEP 3: FILE', 625, 554, [30, 142, 62, 255], 1);
  canvas.drawText('Move to Shared', 625, 574, [31, 31, 31, 255], 1);
  canvas.drawText('Drive Subfolder', 625, 591, [31, 31, 31, 255], 1);

  // Blit banner-220x140.png centered on the document canvas below the architecture process flow
  const bannerPath = path.join(brandingDir, 'banner-220x140.png');
  if (fs.existsSync(bannerPath)) {
    const bannerPng = decodePng(fs.readFileSync(bannerPath));
    canvas.blit(bannerPng, 340, 648);
  }

  // 2. Google Workspace Companion Sidebar (x: 900 to 1223, width 324px)
  // -------------------------------------------------------------
  canvas.fillRect(900, 0, 324, 800, 248, 249, 250, 255);
  canvas.fillRect(900, 0, 1, 800, 224, 224, 224, 255); // left sidebar border

  // Sidebar Header (y: 0 to 56)
  canvas.fillRect(901, 0, 323, 56, 255, 255, 255, 255);
  canvas.fillRect(901, 56, 323, 1, 224, 224, 224, 255);

  // Blit logo-one-line-220x30.png centered in sidebar header
  const logoPath = path.join(brandingDir, 'logo-one-line-220x30.png');
  if (fs.existsSync(logoPath)) {
    const logoPng = decodePng(fs.readFileSync(logoPath));
    canvas.blit(logoPng, 952, 13);
  }
  canvas.drawText('x', 1202, 22, [95, 99, 104, 255], 1);

  // Card 1: Space & Type Selection (y: 66 to 285)
  canvas.drawRoundedRect(912, 66, 300, 215, 8, [255, 255, 255, 255], [218, 220, 224, 255]);
  canvas.drawText('DOCUMENT SPACE & TYPE', 924, 78, [95, 99, 104, 255], 1);

  canvas.drawText('Space Type *', 924, 96, [68, 71, 70, 255], 1);
  canvas.drawRoundedRect(924, 110, 134, 32, 6, [211, 227, 253, 255], [11, 87, 208, 255]);
  canvas.drawText('[v] Projects', 944, 122, [4, 30, 73, 255], 1);
  canvas.drawRoundedRect(1066, 110, 134, 32, 6, [255, 255, 255, 255], [200, 202, 205, 255]);
  canvas.drawText('Proposals', 1098, 122, [68, 71, 70, 255], 1);

  canvas.drawText('Document Space *', 924, 152, [68, 71, 70, 255], 1);
  canvas.drawRoundedRect(924, 166, 276, 34, 4, [255, 255, 255, 255], [116, 119, 117, 255]);
  canvas.drawText('PRJ-2026-Acme-Core', 934, 178, [31, 31, 31, 255], 1);
  canvas.drawText('v', 1180, 178, [95, 99, 104, 255], 1);

  canvas.drawText('Document Type *', 924, 210, [68, 71, 70, 255], 1);
  canvas.drawRoundedRect(924, 224, 276, 34, 4, [255, 255, 255, 255], [116, 119, 117, 255]);
  canvas.drawText('Communication Project', 934, 236, [31, 31, 31, 255], 1);
  canvas.drawText('v', 1180, 236, [95, 99, 104, 255], 1);

  // Card 2: Dynamic Document Fields (y: 292 to 570)
  canvas.drawRoundedRect(912, 292, 300, 278, 8, [255, 255, 255, 255], [218, 220, 224, 255]);
  canvas.drawText('DOCUMENT METADATA', 924, 304, [95, 99, 104, 255], 1);

  canvas.drawText('Contact *', 924, 322, [68, 71, 70, 255], 1);
  canvas.drawRoundedRect(924, 336, 276, 32, 4, [255, 255, 255, 255], [116, 119, 117, 255]);
  canvas.drawText('Acme Corporation', 934, 347, [31, 31, 31, 255], 1);

  canvas.drawText('Description *', 924, 378, [68, 71, 70, 255], 1);
  canvas.drawRoundedRect(924, 392, 276, 32, 4, [255, 255, 255, 255], [116, 119, 117, 255]);
  canvas.drawText('Q4 Architecture Specification', 934, 403, [31, 31, 31, 255], 1);

  canvas.drawText('Date *', 924, 434, [68, 71, 70, 255], 1);
  canvas.drawRoundedRect(924, 448, 276, 32, 4, [255, 255, 255, 255], [116, 119, 117, 255]);
  canvas.drawText('2026-10-29', 934, 459, [31, 31, 31, 255], 1);

  canvas.drawRoundedRect(926, 492, 18, 18, 3, [11, 87, 208, 255]);
  canvas.drawText('v', 931, 496, [255, 255, 255, 255], 1);
  canvas.drawText('Save Email to PDF', 952, 496, [31, 31, 31, 255], 1);

  canvas.drawRoundedRect(924, 520, 276, 38, 4, [241, 243, 244, 255], [224, 226, 229, 255]);
  canvas.drawText('Target: Projects/Acme Corporation/', 932, 526, [95, 99, 104, 255], 1);
  canvas.drawText('Comm - Q4 Architecture Specification.pdf', 932, 540, [31, 31, 31, 255], 1);

  // Card 3: Action Button & Notification Status (y: 580 to 765)
  canvas.drawRoundedRect(912, 580, 300, 185, 8, [255, 255, 255, 255], [218, 220, 224, 255]);

  // Primary Action Button: "File Document"
  canvas.drawRoundedRect(924, 598, 276, 44, 22, [11, 87, 208, 255]);
  canvas.drawText('FILE DOCUMENT', 984, 613, [255, 255, 255, 255], 2);

  // Notification / Validation Status Box
  canvas.drawRoundedRect(924, 656, 276, 46, 6, [230, 244, 234, 255], [206, 234, 214, 255]);
  canvas.drawCircle(940, 679, 8, [30, 142, 62, 255]);
  canvas.drawText('v', 937, 675, [255, 255, 255, 255], 1);
  canvas.drawText('Schema validated successfully', 956, 668, [19, 115, 51, 255], 1);
  canvas.drawText('Ready to file into Shared Drive', 956, 682, [19, 115, 51, 255], 1);

  canvas.drawText('Google Workspace Add-on v1.0', 975, 722, [154, 160, 166, 255], 1);

  // 3. Companion Icon Rail (Far Right, x: 1224 to 1279, width 56px)
  // -------------------------------------------------------------
  canvas.fillRect(1224, 0, 56, 800, 255, 255, 255, 255);
  canvas.fillRect(1224, 0, 1, 800, 224, 224, 224, 255);

  // Slot 1: Google Calendar
  canvas.drawRoundedRect(1238, 24, 28, 28, 6, [66, 133, 244, 255]);
  canvas.drawText('31', 1245, 34, [255, 255, 255, 255], 1);

  // Slot 2: Google Keep
  canvas.drawRoundedRect(1238, 79, 28, 28, 6, [251, 188, 4, 255]);
  canvas.drawRoundedRect(1246, 86, 12, 14, 2, [255, 255, 255, 255]);

  // Slot 3: Google Tasks
  canvas.drawRoundedRect(1238, 134, 28, 28, 6, [26, 115, 232, 255]);
  canvas.drawCircle(1252, 148, 8, [255, 255, 255, 255]);
  canvas.drawCircle(1252, 148, 5, [26, 115, 232, 255]);

  // Slot 4: Google Contacts
  canvas.drawRoundedRect(1238, 189, 28, 28, 6, [26, 115, 232, 255]);
  canvas.drawCircle(1252, 199, 4, [255, 255, 255, 255]);
  canvas.drawRoundedRect(1244, 206, 16, 8, 4, [255, 255, 255, 255]);

  canvas.fillRect(1234, 232, 36, 1, 224, 224, 224, 255);

  // Slot 5: Active Add-on Slot for INC-IO Docs
  // Active selection indicator bar on left edge
  canvas.fillRect(1224, 246, 3, 56, 11, 87, 208, 255);
  // Active pill background
  canvas.drawCircle(1252, 274, 24, [232, 240, 254, 255]);
  // Blit icon-48x48.png
  const icon48Png = decodePng(icon48Buf);
  canvas.blit(icon48Png, 1228, 250);

  canvas.fillRect(1234, 318, 36, 1, 224, 224, 224, 255);

  // Slot 6: Get Add-ons "+"
  canvas.drawCircle(1252, 348, 14, [241, 243, 244, 255], [218, 220, 224, 255]);
  canvas.drawText('+', 1249, 344, [95, 99, 104, 255], 1);

  // Encode deterministically via encodePng
  return encodePng(width, height, canvas.data);
}

export interface GeneratedBrandingAssets {
  icon48: Buffer;
  iconDev48: Buffer;
  screenshot1280x800: Buffer;
  'icon-48x48.png': Buffer;
  'icon-dev-48x48.png': Buffer;
  'screenshot-1280x800.png': Buffer;
}

/**
 * Generates companion 48x48 production and dev Workspace Add-on branding icons in memory,
 * alongside the canonical 1280x800 Google Workspace Marketplace screenshot.
 */
export function generateBrandingAssetsInMemory(brandingDir?: string): GeneratedBrandingAssets {
  const dir = brandingDir ?? path.resolve(__dirname, '../assets/branding');
  const sourcePath = path.join(dir, 'icon-128x128.png');

  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Source branding asset not found at "${sourcePath}"`);
  }

  const sourceBuf = fs.readFileSync(sourcePath);
  const sourcePng = decodePng(sourceBuf);

  if (sourcePng.width !== 128 || sourcePng.height !== 128) {
    throw new Error(
      `Expected icon-128x128.png to be 128x128, got ${sourcePng.width}x${sourcePng.height}`
    );
  }

  const srcW = 128;
  const srcH = 128;
  const dstW = 48;
  const dstH = 48;

  // Box/area sampling downsampling of the alpha channel from 128x128 to 48x48
  const downsampledAlpha = new Uint8Array(dstW * dstH);

  for (let dy = 0; dy < dstH; dy++) {
    const y0 = (dy * srcH) / dstH;
    const y1 = ((dy + 1) * srcH) / dstH;
    const startY = Math.floor(y0);
    const endY = Math.min(srcH - 1, Math.ceil(y1) - 1);

    for (let dx = 0; dx < dstW; dx++) {
      const x0 = (dx * srcW) / dstW;
      const x1 = ((dx + 1) * srcW) / dstW;
      const startX = Math.floor(x0);
      const endX = Math.min(srcW - 1, Math.ceil(x1) - 1);

      let sumAlpha = 0;
      let totalWeight = 0;

      for (let sy = startY; sy <= endY; sy++) {
        const weightY = Math.max(0, Math.min(y1, sy + 1) - Math.max(y0, sy));
        for (let sx = startX; sx <= endX; sx++) {
          const weightX = Math.max(0, Math.min(x1, sx + 1) - Math.max(x0, sx));
          const weight = weightX * weightY;
          const srcAlpha = sourcePng.data[(sy * srcW + sx) * 4 + 3];
          sumAlpha += weight * srcAlpha;
          totalWeight += weight;
        }
      }

      downsampledAlpha[dy * dstW + dx] =
        totalWeight > 0 ? Math.round(sumAlpha / totalWeight) : 0;
    }
  }

  // Ensure corner (0,0) is transparent
  downsampledAlpha[0] = 0;

  // 1. icon-48x48.png: Pure black RGB (0, 0, 0) with area-averaged alpha
  const prod48Data = Buffer.alloc(dstW * dstH * 4);
  for (let i = 0; i < dstW * dstH; i++) {
    prod48Data[i * 4] = 0; // R
    prod48Data[i * 4 + 1] = 0; // G
    prod48Data[i * 4 + 2] = 0; // B
    prod48Data[i * 4 + 3] = downsampledAlpha[i]; // A
  }
  const icon48 = encodePng(dstW, dstH, prod48Data);

  // 2. icon-dev-48x48.png: Opaque tile with light-gray #EAEAEA background (234, 234, 234, 255)
  // and medium-gray #808080 (128, 128, 128) stroke composited on top.
  const dev48Data = Buffer.alloc(dstW * dstH * 4);
  for (let i = 0; i < dstW * dstH; i++) {
    const alpha = downsampledAlpha[i];
    // Composite: 234 * (1 - alpha/255) + 128 * (alpha/255) = 234 - (106 * alpha)/255
    const gray = Math.round(234 - (106 * alpha) / 255);
    dev48Data[i * 4] = gray; // R
    dev48Data[i * 4 + 1] = gray; // G
    dev48Data[i * 4 + 2] = gray; // B
    dev48Data[i * 4 + 3] = 255; // A (opaque)
  }
  const iconDev48 = encodePng(dstW, dstH, dev48Data);

  // 3. screenshot-1280x800.png: Full Marketplace listing screenshot
  const screenshot1280x800 = composeScreenshot1280x800(dir, icon48);

  return {
    icon48,
    iconDev48,
    screenshot1280x800,
    'icon-48x48.png': icon48,
    'icon-dev-48x48.png': iconDev48,
    'screenshot-1280x800.png': screenshot1280x800,
  };
}

function main(): void {
  const brandingDir = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.resolve(__dirname, '../assets/branding');

  const assets = generateBrandingAssetsInMemory(brandingDir);
  const prodPath = path.join(brandingDir, 'icon-48x48.png');
  const devPath = path.join(brandingDir, 'icon-dev-48x48.png');
  const screenshotPath = path.join(brandingDir, 'screenshot-1280x800.png');

  fs.writeFileSync(prodPath, assets.icon48);
  fs.writeFileSync(devPath, assets.iconDev48);
  fs.writeFileSync(screenshotPath, assets.screenshot1280x800);

  console.log(`Successfully generated deterministic branding assets:`);
  console.log(` - ${prodPath}`);
  console.log(` - ${devPath}`);
  console.log(` - ${screenshotPath}`);
}

if (
  require.main === module ||
  (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename))
) {
  main();
}
