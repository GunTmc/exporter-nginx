import { test, describe } from 'bun:test';
import assert from 'node:assert/strict';
import { Aggregator } from '../src/lib/aggregate';
import type { ParsedLine } from '../src/lib/types';

function mkLine(over: Partial<ParsedLine> = {}): ParsedLine {
  return {
    ip: '10.0.0.1',
    clientIp: '10.0.0.1',
    ts: 1_700_000_000,
    method: 'GET',
    path: '/api/v1/x',
    searchTerm: null,
    status: 200,
    size: 100,
    referer: '-',
    ua: 'ua-a',
    raw: 'raw-line',
    ...over,
  };
}

describe('Aggregator: fingerprint = method + path + status', () => {
  test('request identik masuk group yang sama', () => {
    const agg = new Aggregator();
    agg.add(mkLine());
    agg.add(mkLine());
    const groups = agg.toGroups();
    assert.equal(groups.length, 1);
    assert.equal(groups[0].count, 2);
  });
  test('method, path, atau status beda -> group beda', () => {
    const agg = new Aggregator();
    agg.add(mkLine());
    agg.add(mkLine({ method: 'POST' }));
    agg.add(mkLine({ path: '/api/v1/y' }));
    agg.add(mkLine({ status: 404 }));
    assert.equal(agg.toGroups().length, 4);
  });
});

describe('Aggregator: IP', () => {
  test('ipCount akurat walau daftar ips di-cap', () => {
    const agg = new Aggregator();
    for (let i = 0; i < 40; i++) agg.add(mkLine({ clientIp: `10.0.0.${i}` }));
    const g = agg.toGroups()[0];
    assert.equal(g.ipCount, 40);
    assert.ok(g.ips.length <= 30);
  });
  test('IP klien yang sama tidak dihitung dobel', () => {
    const agg = new Aggregator();
    agg.add(mkLine({ clientIp: '1.1.1.1' }));
    agg.add(mkLine({ clientIp: '1.1.1.1' }));
    agg.add(mkLine({ clientIp: '2.2.2.2' }));
    const g = agg.toGroups()[0];
    assert.equal(g.ipCount, 2);
    assert.equal(g.count, 3);
  });
});

describe('Aggregator: avgSize dari akumulator', () => {
  test('rata-rata dihitung benar tanpa menyimpan semua ukuran', () => {
    const agg = new Aggregator();
    for (const size of [100, 200, 300]) agg.add(mkLine({ size }));
    assert.equal(agg.toGroups()[0].avgSize, 200);
  });
});

describe('Aggregator: occ di-cap maxOcc', () => {
  test('daftar waktu kejadian dipotong ke maxOcc terakhir, count tetap akurat', () => {
    const agg = new Aggregator({ maxOcc: 5 });
    for (let i = 0; i < 20; i++) agg.add(mkLine({ ts: 1000 + i }));
    const g = agg.toGroups()[0];
    assert.equal(g.count, 20);
    assert.equal(g.occ.length, 5);
    assert.deepEqual(g.occ, [1015, 1016, 1017, 1018, 1019]);
  });
});

describe('Aggregator: samples (1 pertama + terbaru)', () => {
  test('sampel pertama selalu ada, sisanya yang terbaru', () => {
    const agg = new Aggregator({ samples: 3 });
    for (let i = 0; i < 10; i++) agg.add(mkLine({ ts: 1000 + i, raw: `raw-${i}` }));
    const g = agg.toGroups()[0];
    assert.equal(g.samples.length, 3);
    assert.equal(g.samples[0].raw, 'raw-0');
    assert.deepEqual(
      g.samples.slice(1).map((s) => s.raw),
      ['raw-8', 'raw-9']
    );
  });
  test('samples=1: hanya sampel pertama', () => {
    const agg = new Aggregator({ samples: 1 });
    agg.add(mkLine({ raw: 'a' }));
    agg.add(mkLine({ raw: 'b' }));
    const g = agg.toGroups()[0];
    assert.equal(g.samples.length, 1);
    assert.equal(g.samples[0].raw, 'a');
  });
});

describe('Aggregator: searchTerms', () => {
  test('dihitung per kata kunci, request tanpa search diabaikan', () => {
    const agg = new Aggregator();
    agg.add(mkLine({ searchTerm: 'neo' }));
    agg.add(mkLine({ searchTerm: 'neo' }));
    agg.add(mkLine({ searchTerm: 'ultra' }));
    agg.add(mkLine({ searchTerm: null }));
    const g = agg.toGroups()[0];
    assert.equal(g.count, 4);
    const byTerm = Object.fromEntries(g.searchTerms.map((s) => [s.term, s.count]));
    assert.deepEqual(byTerm, { neo: 2, ultra: 1 });
  });
});

describe('Aggregator: maxGroups', () => {
  test('group baru sesudah batas diabaikan dan dicatat di dropped; group lama tetap akurat', () => {
    const agg = new Aggregator({ maxGroups: 2 });
    agg.add(mkLine({ path: '/a' }));
    agg.add(mkLine({ path: '/b' }));
    agg.add(mkLine({ path: '/c' })); // group baru, ditolak
    agg.add(mkLine({ path: '/a' })); // group lama, tetap dihitung
    assert.equal(agg.toGroups().length, 2);
    assert.equal(agg.dropped, 1);
    assert.equal(agg.kept, 3);
    assert.equal(agg.toGroups().find((g) => g.path === '/a')!.count, 2);
  });
});

describe('Aggregator: urutan hasil', () => {
  test('toGroups() diurutkan dari jumlah terbanyak', () => {
    const agg = new Aggregator();
    agg.add(mkLine({ path: '/sedikit' }));
    for (let i = 0; i < 3; i++) agg.add(mkLine({ path: '/banyak' }));
    const groups = agg.toGroups();
    assert.equal(groups[0].path, '/banyak');
    assert.equal(groups[1].path, '/sedikit');
  });
});
