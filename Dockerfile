# syntax=docker/dockerfile:1

# nginxlogreport: laporan HTML dari access log nginx, dijalankan dengan Bun (langsung dari TypeScript, tanpa tahap build).
#
#   docker build -t nginxlogreport .
#   docker run --rm --user "$(id -u):$(id -g)" \
#     -v /var/log/nginx:/logs:ro -v "$PWD/reports:/reports" \
#     nginxlogreport /logs/access.log --mask --out=/reports/laporan.html
#
# Tanpa argumen, image menampilkan bantuan. `--user` supaya file laporan dimiliki pengguna Anda, bukan uid 1000.
# Uji di dalam image: docker build --target test .

ARG BUN_VERSION=1.4.0

# Tahap opsional, tidak ikut image akhir: menjalankan seluruh uji. Uji tidak butuh dependency (hanya bun:test dan modul bawaan),
# jadi tidak ada langkah install; typescript dan @types/bun hanya untuk `bun run typecheck` di CI.
FROM oven/bun:${BUN_VERSION}-slim AS test
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY test ./test
RUN bun test ./test/

FROM oven/bun:${BUN_VERSION}-slim AS runtime
LABEL org.opencontainers.image.title="nginxlogreport" \
      org.opencontainers.image.description="Laporan HTML dari access log nginx (streaming, aman untuk file besar)"

# Bun sebagai PID 1 mengabaikan SIGINT/SIGTERM (terukur: `docker stop` baru kembali setelah proses selesai sendiri atau di-kill),
# jadi Ctrl+C tidak bekerja. tini meneruskan sinyal.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
COPY src ./src
# script harian (retensi, kunci, tanggal kemarin); pakai dengan --entrypoint, lihat README
COPY deploy/nginxlogreport-daily.sh ./deploy/nginxlogreport-daily.sh

# tanpa dependency runtime, jadi tidak ada node_modules di image ini
RUN mkdir /data && chown bun:bun /data
USER bun
WORKDIR /data

ENTRYPOINT ["tini", "--", "bun", "/app/src/nginxlogreport.ts"]
CMD ["--help"]
