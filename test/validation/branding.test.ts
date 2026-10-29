import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { describe, it, expect } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import {
  generateBrandingAssetsInMemory,
  decodePng,
  encodePng,
  crc32,
  paethPredictor,
  MarketplaceListingConfigSchema,
  type MarketplaceListingConfig,
} from '../../infra/generate-branding';
import {
  DEFAULT_DEV_LOGO_URL,
  DEFAULT_PROD_LOGO_URL,
} from '../../infra/deployment-manifest';

describe('Branding Assets & Deterministic Generator', () => {
  const brandingDir = path.resolve(__dirname, '../../assets/branding');
  const dockerignorePath = path.resolve(__dirname, '../../.dockerignore');

  const EXPECTED_DIMENSIONS: Record<string, { width: number; height: number }> = {
    'icon-32x32.png': { width: 32, height: 32 },
    'favicon-32x32.png': { width: 32, height: 32 },
    'icon-128x128.png': { width: 128, height: 128 },
    'banner-220x140.png': { width: 220, height: 140 },
    'logo-one-line-220x30.png': { width: 220, height: 30 },
    'icon-48x48.png': { width: 48, height: 48 },
    'icon-dev-48x48.png': { width: 48, height: 48 },
    'screenshot-1280x800.png': { width: 1280, height: 800 },
  };

  const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  it('contains no space-named .png files in assets/branding', () => {
    const files = fs.readdirSync(brandingDir);
    const pngFiles = files.filter((f) => f.endsWith('.png'));
    const spaceNamed = pngFiles.filter((f) => /\s/.test(f));
    expect(spaceNamed).toEqual([]);
  });

  it('has all 8 standardized PNG assets with valid PNG signature and correct dimensions', () => {
    for (const [filename, dims] of Object.entries(EXPECTED_DIMENSIONS)) {
      const filePath = path.join(brandingDir, filename);
      expect(fs.existsSync(filePath), `Expected ${filename} to exist on disk`).toBe(true);

      const buffer = fs.readFileSync(filePath);
      expect(buffer.subarray(0, 8)).toEqual(PNG_HEADER);

      const decoded = decodePng(buffer);
      expect(decoded.width, `${filename} width`).toBe(dims.width);
      expect(decoded.height, `${filename} height`).toBe(dims.height);
    }
  });

  it('.dockerignore excludes assets/branding/', () => {
    expect(fs.existsSync(dockerignorePath)).toBe(true);
    const dockerignore = fs.readFileSync(dockerignorePath, 'utf8');
    const lines = dockerignore.split(/\r?\n/).map((l) => l.trim());
    expect(lines).toContain('assets/branding/');
  });

  it('guarantees zero drift between in-memory generator and disk assets', () => {
    const inMemory = generateBrandingAssetsInMemory(brandingDir);
    const diskProd48 = fs.readFileSync(path.join(brandingDir, 'icon-48x48.png'));
    const diskDev48 = fs.readFileSync(path.join(brandingDir, 'icon-dev-48x48.png'));
    const diskScreenshot = fs.readFileSync(path.join(brandingDir, 'screenshot-1280x800.png'));

    expect(inMemory.icon48.equals(diskProd48)).toBe(true);
    expect(inMemory.iconDev48.equals(diskDev48)).toBe(true);
    expect(inMemory.screenshot1280x800.equals(diskScreenshot)).toBe(true);
    expect(inMemory['screenshot-1280x800.png'].equals(diskScreenshot)).toBe(true);
  });

  it('icon-48x48.png has transparent corner (0,0) and pure black RGB for non-transparent pixels', () => {
    const buffer = fs.readFileSync(path.join(brandingDir, 'icon-48x48.png'));
    const decoded = decodePng(buffer);
    expect(decoded.width).toBe(48);
    expect(decoded.height).toBe(48);

    // Corner (0,0) must be transparent: A === 0
    const cornerAlpha = decoded.data[3];
    expect(cornerAlpha).toBe(0);

    // All pixels with alpha > 0 must have pure black RGB (0, 0, 0)
    let nonTransparentPixelCount = 0;
    for (let i = 0; i < decoded.width * decoded.height; i++) {
      const r = decoded.data[i * 4];
      const g = decoded.data[i * 4 + 1];
      const b = decoded.data[i * 4 + 2];
      const a = decoded.data[i * 4 + 3];

      if (a > 0) {
        nonTransparentPixelCount++;
        expect(r).toBe(0);
        expect(g).toBe(0);
        expect(b).toBe(0);
      }
    }

    expect(nonTransparentPixelCount).toBeGreaterThan(0);
  });

  it('icon-dev-48x48.png has opaque #EAEAEA corners and composited #808080 strokes', () => {
    const buffer = fs.readFileSync(path.join(brandingDir, 'icon-dev-48x48.png'));
    const decoded = decodePng(buffer);
    expect(decoded.width).toBe(48);
    expect(decoded.height).toBe(48);

    // Check all 4 corners are opaque #EAEAEA (234, 234, 234, 255)
    const corners = [
      0, // (0, 0)
      47, // (47, 0)
      47 * 48, // (0, 47)
      47 * 48 + 47, // (47, 47)
    ];

    for (const cornerIdx of corners) {
      const r = decoded.data[cornerIdx * 4];
      const g = decoded.data[cornerIdx * 4 + 1];
      const b = decoded.data[cornerIdx * 4 + 2];
      const a = decoded.data[cornerIdx * 4 + 3];

      expect(r).toBe(234);
      expect(g).toBe(234);
      expect(b).toBe(234);
      expect(a).toBe(255);
    }

    // Every pixel in dev icon must be opaque (A === 255) and pure gray (R === G && G === B)
    let strokePixelCount = 0;
    let minGray = 255;
    for (let i = 0; i < decoded.width * decoded.height; i++) {
      const r = decoded.data[i * 4];
      const g = decoded.data[i * 4 + 1];
      const b = decoded.data[i * 4 + 2];
      const a = decoded.data[i * 4 + 3];

      expect(a).toBe(255);
      expect(r).toBe(g);
      expect(g).toBe(b);

      if (r < 234) {
        strokePixelCount++;
        if (r < minGray) {
          minGray = r;
        }
      }
    }

    // The stroke must exist and blend down towards medium gray #808080 (128)
    expect(strokePixelCount).toBeGreaterThan(0);
    expect(minGray).toBeLessThanOrEqual(135);
    expect(minGray).toBeGreaterThanOrEqual(128);
  });

  describe('PNG Codec & Filters', () => {
    it('computes IEEE 802.3 CRC32 correctly for standard check vectors', () => {
      // Standard check string "123456789" => 0xCBF43926
      const vector = Buffer.from('123456789', 'ascii');
      expect(crc32(vector)).toBe(0xcbf43926);
    });

    it('round-trips raw RGBA buffers through encodePng and decodePng', () => {
      const w = 4;
      const h = 4;
      const rawData = Buffer.alloc(w * h * 4);
      for (let i = 0; i < w * h * 4; i++) {
        rawData[i] = (i * 17 + 23) & 0xff;
      }

      const encoded = encodePng(w, h, rawData);
      expect(encoded.subarray(0, 8)).toEqual(PNG_HEADER);

      const decoded = decodePng(encoded);
      expect(decoded.width).toBe(w);
      expect(decoded.height).toBe(h);
      expect(decoded.data.equals(rawData)).toBe(true);
    });

    it('decodes all 5 RFC 2083 filter types: 0 (None), 1 (Sub), 2 (Up), 3 (Average), 4 (Paeth)', () => {
      const w = 3;
      const h = 5;
      const bpp = 4;
      // Synthetic scanlines with each of the 5 filters on different rows
      const uncompressed = Buffer.alloc(h * (1 + w * bpp));

      // Row 0: Filter 0 (None)
      uncompressed[0] = 0;
      for (let i = 0; i < w * bpp; i++) {
        uncompressed[1 + i] = 10 + i;
      }

      // Row 1: Filter 1 (Sub)
      const r1 = 1 * (1 + w * bpp);
      uncompressed[r1] = 1;
      for (let i = 0; i < w * bpp; i++) {
        uncompressed[r1 + 1 + i] = 5;
      }

      // Row 2: Filter 2 (Up)
      const r2 = 2 * (1 + w * bpp);
      uncompressed[r2] = 2;
      for (let i = 0; i < w * bpp; i++) {
        uncompressed[r2 + 1 + i] = 7;
      }

      // Row 3: Filter 3 (Average)
      const r3 = 3 * (1 + w * bpp);
      uncompressed[r3] = 3;
      for (let i = 0; i < w * bpp; i++) {
        uncompressed[r3 + 1 + i] = 3;
      }

      // Row 4: Filter 4 (Paeth)
      const r4 = 4 * (1 + w * bpp);
      uncompressed[r4] = 4;
      for (let i = 0; i < w * bpp; i++) {
        uncompressed[r4 + 1 + i] = 2;
      }

      const compressed = zlib.deflateSync(uncompressed, { level: 9 });

      // Build synthetic PNG chunks
      const makeChunk = (type: string, data: Buffer) => {
        const typeBuf = Buffer.from(type, 'ascii');
        const lenBuf = Buffer.alloc(4);
        lenBuf.writeUInt32BE(data.length, 0);
        const crcPayload = Buffer.concat([typeBuf, data]);
        const crcBuf = Buffer.alloc(4);
        crcBuf.writeUInt32BE(crc32(crcPayload), 0);
        return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
      };

      const ihdrData = Buffer.alloc(13);
      ihdrData.writeUInt32BE(w, 0);
      ihdrData.writeUInt32BE(h, 4);
      ihdrData.writeUInt8(8, 8);
      ihdrData.writeUInt8(6, 9);
      ihdrData.writeUInt8(0, 10);
      ihdrData.writeUInt8(0, 11);
      ihdrData.writeUInt8(0, 12);

      const syntheticPng = Buffer.concat([
        PNG_HEADER,
        makeChunk('IHDR', ihdrData),
        makeChunk('IDAT', compressed),
        makeChunk('IEND', Buffer.alloc(0)),
      ]);

      const decoded = decodePng(syntheticPng);
      expect(decoded.width).toBe(w);
      expect(decoded.height).toBe(h);

      // Verify row 0: none
      for (let i = 0; i < w * bpp; i++) {
        expect(decoded.data[i]).toBe(10 + i);
      }

      // Verify row 1: sub
      for (let i = 0; i < w * bpp; i++) {
        const prev = i >= bpp ? decoded.data[w * bpp + i - bpp] : 0;
        expect(decoded.data[w * bpp + i]).toBe((5 + prev) & 0xff);
      }

      // Verify Paeth predictor directly
      expect(paethPredictor(10, 20, 15)).toBe(15);
      expect(paethPredictor(10, 20, 10)).toBe(20);
      expect(paethPredictor(100, 100, 100)).toBe(100);
    });

    it('rejects invalid PNG signatures or malformed data', () => {
      expect(() => decodePng(Buffer.from('not a png file'))).toThrow(/Invalid PNG signature/);
    });
  });

  describe('Marketplace Store Listing Configuration (#232)', () => {
    const listingJsonPath = path.join(brandingDir, 'marketplace-listing.json');
    const deploymentTemplatePath = path.resolve(__dirname, '../../infra/deployment.template.json');

    it('marketplace-listing.json exists and strictly satisfies MarketplaceListingConfigSchema', () => {
      expect(fs.existsSync(listingJsonPath), 'marketplace-listing.json must exist').toBe(true);

      const rawJson = fs.readFileSync(listingJsonPath, 'utf8');
      const parsed = JSON.parse(rawJson);

      const isValid = Value.Check(MarketplaceListingConfigSchema, parsed);
      if (!isValid) {
        const errors = [...Value.Errors(MarketplaceListingConfigSchema, parsed)];
        throw new Error(`Schema validation errors: ${JSON.stringify(errors, null, 2)}`);
      }
      expect(isValid).toBe(true);

      const listing = parsed as MarketplaceListingConfig;
      expect(listing.visibility).toBe('PRIVATE_DOMAIN_ONLY');
      expect(listing.oauthConsentScreen.userType).toBe('INTERNAL');
      expect(listing.oauthConsentScreen.appName).toBe('INC-IO Docs');
      expect(listing.storeListing.appName).toBe('INC-IO Docs');
      expect(listing.storeListing.shortDescription.length).toBeLessThanOrEqual(200);
      expect(listing.storeListing.shortDescription.length).toBeGreaterThan(10);
    });

    it('oauthConsentScreen.oauthScopes deeply equals deployment.template.json oauthScopes', () => {
      const listing = JSON.parse(fs.readFileSync(listingJsonPath, 'utf8')) as MarketplaceListingConfig;
      const template = JSON.parse(fs.readFileSync(deploymentTemplatePath, 'utf8')) as {
        oauthScopes: string[];
      };

      expect(listing.oauthConsentScreen.oauthScopes).toEqual(template.oauthScopes);
    });

    it('storeListing companion logo URLs match canonical dev and prod URLs', () => {
      const listing = JSON.parse(fs.readFileSync(listingJsonPath, 'utf8')) as MarketplaceListingConfig;
      expect(listing.storeListing.assets.companionLogoDev48.url).toBe(DEFAULT_DEV_LOGO_URL);
      expect(listing.storeListing.assets.companionLogoProd48.url).toBe(DEFAULT_PROD_LOGO_URL);
    });

    it('every asset descriptor in marketplace-listing.json points to a valid PNG with matching dimensions', () => {
      const listing = JSON.parse(fs.readFileSync(listingJsonPath, 'utf8')) as MarketplaceListingConfig;
      const repoRoot = path.resolve(__dirname, '../..');

      const assetDescriptors: Array<{ path: string; width: number; height: number }> = [
        listing.storeListing.assets.applicationIcon32,
        listing.storeListing.assets.applicationIcon128,
        listing.storeListing.assets.cardBanner220x140,
        ...listing.storeListing.assets.screenshots,
        listing.storeListing.assets.companionLogoProd48,
        listing.storeListing.assets.companionLogoDev48,
      ];

      for (const asset of assetDescriptors) {
        const absolutePath = path.resolve(repoRoot, asset.path);
        expect(fs.existsSync(absolutePath), `Asset file must exist at ${asset.path}`).toBe(true);

        const buf = fs.readFileSync(absolutePath);
        expect(buf.subarray(0, 8)).toEqual(PNG_HEADER);

        const decoded = decodePng(buf);
        expect(decoded.width, `${asset.path} width`).toBe(asset.width);
        expect(decoded.height, `${asset.path} height`).toBe(asset.height);
      }
    });
  });
});
