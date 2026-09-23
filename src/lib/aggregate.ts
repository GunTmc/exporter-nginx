import { truncate } from './util';
import type { ParsedLine, ReportGroup, Sample } from './types';

/** Group yang sedang dikumpulkan (bentuk akhirnya untuk template dibuat oleh `toGroups`). */
interface GroupState {
  id: string;
  method: string;
  path: string;
  status: number;
  count: number;
  first: number;
  last: number;
  ips: Map<string, true>; // cap MAX_IPS; entry lama tidak dibuang (cukup untuk daftar contoh)
  ipCount: number; // dihitung terpisah dari ips.size karena ips di-cap
  uas: Map<string, number>;
  searchTerms: Map<string, number>;
  sizeSum: number;
  sizeCount: number;
  occ: number[];
  firstSample: Sample;
  latest: Sample[];
}

export interface AggregatorOptions {
  samples?: number;
  maxOcc?: number;
  maxGroups?: number;
}

export interface GroupLimits {
  maxOcc?: number;
  rawMax?: number;
  samples?: number;
}

const MAX_IPS = 30;

/**
 * Memori dibatasi per group (bukan per request):
 *  - counter, sizeSum/sizeCount, ipCount: tidak dibatasi (angka tetap akurat)
 *  - daftar IP contoh dan User-Agent: sampai MAX_IPS / tidak dibatasi (uas biasanya sedikit varian per endpoint)
 *  - daftar waktu kejadian: N terakhir (maxOcc)
 *  - sampel raw: 1 pertama + (samples-1) terbaru
 *  - jumlah group: maksimal maxGroups. Request dari group baru sesudah batas tercapai dihitung di `dropped`
 *    dan tidak disimpan; group yang sudah ada tetap dihitung akurat.
 */
class Aggregator {
  samples: number;
  maxOcc: number;
  maxGroups: number;
  dropped = 0;
  kept = 0;
  private map = new Map<string, GroupState>();
  private next = 1;

  constructor({ samples = 4, maxOcc = 300, maxGroups = 4000 }: AggregatorOptions = {}) {
    this.samples = Math.max(1, samples);
    this.maxOcc = Math.max(1, maxOcc);
    this.maxGroups = Math.max(1, maxGroups);
  }

  add(p: ParsedLine): void {
    const key = `${p.method} ${p.path} ${p.status}`;
    let g = this.map.get(key);
    if (!g) {
      if (this.map.size >= this.maxGroups) {
        this.dropped++;
        return;
      }
      const sample: Sample = { t: p.ts, ip: p.clientIp, size: p.size, referer: p.referer, ua: p.ua, raw: p.raw };
      g = {
        id: 'g' + this.next++,
        method: p.method,
        path: p.path,
        status: p.status,
        count: 0,
        first: p.ts,
        last: p.ts,
        ips: new Map(),
        ipCount: 0,
        uas: new Map(),
        searchTerms: new Map(),
        sizeSum: 0,
        sizeCount: 0,
        occ: [],
        firstSample: sample,
        latest: [],
      };
      this.map.set(key, g);
    } else if (this.samples > 1) {
      g.latest.push({ t: p.ts, ip: p.clientIp, size: p.size, referer: p.referer, ua: p.ua, raw: p.raw });
      if (g.latest.length > this.samples - 1) g.latest.shift();
    }

    g.count++;
    this.kept++;
    if (p.ts > g.last) g.last = p.ts;
    if (p.ts < g.first) g.first = p.ts;

    if (!g.ips.has(p.clientIp)) {
      g.ipCount++;
      if (g.ips.size < MAX_IPS) g.ips.set(p.clientIp, true);
    }
    g.uas.set(p.ua || '-', (g.uas.get(p.ua || '-') || 0) + 1);
    g.sizeSum += p.size;
    g.sizeCount++;

    if (p.searchTerm) g.searchTerms.set(p.searchTerm, (g.searchTerms.get(p.searchTerm) || 0) + 1);

    g.occ.push(p.ts);
    if (g.occ.length >= this.maxOcc * 2) g.occ = g.occ.slice(-this.maxOcc);
  }

  /** Bentuk data untuk template. `limits` dipakai untuk memperkecil ukuran bila perlu. */
  toGroups(limits: GroupLimits = {}): ReportGroup[] {
    const maxOcc = limits.maxOcc || this.maxOcc;
    const rawMax = limits.rawMax || 60000;
    const nSamples = limits.samples || this.samples;
    const groups = [...this.map.values()].map((g) => {
      const samples = [g.firstSample, ...g.latest].slice(0, nSamples).map((s) => ({ ...s, raw: truncate(s.raw, rawMax) }));
      return {
        id: g.id,
        method: g.method,
        path: g.path,
        status: g.status,
        count: g.count,
        ips: [...g.ips.keys()],
        ipCount: g.ipCount,
        avgSize: g.sizeCount ? Math.round(g.sizeSum / g.sizeCount) : 0,
        occ: g.occ.slice(-maxOcc),
        uas: [...g.uas.entries()].map(([ua, count]) => ({ ua, count })),
        searchTerms: [...g.searchTerms.entries()].map(([term, count]) => ({ term, count })),
        samples,
        first: g.first,
        last: g.last,
      };
    });
    groups.sort((a, b) => b.count - a.count);
    return groups;
  }
}

export { Aggregator };
