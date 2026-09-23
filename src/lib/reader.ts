import * as fs from 'fs';
import * as zlib from 'zlib';
import { pipeline, Readable } from 'stream';
import { StringDecoder } from 'string_decoder';

const MAX_LINE = 1 << 20; // karakter; baris yang lebih panjang dipotong (lihat catatan di bawah)

interface ReadOptions {
  tail?: number;
  maxLine?: number;
  onProgress?: (pct: number) => void;
}

interface ReadResult {
  bytes: number;
  size: number;
  truncatedLines: number;
}

/**
 * Baca file per chunk 1 MB dan panggil onLine(line) untuk tiap baris.
 * Memori tetap kecil berapa pun ukuran file. Mendukung .gz dan `tail` (byte terakhir saja).
 *
 * Satu baris yang lebih panjang dari `maxLine` karakter dipotong: bagian awalnya dikirim ke onLine,
 * sisanya dibuang sampai newline berikutnya. Tanpa batas ini, satu baris raksasa tanpa newline
 * (mis. dump JSON puluhan MB) menumpuk di memori dan bisa menggagalkan seluruh laporan.
 *
 * Mengembalikan { bytes, size, truncatedLines }. Error baca/dekompresi selalu jadi rejection.
 */
async function readLines(file: string, { tail = 0, maxLine = MAX_LINE, onProgress }: ReadOptions = {}, onLine: (line: string) => void): Promise<ReadResult> {
  const size = fs.statSync(file).size;
  const gz = /\.gz$/i.test(file);
  const start = tail > 0 && !gz && size > tail ? size - tail : 0;

  const raw = fs.createReadStream(file, { highWaterMark: 1 << 20, start });
  let stream: Readable = raw;
  if (gz) {
    // pipeline meneruskan error dari `raw` (EACCES, EISDIR, ...) ke `stream`; tanpa ini jadi 'error' yang tidak tertangkap
    const gunzip = zlib.createGunzip();
    pipeline(raw, gunzip, () => {});
    stream = gunzip;
  }
  const dec = new StringDecoder('utf8');

  let rest = '';
  let dropping = false; // sedang membuang sisa baris yang melebihi maxLine
  let skipFirst = start > 0; // baris pertama hasil lompatan kemungkinan terpotong
  let lastPct = -1;
  let truncatedLines = 0;

  for await (const buf of stream) {
    let chunk = dec.write(buf);
    if (dropping) {
      const nl = chunk.indexOf('\n');
      if (nl < 0) continue; // masih di dalam baris yang dibuang
      chunk = chunk.slice(nl); // sisakan '\n' supaya baris yang dipotong tertutup
      dropping = false;
    }
    const s = rest + chunk;
    let pos = 0;
    let nl: number;
    while ((nl = s.indexOf('\n', pos)) !== -1) {
      let line = s.slice(pos, nl);
      pos = nl + 1;
      if (line.charCodeAt(line.length - 1) === 13) line = line.slice(0, -1); // CRLF
      if (line.length > maxLine) {
        line = line.slice(0, maxLine);
        truncatedLines++;
      }
      if (skipFirst) {
        skipFirst = false;
        continue;
      }
      onLine(line);
    }
    rest = pos < s.length ? s.slice(pos) : '';
    if (rest.length > maxLine) {
      rest = rest.slice(0, maxLine);
      dropping = true;
      truncatedLines++;
    }

    if (onProgress) {
      const pct = Math.min(100, Math.floor(((start + raw.bytesRead) / size) * 100));
      if (pct !== lastPct) {
        lastPct = pct;
        onProgress(pct);
      }
    }
  }
  if (!dropping) rest += dec.end();
  if (rest && !skipFirst) onLine(rest);
  return { bytes: raw.bytesRead, size, truncatedLines };
}

export { readLines, MAX_LINE };
