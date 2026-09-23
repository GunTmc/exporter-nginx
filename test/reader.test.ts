import { test, describe, beforeAll, afterAll } from 'bun:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { readLines } from '../src/lib/reader';
import { mkTmp, rmTmp } from './helpers';

let dir: string;
beforeAll(() => (dir = mkTmp()));
afterAll(() => rmTmp(dir));

async function read(file: string, opts?: Parameters<typeof readLines>[1]) {
  const lines: string[] = [];
  const res = await readLines(file, opts, (l) => lines.push(l));
  return { lines, res };
}
const write = (name: string, data: string | Buffer): string => {
  const f = path.join(dir, name);
  fs.writeFileSync(f, data);
  return f;
};

describe('readLines', () => {
  test('LF, CRLF, dan baris terakhir tanpa newline', async () => {
    const { lines } = await read(write('a.log', 'satu\r\ndua\ntiga'));
    assert.deepEqual(lines, ['satu', 'dua', 'tiga']);
  });

  test('file kosong', async () => {
    const { lines, res } = await read(write('empty.log', ''));
    assert.deepEqual(lines, []);
    assert.equal(res.bytes, 0);
  });

  test('karakter multibyte yang terbelah di batas chunk 1 MB tidak rusak', async () => {
    const unit = 'é€😀'; // 2 + 3 + 4 byte
    const src: string[] = [];
    for (let i = 0; i < 9000; i++) src.push(unit.repeat(40) + i);
    const f = write('utf8.log', src.join('\n') + '\n');
    assert.ok(fs.statSync(f).size > 3 * (1 << 20), 'harus melewati beberapa batas chunk');
    const { lines } = await read(f);
    assert.equal(lines.length, src.length);
    assert.deepEqual(lines, src);
    assert.ok(!lines.some((l) => l.includes('�')));
  });

  test('.gz dibaca sama seperti file biasa', async () => {
    const f = write('a.log.gz', zlib.gzipSync('satu\ndua\ntiga\n'));
    const { lines } = await read(f);
    assert.deepEqual(lines, ['satu', 'dua', 'tiga']);
  });

  test('tail: baris pertama yang terpotong dibuang, sisanya utuh', async () => {
    const all = Array.from({ length: 10 }, (_, i) => `baris-${i}-` + 'x'.repeat(20));
    const text = all.join('\n') + '\n';
    const { lines } = await read(write('tail.log', text), { tail: 100 });
    assert.ok(lines.length >= 2 && lines.length < all.length);
    assert.deepEqual(lines, all.slice(all.length - lines.length));
  });

  test('baris melebihi maxLine dipotong dan dihitung; baris lain utuh (dalam satu chunk)', async () => {
    const f = write('long1.log', 'awal\n' + 'a'.repeat(500) + '\nakhir\n');
    const { lines, res } = await read(f, { maxLine: 100 });
    assert.deepEqual(lines, ['awal', 'a'.repeat(100), 'akhir']);
    assert.equal(res.truncatedLines, 1);
  });

  test('baris raksasa lintas beberapa chunk tidak menumpuk di memori dan baris sesudahnya tetap terbaca', async () => {
    const f = write('long2.log', 'awal\n' + 'b'.repeat(3 * (1 << 20) + 123) + '\nakhir\n');
    const { lines, res } = await read(f, { maxLine: 1000 });
    assert.deepEqual(lines, ['awal', 'b'.repeat(1000), 'akhir']);
    assert.equal(res.truncatedLines, 1);
  });

  test('baris raksasa di akhir file tanpa newline', async () => {
    const f = write('long3.log', 'awal\n' + 'c'.repeat(3 * (1 << 20)));
    const { lines, res } = await read(f, { maxLine: 1000 });
    assert.deepEqual(lines, ['awal', 'c'.repeat(1000)]);
    assert.equal(res.truncatedLines, 1);
  });

  test('error baca pada .gz menjadi rejection, bukan crash proses', async () => {
    const d = path.join(dir, 'folder.gz');
    fs.mkdirSync(d);
    await assert.rejects(read(d));
  });

  test('.gz rusak menjadi rejection', async () => {
    const f = write('bad.log.gz', Buffer.from('ini bukan gzip sama sekali'));
    await assert.rejects(read(f));
  });
});
