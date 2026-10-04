require('./helpers');
const { test } = require('node:test');
const assert = require('node:assert');
const sharp = require('sharp');
const { encodeImageToken, decodeImageToken, publicImageUrl } = require('../../src/modules/images/image-token');
const { hidePlate } = require('../../src/modules/images/plate-blur');

const PHOTO = 'https://res.cloudinary.com/mysawari/image/upload/v1/my-sawari/vehicles/car-1.jpg';

test('photo addresses only leave the API as encrypted tokens', () => {
  const url = publicImageUrl(PHOTO, 'https://api.example');
  assert.match(url, /^https:\/\/api\.example\/api\/images\/blur\?t=[A-Za-z0-9_-]+$/);
  assert.ok(!url.includes('cloudinary') && !url.includes('car-1'), 'the original address must not be readable');
  // Same photo, same URL — phones keep their cached copy.
  assert.strictEqual(publicImageUrl(PHOTO, 'https://api.example'), url);
  // The token decodes to the (resized) original on the server only.
  const token = new URL(url).searchParams.get('t');
  assert.match(decodeImageToken(token), /^https:\/\/res\.cloudinary\.com\/mysawari\/image\/upload\/.*car-1\.jpg$/);
});

test('altered or made-up image tokens are rejected', () => {
  const token = encodeImageToken(PHOTO);
  const flipped = token.slice(0, 20) + (token[20] === 'A' ? 'B' : 'A') + token.slice(21);
  for (const bad of [flipped, token.slice(0, -2), 'aGVsbG8gd29ybGQgdGhpcyBpcyBmYWtl', '', 'not a token!', 'x'.repeat(5000), null, {}]) {
    assert.strictEqual(decodeImageToken(bad), null, String(bad).slice(0, 40));
  }
});

test('a hidden plate keeps nothing of its characters (irreversible)', async () => {
  // A "plate": dark characters on white. A second copy has the same pixels shuffled within each quarter of
  // the covered area — every character destroyed, same quarter averages. The covers must be identical,
  // proving the result holds no information about the characters.
  const W = 400, H = 200;
  const make = () => {
    const data = Buffer.alloc(W * H * 3, 255);
    for (let y = 70; y < 130; y++) for (let x = 60; x < 340; x++) if ((Math.floor(x / 12) + Math.floor(y / 15)) % 3 === 0) data.fill(20, (y * W + x) * 3, (y * W + x) * 3 + 3);
    return { data, width: W, height: H };
  };
  const plate = [[100, 80], [300, 80], [300, 120], [100, 120]];
  const real = make();
  const scrambled = make();
  // The covered area is the plate grown by 12% / 15% around its centre: x 88-312, y 77-123.
  const area = { x1: 88, y1: 77, x2: 312, y2: 123 };
  const midX = area.x1 + Math.floor((area.x2 - area.x1) / 2), midY = area.y1 + Math.floor((area.y2 - area.y1) / 2);
  for (const [qx1, qy1, qx2, qy2] of [[area.x1, area.y1, midX, midY], [midX, area.y1, area.x2, midY], [area.x1, midY, midX, area.y2], [midX, midY, area.x2, area.y2]]) {
    const idx = [];
    for (let y = qy1; y < qy2; y++) for (let x = qx1; x < qx2; x++) idx.push((y * W + x) * 3);
    const values = idx.map((i) => real.data[i]).reverse(); // a different arrangement of the same pixels
    idx.forEach((i, k) => scrambled.data.fill(values[k], i, i + 3));
  }
  assert.ok(!real.data.equals(scrambled.data), 'the two plates differ');

  const a = await hidePlate(real, plate);
  const b = await hidePlate(scrambled, plate);
  const pixelsA = await sharp(a.input).raw().toBuffer();
  const pixelsB = await sharp(b.input).raw().toBuffer();
  assert.ok(pixelsA.equals(pixelsB), 'the cover must depend only on the quarter averages, never on the characters');
});
