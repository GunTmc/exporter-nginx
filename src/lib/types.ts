/** Bentuk data yang dipakai bersama oleh parser, agregator, CLI, dan template.html. */

/** Satu baris access log nginx (combined + field ke-11 opsional untuk IP klien asli di belakang load balancer/proxy). */
export interface ParsedLine {
  ip: string; // remote_addr mentah (bisa jadi IP load balancer internal)
  clientIp: string; // field ke-11 (mis. header real-ip/X-Forwarded-For) bila ada, else sama dengan `ip`
  ts: number; // epoch detik UTC
  method: string;
  path: string; // tanpa query string, sudah dinormalisasi ({id} untuk uuid/angka)
  searchTerm: string | null; // nilai query string `search`, bila ada
  status: number;
  size: number;
  referer: string;
  ua: string;
  raw: string;
}

/* ---------------- keluaran (JSON yang ditanam di template) ---------------- */

export interface Sample {
  t: number;
  ip: string;
  size: number;
  referer: string;
  ua: string;
  raw: string;
}

export interface UaCount {
  ua: string;
  count: number;
}

export interface SearchTermCount {
  term: string;
  count: number;
}

export interface ReportGroup {
  id: string;
  method: string;
  path: string;
  status: number;
  count: number;
  ips: string[];
  ipCount: number;
  avgSize: number;
  occ: number[];
  uas: UaCount[];
  searchTerms: SearchTermCount[];
  samples: Sample[];
  first: number;
  last: number;
}

export interface ReportMeta {
  version: string;
  title: string;
  files: string[];
  bytes: number;
  entries: number;
  kept: number;
  unparsed: number;
  minStatus: number;
  date: string | null;
  from: string | null;
  to: string | null;
  tail: number | null;
  generatedAt: string;
  seconds: number;
  dropped: number;
  maxGroups: number;
  reduced: boolean;
  masked: boolean;
  samples: number;
  maxOcc: number;
  tMin: number | null;
  tMax: number | null;
}

export interface ReportPayload {
  meta: ReportMeta;
  groups: ReportGroup[];
}
