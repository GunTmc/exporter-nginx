# nginxlogreport

Laporan HTML dari access log nginx: grup per endpoint (method + path + status), timeline, filter
per status/method/jam, dan detail per endpoint (IP, User-Agent, kata kunci pencarian, contoh baris
raw). Satu file HTML mandiri — tanpa server, tanpa koneksi keluar, bisa dibuka langsung di browser.

Streaming: baca file per chunk 1 MB, jadi aman untuk log >100 MB dan mendukung `.gz` tanpa
dekompresi manual. Dijalankan dengan [Bun](https://bun.sh) langsung dari TypeScript, tanpa tahap
build.

## Pemakaian cepat

```sh
bun install
bun src/nginxlogreport.ts /var/log/nginx/access.log
# atau lewat script:
bun run start /var/log/nginx/access.log --out=laporan.html
```

Contoh lain:

```sh
bun src/nginxlogreport.ts access.log --status=400                # hanya request error (>=400)
bun src/nginxlogreport.ts access.log --date=2026-09-23            # hanya tanggal ini
bun src/nginxlogreport.ts access.log --from=08:00 --to=17:00      # hanya jam kerja
bun src/nginxlogreport.ts access.log.gz --tail=50MB               # 50 MB terakhir (bukan .gz)
bun src/nginxlogreport.ts access.log --mask --out=laporan.html    # samarkan data sensitif
bun src/nginxlogreport.ts access-1.log access-2.log.gz            # gabungkan beberapa file
```

## IP klien di belakang load balancer

Bila nginx berada di belakang load balancer/reverse proxy, `$remote_addr` di access log adalah IP
**internal** load balancer — sama untuk semua request, sehingga statistik "IP unik" jadi tidak
berguna bila dihitung dari situ. Tool ini membaca field ke-11 baris log (setelah User-Agent), yang
umumnya diisi IP klien asli lewat `log_format` semacam:

```nginx
log_format combined_realip '$remote_addr - $remote_user [$time_local] '
                            '"$request" $status $body_bytes_sent '
                            '"$http_referer" "$http_user_agent" '
                            '"$http_x_forwarded_for"';
access_log /var/log/nginx/access.log combined_realip;
```

Semua statistik IP (IP unik per endpoint, daftar IP contoh) memakai field ini bila ada, dan jatuh
kembali ke `$remote_addr` bila kosong atau `-` (mis. akses langsung tanpa load balancer).

## Opsi CLI

```
nginxlogreport <access.log|access.log.gz> [file lain ...] [opsi]

  --status=400         hanya simpan request dengan status code >= ini. Default: 0 (semua)
  --date=2026-09-23    hanya request pada tanggal ini
  --from=08:00         hanya request mulai jam ini (HH:MM atau HH:MM:SS)
  --to=17:00           hanya request sampai jam ini
  --tail=50MB          baca hanya 50 MB terakhir dari file (tidak untuk .gz)
  --samples=4          jumlah sampel raw per group (1 pertama + sisanya terbaru). Default: 4
  --max-occ=300        jumlah waktu kejadian yang disimpan per group. Default: 300
  --max-groups=4000    jumlah group maksimal. Default: 4000
  --max-mb=10          batas ukuran data di HTML; dikurangi otomatis bila lewat. Default: 10
  --mask               samarkan email, NIK, no-HP, token (JWT/Bearer) di query/referer/UA
  --mask-uuid           samarkan juga UUID. Otomatis mengaktifkan --mask
  --out=report.html    file keluaran. Default: report.html
  --mode=600            izin file keluaran (oktal). Default: 600
  --title="Judul"      judul laporan
  --json=data.json     simpan juga data hasil parsing dalam JSON (untuk debug)
  --template=path      pakai template HTML lain
  --quiet              tanpa progress dan ringkasan (peringatan tetap tampil)
  --version  --help
```

Kode keluar: `0` berhasil, `1` gagal saat berjalan, `2` salah pemakaian.

## Keamanan

- Laporan ditulis lewat file sementara lalu di-*rename*, jadi pembaca tidak pernah melihat file
  setengah jadi. Izin file default `600` (`--mode` untuk mengubah) karena laporan memuat IP dan
  aktivitas pengguna nyata.
- File keluaran (`--out`, `--json`) tidak boleh sama dengan file masukan (termasuk lewat symlink).
- `--mask`/`--mask-uuid` menyamarkan data yang mungkin nyasar ke query string, referer, atau
  User-Agent (dan tersimpan di baris *raw* sebagai sampel) — bukan IP, karena itu justru dasar
  statistik "IP unik" pada laporan.

## Docker

```sh
docker build -t nginxlogreport .
docker run --rm --user "$(id -u):$(id -g)" \
  -v /var/log/nginx:/logs:ro -v "$PWD/reports:/reports" \
  nginxlogreport /logs/access.log --mask --out=/reports/laporan.html
```

`--user` supaya file laporan dimiliki pengguna Anda, bukan uid image. Tanpa argumen, image
menampilkan bantuan. Uji di dalam image: `docker build --target test .`.

Image (`oven/bun:1.4.0-slim`, ~165 MB) menjalankan `src/nginxlogreport.ts` langsung (tanpa
dependency runtime), sebagai user non-root, dan memakai `tini` sebagai PID 1 — tanpanya Bun
mengabaikan `SIGTERM` sehingga `docker stop` menunggu sampai proses selesai sendiri.

## Deploy harian (systemd timer)

`deploy/nginxlogreport-daily.sh` membuat laporan harian dari log kemarin, dengan retensi otomatis
dan lock file (mencegah proses tumpang tindih).

```sh
sudo cp -r . /opt/nginxlogreport
sudo cp deploy/nginxlogreport.env.example /etc/default/nginxlogreport
sudo $EDITOR /etc/default/nginxlogreport   # isi LOG_DIR, dst.
sudo chmod 640 /etc/default/nginxlogreport
sudo useradd --system --home /nonexistent --shell /usr/sbin/nologin nginxlogreport
sudo cp deploy/nginxlogreport.service deploy/nginxlogreport.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now nginxlogreport.timer
```

Nginx secara default **tidak** menamai log per tanggal (rotasi logrotate biasa menghasilkan
`access.log.1.gz`, bukan `access-2026-09-20.log`). Script ini mencari file bernama
`<LOG_PREFIX>-<tanggal>.log[.gz]`, jadi logrotate perlu dikonfigurasi dengan `dateext` dan
`dateformat -%Y-%m-%d` — lihat `deploy/nginxlogreport.env.example`.

## Pengembangan

```sh
bun install
bun run typecheck   # tsc --strict, tanpa emit
bun test ./test/    # bun:test
bun run sample       # buat examples/sample.log + examples/sample-report.html
bun run docker:build
```

Struktur:

```
src/nginxlogreport.ts   CLI: argumen, baca file, tulis laporan
src/template.html        template HTML+JS laporan (data ditanam lewat /*__DATA__*/null)
src/lib/reader.ts        baca file per chunk, streaming, .gz, tail
src/lib/parser.ts        parseLine(): satu baris access log -> data terstruktur
src/lib/aggregate.ts     Aggregator: grup per endpoint, batas memori per group
src/lib/util.ts          helper CLI (parseClock, parseSize, ...) + makeMasker
test/                    bun:test — parser, aggregate, reader, util, CLI end-to-end
```

## Lisensi

MIT
