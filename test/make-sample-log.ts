#!/usr/bin/env bun
/**
 * Membuat access log nginx sintetis untuk uji dan `bun run sample`.
 *
 * Polanya diambil dari contoh log nyata yang dipakai untuk merancang tool ini: nginx di belakang
 * load balancer (remote_addr = IP internal LB, sama untuk semua request), field ke-11 = IP klien
 * asli, dan endpoint pencarian yang mencatat tiap ketukan (query `search=` bertambah per huruf).
 *
 * Deterministik (tanpa Math.random) supaya jumlah group, unique IP, dsb. bisa diuji dengan angka pasti.
 */
import * as fs from 'fs';
import * as path from 'path';

function parseArgs(argv: string[]): { out: string } {
  let out = 'examples/sample.log';
  for (const a of argv) {
    if (a.startsWith('--out=')) out = a.slice('--out='.length);
  }
  return { out };
}

const LB_IP = '10.96.245.3'; // remote_addr: selalu sama, IP internal load balancer
const CLIENT_IPS = ['180.243.98.128', '36.85.12.44', '103.10.45.201', '182.253.10.5'];
const UAS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
];
const BOT_UA = 'Mozilla/5.0 (compatible; UptimeRobot/2.0; http://www.uptimerobot.com/)';
const REFERER = 'https://portal.seemedik.com/office/goods-stock';
const BRANCH_ID = '8503c839-798c-4f0a-a98d-535a86f5daa3';
const DEPT_ID = 'c7cf9620-12fb-4f3f-b29a-2e8cba6467b2';
const DATE = '23/Sep/2026';

let lineNo = 0;
function fmtTime(h: number, m: number, s: number): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${DATE}:${pad(h)}:${pad(m)}:${pad(s)} +0700`;
}

function line(opts: { ip?: string; clientIp?: string; h: number; m: number; s: number; method: string; path: string; proto?: string; status: number; size: number | string; referer?: string; ua?: string; xff?: string | null }): string {
  lineNo++;
  const ip = opts.ip ?? LB_IP;
  const proto = opts.proto ?? 'HTTP/1.1';
  const referer = opts.referer ?? '-';
  const ua = opts.ua ?? '-';
  const xff = opts.xff === undefined ? (opts.clientIp ?? CLIENT_IPS[lineNo % CLIENT_IPS.length]) : opts.xff;
  const time = fmtTime(opts.h, opts.m, opts.s);
  let l = `${ip} - - [${time}] "${opts.method} ${opts.path} ${proto}" ${opts.status} ${opts.size} "${referer}" "${ua}"`;
  if (xff !== null) l += ` "${xff}"`;
  return l;
}

function build(): string {
  const lines: string[] = [];

  // 1) endpoint pencarian tipe typeahead: satu client mengetik "neo" huruf demi huruf,
  //    semua ke fingerprint yang sama (GET /api/v1/office/good-stock 200)
  const searchSeq = ['n', 'ne', 'neo', 'neo+', 'neo+r', 'neo+rh', 'neo+rhe', 'neo+rheu', 'neo+rheum', 'neo+rheuma'];
  let sec = 0;
  for (const q of searchSeq) {
    const query = `page=1&size=10&search=${q}&branchIds=${BRANCH_ID}&departmentId=${DEPT_ID}&isAdvanceSearch=true`;
    lines.push(
      line({ h: 3, m: 14, s: sec++ % 60, method: 'GET', path: `/api/v1/office/good-stock?${query}`, status: 200, size: 737, referer: REFERER, ua: UAS[0], clientIp: CLIENT_IPS[0] })
    );
  }
  // request tanpa search= sama sekali, endpoint dan fingerprint yang sama
  for (let i = 0; i < 5; i++) {
    const query = `page=${i + 1}&size=10&branchIds=${BRANCH_ID}&departmentId=${DEPT_ID}`;
    lines.push(line({ h: 3, m: 16, s: i, method: 'GET', path: `/api/v1/office/good-stock?${query}`, status: 200, size: 900 + i, referer: REFERER, ua: UAS[1], clientIp: CLIENT_IPS[1] }));
  }

  // 2) login: berhasil (GET halaman) dan gagal berkali-kali dari beberapa IP (percobaan brute force ringan)
  lines.push(line({ h: 8, m: 0, s: 0, method: 'GET', path: '/api/v1/auth/login', status: 200, size: 512, ua: UAS[0], clientIp: CLIENT_IPS[0] }));
  for (let i = 0; i < 8; i++) {
    lines.push(
      line({ h: 8, m: 1, s: i * 3, method: 'POST', path: '/api/v1/auth/login', status: 401, size: 61, ua: UAS[i % UAS.length], clientIp: CLIENT_IPS[i % CLIENT_IPS.length] })
    );
  }

  // 3) endpoint dengan id numerik dan uuid di path -> harus dinormalisasi ke {id} dan masuk 1 group
  const ids = ['42', '1007', '8503c839-798c-4f0a-a98d-535a86f5daa3', '99'];
  for (let i = 0; i < ids.length; i++) {
    lines.push(line({ h: 9, m: 30, s: i, method: 'GET', path: `/api/v1/office/branch/${ids[i]}`, status: i === 3 ? 404 : 200, size: 300 + i * 10, ua: UAS[0], clientIp: CLIENT_IPS[i % CLIENT_IPS.length] }));
  }

  // 4) 404 murni
  for (let i = 0; i < 3; i++) {
    lines.push(line({ h: 10, m: 0, s: i, method: 'GET', path: '/api/v1/office/branch/9999999', status: 404, size: 42, ua: UAS[2], clientIp: CLIENT_IPS[2] }));
  }

  // 5) error server
  for (let i = 0; i < 2; i++) {
    lines.push(line({ h: 11, m: 45, s: i * 10, method: 'GET', path: '/api/v1/report/export', status: 500, size: 88, ua: UAS[1], clientIp: CLIENT_IPS[3] }));
  }

  // 6) health check dari bot/monitor, banyak, IP tetap
  for (let i = 0; i < 20; i++) {
    lines.push(line({ h: i % 24, m: 0, s: 0, method: 'GET', path: '/health', status: 200, size: 2, ua: BOT_UA, clientIp: '198.51.100.10' }));
  }

  // baris rusak, untuk menguji hitungan "unparsed"
  lines.push('baris ini bukan access log nginx sama sekali');
  lines.push(`${LB_IP} - - [format-tanggal-salah] "GET / HTTP/1.1" 200 1 "-" "-"`);

  return lines.join('\n') + '\n';
}

if (import.meta.main) {
  const { out } = parseArgs(process.argv.slice(2));
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, build());
  console.error(`Ditulis: ${out}`);
}

export { build };
