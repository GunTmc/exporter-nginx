import type { ParsedLine } from './types';

/**
 * Log format `combined` nginx, plus grup ke-11 opsional untuk IP klien asli
 * (mis. `log_format combined_realip '... "$http_user_agent" "$http_x_forwarded_for"'`
 * atau `"$http_true_client_ip"`) — umum saat nginx berada di belakang load balancer,
 * karena `$remote_addr` di situ adalah IP internal si load balancer, sama untuk semua
 * request, dan tidak berguna untuk statistik "IP unik".
 */
const LOG_RE =
  /^(\S+) \S+ \S+ \[([^\]]+)\] "(\S+)?\s?(\S+)?\s?(\S+)?" (\d{3}) (\S+) "([^"]*)" "([^"]*)"(?: "([^"]*)")?/;

const MONTHS: Record<string, number> = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };

/** "23/Sep/2026:03:14:01 +0700" -> epoch detik UTC, atau null bila tidak valid. */
function parseNginxTime(timeStr: string | undefined): number | null {
  if (!timeStr) return null;
  const m = /(\d+)\/(\w+)\/(\d+):(\d+):(\d+):(\d+) ([+-]\d{4})/.exec(timeStr);
  if (!m) return null;
  const [, day, monName, year, hour, min, sec, tz] = m;
  const monthNum = MONTHS[monName] || 1;
  const tzSign = tz[0] === '-' ? -1 : 1;
  const tzHours = parseInt(tz.slice(1, 3), 10);
  const tzMins = parseInt(tz.slice(3, 5), 10);
  const offsetSec = tzSign * (tzHours * 3600 + tzMins * 60);
  const utcMs = Date.UTC(+year, monthNum - 1, +day, +hour, +min, +sec);
  return Math.floor(utcMs / 1000) - offsetSec;
}

/** UUID -> `{id}`, segmen numerik >= 2 digit -> `{id}`, supaya endpoint yang sama ter-grup. */
function normalizePath(p: string): string {
  if (!p) return p;
  p = p.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '{id}');
  p = p.replace(/\/\d{2,}(?=\/|$)/g, '/{id}');
  return p;
}

/** Satu baris access log -> ParsedLine, atau null bila tidak sesuai format / waktu tidak valid. */
function parseLine(line: string): ParsedLine | null {
  const m = LOG_RE.exec(line);
  if (!m) return null;
  const [, ip, timeStr, method, reqPath, , status, size, referer, ua, xff] = m;

  const ts = parseNginxTime(timeStr);
  if (ts === null) return null;

  let pathOnly = reqPath || '';
  let searchTerm: string | null = null;
  const qIdx = pathOnly.indexOf('?');
  if (qIdx >= 0) {
    const qs = pathOnly.slice(qIdx + 1);
    pathOnly = pathOnly.slice(0, qIdx);
    const params = new URLSearchParams(qs);
    if (params.has('search')) searchTerm = params.get('search');
  }

  // field ke-11 (mis. real client IP di belakang load balancer): dipakai bila ada dan bukan "-"
  const clientIp = xff && xff !== '-' ? xff : ip;

  return {
    ip,
    clientIp,
    ts,
    method: method || '-',
    path: normalizePath(pathOnly),
    searchTerm,
    status: parseInt(status, 10),
    size: size === '-' ? 0 : parseInt(size, 10) || 0,
    referer,
    ua,
    raw: line,
  };
}

export { LOG_RE, parseNginxTime, normalizePath, parseLine };
