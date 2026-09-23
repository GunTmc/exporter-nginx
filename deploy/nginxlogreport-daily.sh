#!/usr/bin/env bash
# Membuat laporan harian dari access log nginx. Dipanggil dari cron atau systemd timer.
#
# Konfigurasi: environment > file /etc/default/nginxlogreport > nilai bawaan (lihat deploy/nginxlogreport.env.example).
# Jadi pengisian ulang cukup: REPORT_DATE=2026-09-20 deploy/nginxlogreport-daily.sh
# Disarankan berjalan sesudah tengah malam untuk kemarin (REPORT_DATE=yesterday), supaya log hari itu sudah lengkap.
#
# Nginx secara default TIDAK memberi nama file per tanggal (rotasi logrotate biasa menghasilkan
# access.log.1.gz, bukan access.log-2026-09-20.log). Script ini mencari file bernama
# "$LOG_PREFIX-$REPORT_DATE.log[.gz]", jadi logrotate perlu dikonfigurasi dengan
# `dateext` + `dateformat -%Y-%m-%d` (lihat nginxlogreport.env.example) agar nama filenya cocok.
set -euo pipefail
umask 077 # laporan memuat IP dan aktivitas pengguna nyata: hanya pemilik yang boleh membaca

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

ENV_FILE="${NGINXLOGREPORT_ENV:-/etc/default/nginxlogreport}"
if [ -r "$ENV_FILE" ]; then
  # simpan nilai dari environment, baca file, lalu kembalikan: environment menang atas file
  declare -A saved=()
  for v in LOG_DIR REPORT_DIR LOG_PREFIX REPORT_DATE STATUS MASK REPORT_MODE RETENTION_DAYS RUNTIME NGINXLOGREPORT_ARGS; do
    [ -n "${!v+x}" ] && saved[$v]="${!v}"
  done
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  for v in "${!saved[@]}"; do printf -v "$v" '%s' "${saved[$v]}"; done
fi

: "${LOG_DIR:?LOG_DIR harus diisi, mis. /var/log/nginx}"
: "${REPORT_DIR:=/var/reports/nginx}"
: "${LOG_PREFIX:=access}"        # nama file log: <LOG_PREFIX>-YYYY-MM-DD.log[.gz]
: "${REPORT_DATE:=$(date +%F)}"  # YYYY-MM-DD atau "yesterday"
: "${STATUS:=0}"                 # status code minimum yang disimpan (0 = semua request)
: "${MASK:=1}"                   # 1 = samarkan data yang nyasar ke query/referer (--mask); 0 = mati
: "${REPORT_MODE:=600}"          # izin file laporan
: "${RETENTION_DAYS:=30}"        # hapus laporan lebih tua dari ini; 0 = jangan hapus
: "${RUNTIME:=bun}"              # executable Bun (nama di PATH atau path lengkap, mis. /usr/local/bin/bun)
: "${NGINXLOGREPORT_ARGS:=}"     # opsi tambahan, dipisah spasi (mis. "--max-groups=1000")

log() { printf '%s nginxlogreport: %s\n' "$(date '+%F %T')" "$*"; }
die() { log "GAGAL: $*" >&2; exit 1; }

[ "$REPORT_DATE" = "yesterday" ] && REPORT_DATE="$(date -d yesterday +%F)"
[[ "$REPORT_DATE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || die "REPORT_DATE tidak valid: $REPORT_DATE (pakai YYYY-MM-DD atau yesterday)"
[[ "$RETENTION_DAYS" =~ ^[0-9]+$ ]] || die "RETENTION_DAYS harus bilangan bulat: $RETENTION_DAYS"
[[ "$LOG_PREFIX" =~ ^[A-Za-z0-9._-]+$ ]] || die "LOG_PREFIX hanya boleh huruf, angka, titik, garis bawah, dan strip: $LOG_PREFIX"
command -v "$RUNTIME" >/dev/null 2>&1 || die "Bun tidak ditemukan: $RUNTIME (pasang Bun, atau isi RUNTIME dengan path lengkapnya)"
CLI="$APP_DIR/src/nginxlogreport.ts" # Bun menjalankan TypeScript langsung, tanpa build
[ -f "$CLI" ] || die "$CLI tidak ada"
[ -d "$LOG_DIR" ] || die "LOG_DIR tidak ada: $LOG_DIR"

# satu proses pada satu waktu (mencegah tumpang tindih bila proses sebelumnya lambat)
mkdir -p "$REPORT_DIR"
exec 9>"$REPORT_DIR/.nginxlogreport.lock"
flock -n 9 || { log "masih ada proses lain yang berjalan, dilewati"; exit 0; }

input=""
for candidate in "$LOG_DIR/$LOG_PREFIX-$REPORT_DATE.log" "$LOG_DIR/$LOG_PREFIX-$REPORT_DATE.log.gz"; do
  [ -f "$candidate" ] && { input="$candidate"; break; }
done
if [ -z "$input" ]; then
  log "tidak ada log untuk $REPORT_DATE di $LOG_DIR (dicari: $LOG_PREFIX-$REPORT_DATE.log[.gz]), dilewati"
  exit 0
fi

output="$REPORT_DIR/$LOG_PREFIX-$REPORT_DATE.html"
args=(--status="$STATUS" --out="$output" --mode="$REPORT_MODE" --title="Laporan akses $REPORT_DATE" --quiet)
[ "$MASK" = "1" ] && args+=(--mask)
# shellcheck disable=SC2206 # NGINXLOGREPORT_ARGS sengaja dipecah per spasi
[ -n "$NGINXLOGREPORT_ARGS" ] && args+=($NGINXLOGREPORT_ARGS)

"$RUNTIME" "$CLI" "$input" "${args[@]}" || die "nginxlogreport gagal untuk $input"
log "OK: $output ($(du -h "$output" | cut -f1)) dari $(basename "$input")"

if [ "$RETENTION_DAYS" -gt 0 ]; then
  find "$REPORT_DIR" -maxdepth 1 -type f -name "$LOG_PREFIX-*.html" -mtime "+$RETENTION_DAYS" -print -delete |
    while read -r old; do log "hapus laporan lama: $old"; done
fi
