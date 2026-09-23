import { test, describe, beforeAll, afterAll } from 'bun:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { cli, report, mkTmp, rmTmp, line, makeSampleLog, PKG_VERSION } from './helpers';

const posix = process.platform !== 'win32';
let dir: string;
let log: string; // log kecil dengan satu request
beforeAll(() => {
  dir = mkTmp();
  log = path.join(dir, 'small.log');
  fs.writeFileSync(log, line({ time: '23/Sep/2026:10:00:00 +0700', path: '/api/v1/x', status: 500 }));
});
afterAll(() => rmTmp(dir));

const out = (name = 'r.html') => path.join(dir, name);

describe('bantuan dan versi', () => {
  test('--help: kode 0, ke stdout', () => {
    const r = cli(['--help']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Kode keluar/);
  });
  test('--version cocok dengan package.json', () => {
    const r = cli(['--version']);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), PKG_VERSION);
  });
  test('tanpa argumen: kode 2', () => assert.equal(cli([]).status, 2));
});

describe('salah pemakaian: kode 2 dan tidak ada keluaran yang ditulis', () => {
  const cases: Record<string, string[]> = {
    'opsi tidak dikenal': ['--tidak-ada'],
    'opsi bernilai tanpa nilai': ['--out'],
    'nilai kosong': ['--out='],
    'flag diberi nilai': ['--mask=ya'],
    'status bukan angka': ['--status=abc'],
    'jam tidak valid': ['--from=25:00'],
    'from lebih besar dari to': ['--from=10:00', '--to=09:00'],
    'tanggal tidak valid': ['--date=21-09-2026'],
    'angka tidak valid': ['--samples=abc'],
    'angka nol': ['--max-groups=0'],
    'max-mb negatif': ['--max-mb=-1'],
    'mode bukan oktal': ['--mode=999'],
    'ukuran tail tidak valid': ['--tail=banyak'],
  };
  for (const [name, args] of Object.entries(cases)) {
    test(name, () => {
      const target = out('x.html');
      const r = cli([log, ...args, '--out=' + target]);
      assert.equal(r.status, 2, r.stderr);
      assert.match(r.stderr, /Salah pemakaian/);
      assert.ok(!fs.existsSync(target));
    });
  }
});

describe('kegagalan saat berjalan: kode 1 dengan pesan singkat (tanpa stack trace)', () => {
  test('file tidak ada', () => {
    const r = cli([path.join(dir, 'tidak-ada.log'), '--out=' + out()]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /File tidak ditemukan/);
    assert.doesNotMatch(r.stderr, /\n\s+at /);
  });
  test('masukan berupa direktori', () => {
    const r = cli([dir, '--out=' + out()]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Bukan file biasa/);
  });
  test('.gz rusak', () => {
    const bad = path.join(dir, 'rusak.log.gz');
    fs.writeFileSync(bad, 'bukan gzip');
    const r = cli([bad, '--out=' + out()]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Gagal:/);
  });
  test('template tanpa penanda data', () => {
    const tpl = path.join(dir, 'kosong.html');
    fs.writeFileSync(tpl, '<html></html>');
    const r = cli([log, '--template=' + tpl, '--out=' + out()]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /penanda/);
  });
});

describe('keamanan keluaran', () => {
  test('tidak menimpa file masukan', () => {
    const copy = path.join(dir, 'salin.log');
    fs.copyFileSync(log, copy);
    const before = fs.readFileSync(copy, 'utf8');
    const r = cli([copy, '--out=' + copy]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /tidak boleh sama dengan file masukan/);
    assert.equal(fs.readFileSync(copy, 'utf8'), before);
  });
  test('--json juga tidak boleh menimpa masukan', () => {
    assert.equal(cli([log, '--json=' + log, '--out=' + out()]).status, 2);
  });
  test.skipIf(!posix)('symlink ke file masukan terdeteksi', () => {
    const link = path.join(dir, 'tautan.html');
    fs.symlinkSync(log, link);
    assert.equal(cli([log, '--out=' + link]).status, 2);
  });
  test('membuat direktori keluaran yang belum ada', () => {
    const target = path.join(dir, 'a', 'b', 'c.html');
    assert.equal(cli([log, '--out=' + target, '--quiet']).status, 0);
    assert.ok(fs.existsSync(target));
  });
  test.skipIf(!posix)('izin file default 0600', () => {
    const target = out('izin.html');
    cli([log, '--out=' + target, '--quiet']);
    assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  });
  test.skipIf(!posix)('--mode mengatur izin (juga saat menimpa laporan lama)', () => {
    const target = out('izin2.html');
    fs.writeFileSync(target, 'lama', { mode: 0o666 });
    cli([log, '--out=' + target, '--mode=640', '--quiet']);
    assert.equal(fs.statSync(target).mode & 0o777, 0o640);
  });
  test('tidak meninggalkan file sementara', () => {
    cli([log, '--out=' + out('bersih.html'), '--quiet']);
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), []);
  });
  test('--title di-escape di <title>', () => {
    const r = report(dir, log, ['--title=<b>"x"</b> & y']);
    assert.match(r.html, /<title>&lt;b&gt;&quot;x&quot;&lt;\/b&gt; &amp; y<\/title>/);
    assert.equal(r.data.meta.title, '<b>"x"</b> & y');
  });
});

describe('keluaran konsol', () => {
  test('ringkasan tampil secara default', () => {
    const r = cli([log, '--out=' + out('ringkas.html')]);
    assert.equal(r.status, 0);
    assert.match(r.stderr, /Selesai dalam/);
    assert.equal(r.stdout, '');
  });
  test('--quiet: tidak ada keluaran sama sekali saat normal', () => {
    const r = cli([log, '--out=' + out('senyap.html'), '--quiet']);
    assert.equal(r.status, 0);
    assert.equal(r.stderr, '');
  });
  test('--quiet tetap menampilkan peringatan', () => {
    const f = path.join(dir, 'bukan-log.txt');
    fs.writeFileSync(f, 'ini bukan access log nginx\n');
    const r = cli([f, '--out=' + out('kosong.html'), '--quiet']);
    assert.equal(r.status, 0);
    assert.match(r.stderr, /peringatan: tidak ada baris berformat access log nginx/);
  });
  test('--tail pada .gz diabaikan dengan peringatan', () => {
    const gz = path.join(dir, 'a.log.gz');
    fs.writeFileSync(gz, zlib.gzipSync(fs.readFileSync(log)));
    const r = cli([gz, '--tail=1MB', '--out=' + out('gz.html'), '--quiet']);
    assert.equal(r.status, 0);
    assert.match(r.stderr, /--tail diabaikan untuk a\.log\.gz/);
  });
});

describe('opsi', () => {
  test('nilai opsi boleh dipisah spasi dan didahului "--" untuk file', () => {
    const r = report(dir, [], ['--status', '400', '--', log]);
    assert.equal(r.data.meta.minStatus, 400);
    assert.equal(r.data.groups.length, 1); // status 500 di log kecil >= 400
  });
  test('beberapa file (biasa + .gz) digabung', () => {
    const gz = path.join(dir, 'b.log.gz');
    fs.writeFileSync(gz, zlib.gzipSync(line({ time: '23/Sep/2026:10:05:00 +0700', path: '/api/v1/x', status: 500 })));
    const r = report(dir, [log, gz]);
    assert.equal(r.data.groups.length, 1);
    assert.equal(r.data.groups[0].count, 2);
    assert.deepEqual(r.data.meta.files, ['small.log', 'b.log.gz']);
  });
  test('--status: hanya request dengan status code >= nilai yang disimpan', () => {
    const f = path.join(dir, 'status.log');
    fs.writeFileSync(
      f,
      line({ time: '23/Sep/2026:10:00:00 +0700', path: '/ok', status: 200 }) + line({ time: '23/Sep/2026:10:00:01 +0700', path: '/rusak', status: 500 })
    );
    const r = report(dir, f, ['--status=400']);
    assert.equal(r.data.groups.length, 1);
    assert.equal(r.data.groups[0].status, 500);
  });
  test('--date: hanya tanggal yang diminta', () => {
    const f = path.join(dir, 'tanggal.log');
    fs.writeFileSync(
      f,
      line({ time: '22/Sep/2026:10:00:00 +0700', path: '/x', status: 200 }) + line({ time: '23/Sep/2026:10:00:00 +0700', path: '/x', status: 200 })
    );
    const r = report(dir, f, ['--date=2026-09-23']);
    assert.equal(r.data.groups[0].count, 1);
    assert.equal(r.data.meta.date, '2026-09-23');
  });
  test('--from/--to: filter jam', () => {
    const f = path.join(dir, 'jam.log');
    fs.writeFileSync(
      f,
      line({ time: '23/Sep/2026:07:00:00 +0700', path: '/x', status: 200 }) +
        line({ time: '23/Sep/2026:09:00:00 +0700', path: '/x', status: 200 }) +
        line({ time: '23/Sep/2026:18:00:00 +0700', path: '/x', status: 200 })
    );
    const r = report(dir, f, ['--from=08:00', '--to=17:00']);
    assert.equal(r.data.groups[0].count, 1);
  });
  test('clientIp (field ke-11) dipakai untuk ips, bukan remote_addr load balancer', () => {
    const f = path.join(dir, 'lb.log');
    fs.writeFileSync(
      f,
      line({ ip: '10.96.245.3', time: '23/Sep/2026:10:00:00 +0700', path: '/x', status: 200, xff: '180.243.98.128' }) +
        line({ ip: '10.96.245.3', time: '23/Sep/2026:10:00:01 +0700', path: '/x', status: 200, xff: '36.85.12.44' })
    );
    const r = report(dir, f);
    assert.equal(r.data.groups[0].ipCount, 2);
    assert.deepEqual(r.data.groups[0].ips.sort(), ['180.243.98.128', '36.85.12.44']);
  });
  test('--max-groups: group baru sesudah batas diabaikan, hitungan group lama tetap akurat', () => {
    const f = path.join(dir, 'banyak.log');
    let text = '';
    for (let i = 0; i < 5; i++) text += line({ time: `23/Sep/2026:10:0${i}:00 +0700`, path: `/beda-${i}`, status: 200 });
    text += line({ time: '23/Sep/2026:10:09:00 +0700', path: '/beda-0', status: 200 }); // group pertama muncul lagi
    fs.writeFileSync(f, text);
    const r = report(dir, f, ['--max-groups=2']);
    assert.equal(r.data.groups.length, 2);
    assert.equal(r.data.meta.dropped, 3);
    assert.equal(r.data.groups.find((g) => g.path === '/beda-0')!.count, 2);
    assert.match(r.stderr, /3 request dari group baru diabaikan/);
  });
  const piiLog = () => {
    const f = path.join(dir, 'pii.log');
    fs.writeFileSync(f, line({ time: '23/Sep/2026:10:00:00 +0700', path: '/api?note=budi@example.com&id=720a87bb-1fb7-49bb-98f4-2eab2e84a4c8', status: 200 }));
    return f;
  };
  test('--mask menyamarkan email/uuid di raw sample, tidak menyentuh clientIp', () => {
    const r = report(dir, piiLog(), ['--mask', '--mask-uuid']);
    const all = JSON.stringify(r.data);
    assert.ok(!all.includes('budi@example.com') && !all.includes('720a87bb'));
    assert.ok(!r.html.includes('budi@example.com'));
    assert.equal(r.data.meta.masked, true);
    assert.equal(r.data.groups[0].ips[0], '10.0.0.1'); // IP tetap apa adanya
  });
  test('--mask-uuid otomatis mengaktifkan --mask', () => {
    const r = report(dir, piiLog(), ['--mask-uuid']);
    assert.equal(r.data.meta.masked, true);
  });
  test('tanpa --mask data apa adanya', () => {
    assert.ok(JSON.stringify(report(dir, piiLog()).data).includes('budi@example.com'));
  });
});

describe('log contoh (satu proses penuh, pola dari log produksi nyata)', () => {
  test('membuat log contoh lalu laporan: jumlah group sesuai dan unparsed tercatat', () => {
    const sample = makeSampleLog(path.join(dir, 'sample.log'));
    const r = report(dir, sample);
    assert.equal(r.data.groups.length, 7);
    assert.equal(r.data.meta.unparsed, 2);
    assert.match(r.stderr, /peringatan: 2 baris tidak sesuai format combined log/);
  });
  test('grup pencarian typeahead tergabung dan menyimpan searchTerms', () => {
    const sample = makeSampleLog(path.join(dir, 'sample2.log'));
    const r = report(dir, sample);
    const g = r.data.groups.find((x) => x.path === '/api/v1/office/good-stock')!;
    assert.ok(g);
    assert.equal(g.count, 15);
    assert.ok(g.searchTerms.some((s) => s.term === 'neo rheuma')); // "+" di query string didekode jadi spasi
  });
});
