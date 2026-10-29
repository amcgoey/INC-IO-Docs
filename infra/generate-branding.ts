import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';

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
function makeChunk(type: string, data: Buffer): Buffer {
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

export interface GeneratedBrandingAssets {
  icon48: Buffer;
  iconDev48: Buffer;
  'icon-48x48.png': Buffer;
  'icon-dev-48x48.png': Buffer;
}

/**
 * Generates companion 48x48 production and dev Workspace Add-on branding icons in memory.
 *
 * - icon-48x48.png: Downsamples icon-128x128.png using area sampling of alpha channel,
 *   forcing RGB to pure black (0,0,0) with area-averaged alpha.
 * - icon-dev-48x48.png: 48x48 opaque tile with light-gray #EAEAEA background and
 *   downsampled hex stroke composited in medium-gray #808080.
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

  return {
    icon48,
    iconDev48,
    'icon-48x48.png': icon48,
    'icon-dev-48x48.png': iconDev48,
  };
}

function main(): void {
  const brandingDir = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.resolve(__dirname, '../assets/branding');

  const assets = generateBrandingAssetsInMemory(brandingDir);
  const prodPath = path.join(brandingDir, 'icon-48x48.png');
  const devPath = path.join(brandingDir, 'icon-dev-48x48.png');

  fs.writeFileSync(prodPath, assets.icon48);
  fs.writeFileSync(devPath, assets.iconDev48);

  console.log(`Successfully generated deterministic branding assets:`);
  console.log(` - ${prodPath}`);
  console.log(` - ${devPath}`);
}

if (
  require.main === module ||
  (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename))
) {
  main();
}
