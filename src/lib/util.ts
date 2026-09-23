/** "08:30" -> "08:30:00" (dari) atau "08:30:59" (sampai). */
function parseClock(str: string, isEnd: boolean): string {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(str).trim());
  if (!m || +m[1] > 23 || +m[2] > 59 || (m[3] !== undefined && +m[3] > 59)) {
    throw new Error(`Format jam tidak valid: "${str}" (pakai HH:MM atau HH:MM:SS)`);
  }
  const hh = m[1].padStart(2, '0');
  const ss = m[3] !== undefined ? m[3] : isEnd ? '59' : '00';
  return `${hh}:${m[2]}:${ss}`;
}

const SIZE_UNITS: Record<string, number> = { kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 };

/** "50MB" -> byte */
function parseSize(str: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(kb|mb|gb)?$/i.exec(String(str).trim());
  if (!m) throw new Error(`Ukuran tidak valid: "${str}" (contoh: 50MB)`);
  return Math.round(parseFloat(m[1]) * SIZE_UNITS[(m[2] || 'mb').toLowerCase()]);
}

/** Bilangan bulat >= min dari nilai opsi CLI; melempar error yang menyebut nama opsi. */
function parseIntOpt(name: string, str: string, min = 1): number {
  if (!/^\d+$/.test(String(str).trim()) || parseInt(str, 10) < min) {
    throw new Error(`Nilai --${name} tidak valid: "${str}" (harus bilangan bulat >= ${min})`);
  }
  return parseInt(str, 10);
}

/** Bilangan > 0 (boleh desimal) dari nilai opsi CLI. */
function parsePositiveOpt(name: string, str: string): number {
  const n = /^\d+(\.\d+)?$/.test(String(str).trim()) ? parseFloat(str) : NaN;
  if (!(n > 0)) throw new Error(`Nilai --${name} tidak valid: "${str}" (harus bilangan > 0)`);
  return n;
}

const truncate = (s: string, n: number): string => (s.length > n ? s.slice(0, n) + '…' : s);

/**
 * Penyamaran data sensitif yang mungkin nyasar ke query string, referer, atau User-Agent
 * (mis. `?email=...`, `?token=...`, halaman checkout dengan NIK/no-HP di query). Beda dari
 * masking log Laravel: di sini yang disamarkan adalah fragmen teks per field, bukan seluruh
 * baris, dan IP (dasar statistik "IP unik" pada laporan) sengaja tidak disentuh.
 */
function makeMasker({ uuid = false }: { uuid?: boolean } = {}): (text: string) => string {
  const rules: Array<[RegExp, string]> = [
    // token dulu, supaya angka di dalamnya tidak dibaca sebagai NIK/nomor HP
    [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, '<jwt>'],
    [/\b(Bearer)\s+[A-Za-z0-9._~+/=|-]{16,}/gi, '$1 <token>'],
    [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>'],
    [/\b\d{16}\b/g, '<nik>'],
    [/(?:\+62|\b62|\b0)8\d{8,11}\b/g, '<phone>'],
  ];
  if (uuid) rules.push([/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>']);
  return (text: string) => {
    for (let i = 0; i < rules.length; i++) text = text.replace(rules[i][0], rules[i][1]);
    return text;
  };
}

export { parseClock, parseSize, parseIntOpt, parsePositiveOpt, truncate, makeMasker };
