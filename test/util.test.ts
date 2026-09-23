import { test, describe } from 'bun:test';
import assert from 'node:assert/strict';
import { parseClock, parseSize, parseIntOpt, parsePositiveOpt, truncate, makeMasker } from '../src/lib/util';

describe('parseClock', () => {
  test('HH:MM -> :00 (dari) atau :59 (sampai)', () => {
    assert.equal(parseClock('8:30', false), '08:30:00');
    assert.equal(parseClock('8:30', true), '08:30:59');
  });
  test('HH:MM:SS dipertahankan', () => {
    assert.equal(parseClock('08:30:15', false), '08:30:15');
  });
  test('format tidak valid melempar error', () => {
    assert.throws(() => parseClock('25:00', false), /tidak valid/);
    assert.throws(() => parseClock('bukan-jam', false), /tidak valid/);
  });
});

describe('parseSize', () => {
  test('unit kb/mb/gb', () => {
    assert.equal(parseSize('50MB'), 50 * 1024 * 1024);
    assert.equal(parseSize('2GB'), 2 * 1024 ** 3);
    assert.equal(parseSize('10'), 10 * 1024 * 1024); // default MB
  });
  test('tidak valid melempar error', () => {
    assert.throws(() => parseSize('banyak'), /tidak valid/);
  });
});

describe('parseIntOpt', () => {
  test('bilangan bulat valid', () => assert.equal(parseIntOpt('samples', '4'), 4));
  test('di bawah minimum melempar error', () => assert.throws(() => parseIntOpt('max-groups', '0'), /--max-groups/));
  test('bukan angka melempar error', () => assert.throws(() => parseIntOpt('samples', 'abc'), /--samples/));
  test('min=0 mengizinkan nol', () => assert.equal(parseIntOpt('status', '0', 0), 0));
});

describe('parsePositiveOpt', () => {
  test('desimal positif valid', () => assert.equal(parsePositiveOpt('max-mb', '1.5'), 1.5));
  test('nol atau negatif melempar error', () => {
    assert.throws(() => parsePositiveOpt('max-mb', '0'), /--max-mb/);
    assert.throws(() => parsePositiveOpt('max-mb', '-1'), /--max-mb/);
  });
});

describe('truncate', () => {
  test('tidak berubah bila lebih pendek dari batas', () => assert.equal(truncate('halo', 10), 'halo'));
  test('dipotong dan diberi elipsis bila lebih panjang', () => assert.equal(truncate('halo dunia', 4), 'halo…'));
});

describe('makeMasker', () => {
  const mask = makeMasker();
  test('email disamarkan', () => assert.equal(mask('cari budi@example.com sekarang'), 'cari <email> sekarang'));
  test('NIK 16 digit disamarkan', () => assert.equal(mask('nik=1234567890123456'), 'nik=<nik>'));
  test('nomor HP disamarkan', () => assert.equal(mask('hp 081234567890'), 'hp <phone>'));
  test('Bearer token disamarkan, kata "Bearer" dipertahankan', () => assert.equal(mask('Authorization: Bearer abcdefgh12345678ijkl'), 'Authorization: Bearer <token>'));
  test('JWT disamarkan', () => assert.equal(mask('token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc123def456'), 'token=<jwt>'));
  test('UUID tidak disamarkan tanpa opsi uuid', () => assert.equal(mask('id 8503c839-798c-4f0a-a98d-535a86f5daa3'), 'id 8503c839-798c-4f0a-a98d-535a86f5daa3'));
  test('--mask-uuid menyamarkan UUID', () => {
    const m = makeMasker({ uuid: true });
    assert.equal(m('id 8503c839-798c-4f0a-a98d-535a86f5daa3'), 'id <uuid>');
  });
  test('teks tanpa data sensitif tidak berubah', () => assert.equal(mask('GET /health 200'), 'GET /health 200'));
});
