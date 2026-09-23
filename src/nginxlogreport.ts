#!/usr/bin/env bun
import * as fs from 'fs';
import * as path from 'path';
import { readLines } from './lib/reader';
import { parseLine } from './lib/parser';
import { Aggregator } from './lib/aggregate';
import type { GroupLimits } from './lib/aggregate';
import { parseClock, parseSize, parseIntOpt, parsePositiveOpt, makeMasker } from './lib/util';
import type { ReportMeta, ReportPayload } from './lib/types';

/** Versi dari package.json terdekat di atas file ini (di repo dan di image Docker: satu tingkat di atas src/). */
function readVersion(): string {
  for (let dir = import.meta.dir; ; dir = path.dirname(dir)) {
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version;
    } catch (_) {
      /* tidak ada di folder ini; naik satu tingkat */
    }
    if (dir === path.dirname(dir)) return 'tidak diketahui';
  }
}
const VERSION = readVersion();

const HELP = `
nginxlogreport ${VERSION}: buat laporan HTML dari access log nginx (streaming, aman untuk file >100 MB)

Pemakaian:
  nginxlogreport <access.log|access.log.gz> [file lain ...] [opsi]

Opsi:
  --status=400         hanya simpan request dengan status code >= ini. Default: 0 (semua)
  --date=2026-09-23    hanya request pada tanggal ini (berguna bila satu file memuat beberapa hari)
  --from=08:00         hanya request mulai jam ini (HH:MM atau HH:MM:SS)
  --to=17:00           hanya request sampai jam ini
  --tail=50MB          baca hanya 50 MB terakhir dari file (tidak untuk .gz)
  --samples=4          jumlah sampel raw per group (1 pertama + sisanya terbaru). Default: 4
  --max-occ=300        jumlah waktu kejadian yang disimpan per group. Default: 300
  --max-groups=4000    jumlah group maksimal; request dari group baru sesudahnya diabaikan (dan dicatat). Default: 4000
  --max-mb=10          batas ukuran data di HTML; sampel dikurangi otomatis bila lewat. Default: 10
  --mask               samarkan email, NIK 16 digit, nomor HP, dan token (JWT/Bearer) yang nyasar ke
                        query string, referer, atau User-Agent (baris raw yang disimpan sebagai sampel)
  --mask-uuid           samarkan juga UUID pada baris raw/referer (mis. id di query string). Otomatis mengaktifkan --mask
  --out=report.html    file keluaran. Default: report.html
  --mode=600            izin file keluaran (oktal). Default: 600
  --title="Judul"      judul laporan
  --json=data.json     simpan juga data hasil parsing dalam JSON (untuk debug)
  --template=path      pakai template HTML lain
  --quiet              tanpa progress dan ringkasan (peringatan tetap tampil)
  --version            tampilkan versi
  --help               tampilkan bantuan

Kode keluar: 0 berhasil, 1 gagal saat berjalan (file tidak terbaca, tidak bisa menulis, dll), 2 salah pemakaian.
`;

/* ---------------- argumen ---------------- */
class UsageError extends Error {}

const FLAGS = ['mask', 'mask-uuid', 'quiet', 'help', 'version'] as const;
const VALUES = ['status', 'date', 'from', 'to', 'tail', 'samples', 'max-occ', 'max-groups', 'max-mb', 'out', 'mode', 'title', 'json', 'template'] as const;

type Options = { [K in (typeof FLAGS)[number]]?: boolean } & { [K in (typeof VALUES)[number]]?: string };

const isFlag = (n: string): n is (typeof FLAGS)[number] => (FLAGS as readonly string[]).includes(n);
const isValue = (n: string): n is (typeof VALUES)[number] => (VALUES as readonly string[]).includes(n);

function parseArgs(argv: string[]): { opts: Options; files: string[] } {
  const opts: Options = {};
  const files: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      files.push(...argv.slice(i + 1));
      break;
    }
    if (!a.startsWith('--')) {
      files.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const name = (eq >= 0 ? a.slice(2, eq) : a.slice(2)).trim();
    if (isFlag(name)) {
      if (eq >= 0) throw new UsageError(`Opsi --${name} tidak memakai nilai`);
      opts[name] = true;
    } else if (isValue(name)) {
      const v = eq >= 0 ? a.slice(eq + 1) : argv[i + 1];
      if (eq < 0) {
        if (v === undefined || v.startsWith('--')) throw new UsageError(`Opsi --${name} butuh nilai`);
        i++;
      }
      if (v === '') throw new UsageError(`Opsi --${name} butuh nilai`);
      opts[name] = v;
    } else {
      throw new UsageError(`Opsi tidak dikenal: --${name}`);
    }
  }
  return { opts, files };
}

/** Path nyata bila file sudah ada (menembus symlink), kalau belum ada path absolutnya saja. */
const realOrResolved = (p: string): string => {
  try {
    return fs.realpathSync(p);
  } catch (_) {
    return path.resolve(p);
  }
};

/** Tulis lewat file sementara lalu rename, supaya pembaca tidak pernah melihat laporan setengah jadi. */
function writeFileSecure(file: string, data: string, mode: number): void {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, data, { mode, flag: 'wx' });
    fs.chmodSync(tmp, mode); // umask hanya bisa mengurangi izin; chmod memastikan nilai persis
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch (_) {
      /* tidak ada file sementara */
    }
    throw e;
  }
}

async function main(argv: string[]): Promise<void> {
  const { opts, files } = parseArgs(argv);
  if (opts.help) {
    process.stdout.write(HELP);
    return;
  }
  if (opts.version) {
    process.stdout.write(VERSION + '\n');
    return;
  }
  if (!files.length) {
    process.stderr.write(HELP);
    process.exitCode = 2;
    return;
  }
  for (const f of files) {
    let st: fs.Stats;
    try {
      st = fs.statSync(f);
    } catch (_) {
      throw new Error(`File tidak ditemukan atau tidak bisa dibaca: ${f}`);
    }
    if (!st.isFile()) throw new Error(`Bukan file biasa: ${f}`);
  }

  let minStatus: number, from: string | null, to: string | null, tail: number;
  try {
    minStatus = opts.status ? parseIntOpt('status', opts.status, 0) : 0;
    from = opts.from ? parseClock(opts.from, false) : null;
    to = opts.to ? parseClock(opts.to, true) : null;
    tail = opts.tail ? parseSize(opts.tail) : 0;
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
  if (from && to && from > to) throw new UsageError(`--from (${from}) tidak boleh lebih besar dari --to (${to})`);
  const date = opts.date || null;
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new UsageError(`Format --date tidak valid: "${date}" (pakai YYYY-MM-DD)`);
  if (opts.mode !== undefined && !/^[0-7]{3,4}$/.test(opts.mode)) throw new UsageError(`Nilai --mode tidak valid: "${opts.mode}" (contoh: 600 atau 640)`);
  let samples: number, maxOcc: number, maxGroups: number, maxBytes: number;
  try {
    samples = opts.samples ? parseIntOpt('samples', opts.samples) : 4;
    maxOcc = opts['max-occ'] ? parseIntOpt('max-occ', opts['max-occ']) : 300;
    maxGroups = opts['max-groups'] ? parseIntOpt('max-groups', opts['max-groups']) : 4000;
    maxBytes = (opts['max-mb'] ? parsePositiveOpt('max-mb', opts['max-mb']) : 10) * 1024 * 1024;
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
  const fileMode = opts.mode ? parseInt(opts.mode, 8) : 0o600;
  const out = opts.out || 'report.html';
  const quiet = !!opts.quiet;
  const mask = opts.mask || opts['mask-uuid'] ? makeMasker({ uuid: !!opts['mask-uuid'] }) : null;

  // jangan pernah menimpa file masukan (mis. salah ketik --out=access.log)
  const inputs = new Set(files.map(realOrResolved));
  for (const target of [out, opts.json].filter((t): t is string => !!t)) {
    if (inputs.has(realOrResolved(target))) throw new UsageError(`Keluaran tidak boleh sama dengan file masukan: ${target}`);
  }

  const tplPath = opts.template || path.join(import.meta.dir, 'template.html');
  let tpl: string;
  try {
    tpl = fs.readFileSync(tplPath, 'utf8');
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    throw new Error(`Template tidak bisa dibaca: ${tplPath} (${err.code || err.message})`);
  }
  const marker = '/*__DATA__*/null';
  if (tpl.indexOf(marker) < 0) throw new Error(`Template tidak memuat penanda ${marker}: ${tplPath}`);

  const warnings: string[] = [];
  const agg = new Aggregator({ samples, maxOcc, maxGroups });
  const stats = { entries: 0, bytes: 0, unparsed: 0 };
  const t0 = Date.now();

  const onLine = (line: string): void => {
    if (!line) return;
    stats.entries++;
    const p = parseLine(line);
    if (!p) {
      stats.unparsed++;
      return;
    }
    if (minStatus > 0 && p.status < minStatus) return;
    if (date || from || to) {
      const iso = new Date(p.ts * 1000).toISOString();
      if (date && iso.slice(0, 10) !== date) return;
      if (from && iso.slice(11, 19) < from) return;
      if (to && iso.slice(11, 19) > to) return;
    }
    if (mask) {
      p.raw = mask(p.raw);
      p.referer = mask(p.referer);
      p.ua = mask(p.ua);
      if (p.searchTerm) p.searchTerm = mask(p.searchTerm);
    }
    agg.add(p);
  };

  /* ---------------- baca file ---------------- */
  const isTTY = !!process.stderr.isTTY && !quiet;
  for (const f of files) {
    const name = path.basename(f);
    if (tail && /\.gz$/i.test(f)) warnings.push(`--tail diabaikan untuk ${name}: file .gz harus dibaca dari awal`);
    const res = await readLines(
      f,
      {
        tail,
        onProgress: isTTY ? (pct) => process.stderr.write(`\r  membaca ${name}: ${pct}%   `) : undefined,
      },
      onLine
    );
    stats.bytes += res.bytes;
    if (isTTY) process.stderr.write('\n');
  }

  if (!stats.entries) warnings.push('tidak ada baris di file masukan; periksa apakah file-nya benar');
  else if (stats.unparsed === stats.entries) warnings.push('tidak ada baris berformat access log nginx (combined) yang cocok; periksa log_format di nginx');
  else if (stats.unparsed) warnings.push(`${stats.unparsed} baris tidak sesuai format combined log dan dilewati`);
  if (agg.dropped) warnings.push(`${agg.dropped} request dari group baru diabaikan karena batas --max-groups=${maxGroups} tercapai (persempit filter atau naikkan batas)`);

  /* ---------------- serialisasi + batas ukuran ---------------- */
  let limits: Required<GroupLimits> = { maxOcc, rawMax: 4000, samples };
  let groups = agg.toGroups(limits);
  let tMin: number | null = null;
  let tMax: number | null = null;
  for (const g of groups) {
    if (tMin === null || g.first < tMin) tMin = g.first;
    if (tMax === null || g.last > tMax) tMax = g.last;
  }

  const meta: ReportMeta = {
    version: VERSION,
    title: opts.title || 'Nginx Access Log Report',
    files: files.map((f) => path.basename(f)),
    bytes: stats.bytes,
    entries: stats.entries,
    kept: agg.kept,
    unparsed: stats.unparsed,
    minStatus,
    date,
    from,
    to,
    tail: tail || null,
    generatedAt: new Date().toISOString(),
    seconds: 0,
    dropped: agg.dropped,
    maxGroups,
    reduced: false,
    masked: !!mask,
    samples,
    maxOcc,
    tMin,
    tMax,
  };

  let json = '';
  let payload: ReportPayload = { meta, groups };
  for (let i = 0; i < 8; i++) {
    payload = { meta, groups };
    json = JSON.stringify(payload);
    if (json.length <= maxBytes) break;
    meta.reduced = true;
    limits = {
      maxOcc: Math.max(20, Math.floor(limits.maxOcc / 2)),
      rawMax: Math.max(2000, Math.floor(limits.rawMax / 2)),
      samples: Math.max(1, limits.samples - 1),
    };
    groups = agg.toGroups(limits);
  }
  meta.seconds = Math.round(((Date.now() - t0) / 1000) * 10) / 10;
  payload.meta = meta;
  json = JSON.stringify(payload);
  if (json.length > maxBytes) warnings.push(`data laporan ${(json.length / 1048576).toFixed(1)} MB masih di atas --max-mb=${maxBytes / 1048576} meski sudah dikurangi (terlalu banyak group; persempit filter)`);

  if (opts.json) writeFileSecure(opts.json, JSON.stringify(payload, null, 2), fileMode);

  // aman ditanam di <script>
  const safe = json.replace(/</g, '\\u003c').replace(/\\u2028/g, '\\u2028').replace(/\\u2029/g, '\\u2029');
  const html = tpl.replace(marker, () => safe).replace('<title>Nginx Access Log Report</title>', () => `<title>${escapeHtml(meta.title)}</title>`);
  writeFileSecure(out, html, fileMode);

  if (!quiet) {
    const mb = (n: number): string => (n / 1024 / 1024).toFixed(1);
    console.error(
      `Selesai dalam ${meta.seconds} dtk\n` +
        `  dibaca   : ${stats.entries} baris (${mb(stats.bytes)} MB)\n` +
        `  dipakai  : ${agg.kept} request${minStatus ? ', status >= ' + minStatus : ''}${date ? ', tanggal ' + date : ''}${from ? ', dari ' + from : ''}${to ? ', sampai ' + to : ''}\n` +
        `  group    : ${payload.groups.length}\n` +
        `  keluaran : ${out} (${mb(Buffer.byteLength(html))} MB)\n` +
        `  memori   : puncak ${Math.round(process.resourceUsage().maxRSS / 1024)} MB (RSS)` +
        (meta.reduced ? '\n  catatan  : data dikurangi otomatis agar di bawah ' + maxBytes / 1024 / 1024 + ' MB' : '')
    );
  }
  for (const w of warnings) console.error('peringatan: ' + w);
}

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const escapeHtml = (s: string): string => String(s).replace(/[&<>"]/g, (c) => HTML_ESCAPES[c]);

function handleError(e: unknown): void {
  if (e instanceof UsageError) {
    console.error(`Salah pemakaian: ${e.message}\nJalankan dengan --help untuk daftar opsi.`);
    process.exitCode = 2;
    return;
  }
  // pesan singkat untuk kesalahan input; stack trace hanya bila NGINXLOGREPORT_DEBUG=1
  const err = e as Error | undefined;
  console.error('Gagal: ' + (process.env.NGINXLOGREPORT_DEBUG && err && err.stack ? err.stack : err && err.message ? err.message : e));
  process.exitCode = 1;
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch(handleError);
}

export { parseArgs, UsageError };
