import { test, describe } from 'bun:test';
import assert from 'node:assert/strict';
import { parseLine, parseNginxTime, normalizePath } from '../src/lib/parser';

describe('parseNginxTime', () => {
  test('offset positif (WIB, +0700)', () => {
    const ts = parseNginxTime('23/Sep/2026:03:14:01 +0700');
    assert.equal(new Date(ts! * 1000).toISOString(), '2026-09-22T20:14:01.000Z');
  });
  test('offset negatif', () => {
    const ts = parseNginxTime('23/Sep/2026:03:14:01 -0500');
    assert.equal(new Date(ts! * 1000).toISOString(), '2026-09-23T08:14:01.000Z');
  });
  test('UTC (+0000)', () => {
    const ts = parseNginxTime('01/Jan/2026:00:00:00 +0000');
    assert.equal(new Date(ts! * 1000).toISOString(), '2026-01-01T00:00:00.000Z');
  });
  test('format tidak valid -> null', () => {
    assert.equal(parseNginxTime('format-tanggal-salah'), null);
    assert.equal(parseNginxTime(undefined), null);
  });
});

describe('normalizePath', () => {
  test('UUID -> {id}', () => {
    assert.equal(normalizePath('/api/v1/office/branch/8503c839-798c-4f0a-a98d-535a86f5daa3'), '/api/v1/office/branch/{id}');
  });
  test('segmen numerik >=2 digit -> {id}', () => {
    assert.equal(normalizePath('/api/v1/office/branch/42'), '/api/v1/office/branch/{id}');
    assert.equal(normalizePath('/api/v1/office/branch/9999999'), '/api/v1/office/branch/{id}');
  });
  test('angka satu digit tidak dianggap id', () => {
    assert.equal(normalizePath('/api/v1/office/branch/5'), '/api/v1/office/branch/5');
  });
  test('path tanpa id tidak berubah', () => {
    assert.equal(normalizePath('/health'), '/health');
  });
});

const REAL_LINE =
  '10.96.245.3 - - [23/Sep/2026:03:14:01 +0700] "GET /api/v1/office/good-stock?page=1&size=10&search=neo+rheum&branchIds=8503c839-798c-4f0a-a98d-535a86f5daa3&departmentId=c7cf9620-12fb-4f3f-b29a-2e8cba6467b2&isAdvanceSearch=true HTTP/1.0" 200 737 "https://portal.seemedik.com/office/goods-stock" "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36" "180.243.98.128"';

describe('parseLine: baris nyata (nginx di belakang load balancer)', () => {
  test('field dasar terbaca benar', () => {
    const p = parseLine(REAL_LINE)!;
    assert.ok(p);
    assert.equal(p.method, 'GET');
    assert.equal(p.path, '/api/v1/office/good-stock'); // query dibuang dari path
    assert.equal(p.status, 200);
    assert.equal(p.size, 737);
    assert.equal(p.referer, 'https://portal.seemedik.com/office/goods-stock');
    assert.equal(p.searchTerm, 'neo rheum'); // "+" di query string -> spasi
  });
  test('remote_addr (LB internal) vs clientIp (field ke-11) berbeda', () => {
    const p = parseLine(REAL_LINE)!;
    assert.equal(p.ip, '10.96.245.3');
    assert.equal(p.clientIp, '180.243.98.128');
  });
  test('tanpa field ke-11: clientIp jatuh ke remote_addr', () => {
    const line = '10.0.0.5 - - [23/Sep/2026:03:14:01 +0700] "GET /health HTTP/1.1" 200 2 "-" "-"';
    const p = parseLine(line)!;
    assert.equal(p.ip, '10.0.0.5');
    assert.equal(p.clientIp, '10.0.0.5');
  });
  test('field ke-11 berisi "-": clientIp jatuh ke remote_addr', () => {
    const line = '10.0.0.5 - - [23/Sep/2026:03:14:01 +0700] "GET /health HTTP/1.1" 200 2 "-" "-" "-"';
    const p = parseLine(line)!;
    assert.equal(p.clientIp, '10.0.0.5');
  });
});

describe('parseLine: kasus tepi', () => {
  test('baris kosong / bukan format access log -> null', () => {
    assert.equal(parseLine(''), null);
    assert.equal(parseLine('ini bukan access log nginx sama sekali'), null);
  });
  test('waktu tidak valid -> null', () => {
    assert.equal(parseLine('10.0.0.1 - - [format-tanggal-salah] "GET / HTTP/1.1" 200 1 "-" "-"'), null);
  });
  test('size "-" dibaca sebagai 0', () => {
    const p = parseLine('10.0.0.1 - - [23/Sep/2026:03:14:01 +0700] "GET / HTTP/1.1" 304 - "-" "-"')!;
    assert.equal(p.size, 0);
  });
  test('tanpa query string: searchTerm null', () => {
    const p = parseLine('10.0.0.1 - - [23/Sep/2026:03:14:01 +0700] "GET /health HTTP/1.1" 200 2 "-" "-"')!;
    assert.equal(p.searchTerm, null);
  });
  test('query string tanpa parameter search: searchTerm null', () => {
    const p = parseLine('10.0.0.1 - - [23/Sep/2026:03:14:01 +0700] "GET /api?page=1 HTTP/1.1" 200 2 "-" "-"')!;
    assert.equal(p.searchTerm, null);
  });
});
