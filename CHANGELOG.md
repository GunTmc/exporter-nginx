# Riwayat perubahan

## [1.0.1] - 2026-09-28

### Ditambahkan

- Filter rentang waktu **Dari** / **Sampai** (`datetime-local`) di laporan, mengikuti zona waktu
  tampilan (WIB/UTC), tersinkron dengan klik batang timeline, dan tampil lengkap di chip filter.

### Diperbaiki

- Tabel per endpoint rusak (kolom terdorong keluar layar) saat diurutkan Terbaru/Terlama: lebar
  bar jumlah diskalakan dari baris pertama, bukan jumlah terbesar.
- Urutan Terlama/Terbaru tampak salah karena hanya kolom "Terakhir" yang ditampilkan: kini ada
  kolom Pertama dan Terakhir, penanda kolom urutan, dan urutan kedua berdasarkan jumlah.
- Filter waktu tidak lagi melewatkan grup yang kejadian lamanya tidak tersimpan di `occ`.

## [1.0.0] - 2026-09-23

Rilis awal versi production-ready, ditulis ulang total dari prototipe `nginxlogreport.js` /
`nginxlogreport.php` (dihapus). Pola proyek mengikuti `alogreport` (laporan log Laravel sebelah):
Bun + TypeScript strict, Docker, deploy systemd, CI.

### Ditambahkan

- `src/nginxlogreport.ts` + `src/lib/{parser,aggregate,reader,util,types}.ts`: CLI ditulis dalam
  TypeScript strict, dijalankan langsung oleh Bun tanpa tahap build. Streaming per chunk 1 MB
  (`src/lib/reader.ts`), aman untuk file >100 MB, mendukung `.gz` dan `--tail`.
- IP klien asli di belakang load balancer: field ke-11 baris log (mis. `$http_x_forwarded_for`)
  dipakai untuk semua statistik IP, jatuh kembali ke `remote_addr` bila tidak ada. Sebelumnya
  regex sudah menangkap field ini tapi tidak pernah dipakai.
- `--mask` / `--mask-uuid`: samarkan email, NIK, nomor HP, token (JWT/Bearer), dan UUID yang
  nyasar ke query string/referer/User-Agent pada baris raw yang disimpan sebagai sampel.
- Opsi baru: `--from`/`--to` (filter jam), `--json` (dump data untuk debug), `--template`
  (template HTML lain), `--mode` (izin file keluaran, default `600`), `--quiet`.
- Laporan ditulis lewat file sementara lalu *rename* (`writeFileSecure`), dan menolak menimpa file
  masukan (termasuk lewat symlink).
- `Dockerfile` (tahap `test` dan `runtime`, berbasis `oven/bun:1.4.0-slim`, non-root, `tini` sebagai
  PID 1) + `.dockerignore`. `deploy/nginxlogreport-daily.sh` + unit/timer systemd untuk laporan
  harian otomatis dengan retensi.
- `test/`: `bun:test` untuk parser, aggregator, reader, util, dan CLI end-to-end (103 test), plus
  `test/make-sample-log.ts` yang membuat log sintetis dari pola log produksi nyata (endpoint
  pencarian typeahead, LB IP + client IP di field ke-11).
- `.github/workflows/ci.yaml` (typecheck, test matrix Bun 1.4.0 + latest, script deploy) dan
  `docker.yaml` (build + uji image, push GHCR multi-arch pada tag `v*`).

### Dihapus

- `nginxlogreport.js` (Node), `nginxlogreport.php`, dan contoh laporan lama (`contoh-laporan*.html`)
  — diganti total oleh `src/` di atas. `report-template.html` dipindah ke `src/template.html`.
