import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';

export function decodePng(data) {
  assert.equal(data.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  let width, height, channels;
  const chunks = [];
  for (let offset = 8; offset < data.length;) {
    const length = data.readUInt32BE(offset);
    const kind = data.toString('ascii', offset + 4, offset + 8);
    const body = data.subarray(offset + 8, offset + 8 + length);
    if (kind === 'IHDR') {
      width = body.readUInt32BE(0); height = body.readUInt32BE(4);
      assert.equal(body[8], 8, '8-bit PNG');
      assert.ok(body[9] === 2 || body[9] === 6, 'RGB or RGBA PNG');
      assert.equal(body[12], 0, 'non-interlaced PNG');
      channels = body[9] === 6 ? 4 : 3;
    }
    if (kind === 'IDAT') chunks.push(body);
    offset += length + 12;
  }
  assert.ok(width && height && channels);
  const stride = width * channels;
  const filtered = inflateSync(Buffer.concat(chunks));
  assert.equal(filtered.length, (stride + 1) * height);
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = filtered[y * (stride + 1)];
    assert.ok(filter <= 4);
    for (let x = 0; x < stride; x++) {
      const index = y * stride + x;
      const left = x >= channels ? pixels[index - channels] : 0;
      const up = y > 0 ? pixels[index - stride] : 0;
      const upperLeft = y > 0 && x >= channels ? pixels[index - stride - channels] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      if (filter === 2) predictor = up;
      if (filter === 3) predictor = Math.floor((left + up) / 2);
      if (filter === 4) {
        const p = left + up - upperLeft;
        const a = Math.abs(p - left), b = Math.abs(p - up), c = Math.abs(p - upperLeft);
        predictor = a <= b && a <= c ? left : b <= c ? up : upperLeft;
      }
      pixels[index] = (filtered[y * (stride + 1) + 1 + x] + predictor) & 255;
    }
  }
  return { width, height, channels, pixels };
}

export function uniqueColours(image, limit = 1_000_000) {
  const seen = new Set();
  const { width, height, channels, pixels } = image;
  for (let i = 0; i < width * height; i++) {
    const o = i * channels;
    seen.add((pixels[o] << 16) | (pixels[o + 1] << 8) | pixels[o + 2]);
    if (seen.size >= limit) break;
  }
  return seen.size;
}
