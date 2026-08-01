# DeepSeek — Arsitektur Pragmatis: Platform Analisis Pasar (Satu Produk)

> Status: opini independen (2026-08-01) · Peran: Principal Product Architect
> Input: `docs/Opus.md`, `docs/product-architecture-v2.md`, `docs/migration-plan.md` (historis)
> \+ verifikasi langsung struktur repo (`frontend/src/routes/`, `backend/app/`).

## Temuan lapangan (yang mengubah rencana kedua dokumen)

Opus dan v2 menulis seolah merge dimulai dari nol. Verifikasi repo menunjukkan **merge API-nya sudah 60% jalan — tapi dalam bentuk proxy**, persis anti-pattern yang dikhawatirkan Opus:

- `backend/app/quant/router.py` = **proxy HTTP** ke dashboard Quant (8787). Regime, feed sinyal, forecast masih dikomputasi Quant; MP cuma meneruskan. Tab "Quant" di MP adalah jendela ke app lain, bukan data.
- `backend/app/tradeway/router.py` = proxy ke `localhost:8100` yang **belum dibangun** (selalu 503 offline).
- Yang justru sudah benar: tabel `alerts` + `/api/v1/alerts` (severity, delivered_at), SSE `positions.stream`, journal `trades`, `execution.permit/execute/skip_check`, review/forensics, `news_intel`.

Konsekuensinya, pekerjaan "menyatu" bukan membangun yang baru, tapi **membalik arah: matikan proxy, jadikan writer; satukan mulut notifikasi; tambah satu feed.** Ini jauh lebih murah dari yang dibayangkan Opus (8 fase) maupun v2 (5 fase).

## 1. Product Vision

> **Satu tempat di mana semua sinyal, posisi, dan bukti performanya berkumpul — sehingga Dee tahu apa yang terjadi, apa yang layak diambil, dan sumber mana yang bisa dipercaya, tanpa membuka tiga aplikasi.**

Artinya dalam praktik:

1. **Satu pintu.** Satu bot Telegram, satu URL (`iq.heydewi.com`), satu login. Alert Quant, SMC, dan (nanti) Tradeway keluar dari mulut yang sama dan menaut ke halaman yang sama.
2. **Satu bahasa peluang.** Semua sinyal tampil sebagai objek yang sama: simbol, arah, alasan, sumber, bukti. Sumber jadi **badge**, bukan tab — menambah sumber tidak menambah layar.
3. **Jujur soal bukti.** Peluang menampilkan track record sumbernya kalau angkanya ada; kalau belum, tertulis "belum cukup data". Tidak ada klaim tanpa angka.

## 2. Workflow Sederhana (5 langkah)

1. **Notifikasi pagi — 1 pesan Telegram.** Regime + confidence + jumlah ide lolos gate + posisi berisiko. Satu bot, bukan tiga.
2. **Ideas — 1 layar.** Semua peluang dalam satu feed: simbol, arah, alasan satu baris, badge sumber. Yang melawan regime tenggelam ke bawah (tidak dihapus).
3. **Ticket — 1 layar.** Chart + zona + alasan + hit-rate sumber. Dua tombol: **Entry** (permit → eksekusi, semua sudah ada di MP) atau **Skip** (alasan sekali tap — `skip_check` sudah ada).
4. **Posisi — notifikasi + 1 layar.** Alert regime flip / SL dekat → tap → layar posisi: tighten, close, atau biarkan.
5. **Journal — 1 layar, mingguan.** Otomatis dari langkah 3 (entry & skip tercatat): sumber mana yang benar, mana yang kamu abaikan.

Tidak ada langkah "buka dashboard Quant". Tidak ada langkah "bandingkan tiga app". Setiap langkah = satu layar atau satu notifikasi.

## 3. Migration Plan Realistis

Prinsip: **potong scope dulu, engineering belakangan.** Tiap fase ≤3 hari, berakhir live & terpakai, punya rollback satu baris. Tidak ada fase yang menyentuh tiga repo untuk hal yang sama.

### Yang dipotong (sekarang atau selamanya)

- **Tradeway-api (8100) — jangan dibangun sekarang.** Service-nya belum ada; posisi Bybit hari ini 503. Tunggu bot Tradeway benar-benar jalan, baru feed read-only masuk Book. (Berbeda dari Opus & v2 yang sama-sama memprioritaskan ini.)
- **Zipline** — tidak pernah. Runner backtest MP (`backtest_run`) sudah ada.
- **Bybit sebagai execution provider** — tidak pernah. Read-only saja.
- **Parquet lake + research plane** — tunda. Volume solo-founder muat di Postgres; buktikan butuh dulu.
- **Redesign nav (4/5 tab)** — tunda ke fase polish. Penyebab rasa "tiga app" adalah tiga mulut + proxy, bukan nama tab.
- **Kontrak `signal_events` lengkap** (context_ref, dedup_key, state machine shadow) — mulai subset kolom; sisanya menyusul kalau Evidence benar-benar butuh.
- **Monorepo** — tunda.

### Fase 1 — Satu Mulut (2 hari)

**Deliverable:**
- `backend/app/delivery/`: `sender.py` (satu token `PLATFORM_BOT_TOKEN`, Bot API `sendMessage` langsung, tanpa framework) + hook di `alert_service.py` (setiap row `alerts` dibuat → terkirim).
- `POST /api/v1/alerts/ingest` — jalur masuk alert dari luar (quant, tradeway) dengan auth internal key (pola `X-Internal-Key` yang sudah ada dari dual-auth bridge).
- notifier-bot: ganti kirim langsung → POST ke MP (dual-run 48 jam di belakang flag).
- Deep link `https://iq.heydewi.com/token/{symbol}` di tiap pesan.
- `quant.dev.heydewi.com` → 301 ke `iq.heydewi.com`.

**Exit:** 48 jam penuh tanpa notifikasi ganda; semua alert (MP + quant) keluar dari satu bot; deep link mendarat benar.

### Fase 2 — Balik Arah: Proxy → Writer (2–3 hari)

**Deliverable:**
- Tabel `signal_events` (append-only, gaya Alembic existing): `id, source, source_version, symbol, side, horizon, detected_at, expires_at, features jsonb, status`.
- `POST /api/v1/ingest/signal` — detektor Quant menulis saat deteksi (dual-run 48 jam; dashboard 8787 tetap hidup untuk backfill).
- **Ubah `quant/router.py`: berhenti forward ke 8787** — baca dari tabel sendiri. Dashboard Quant jadi konsumen data, bukan pemilik.
- `GET /api/v1/opportunities` — dedup `(symbol, side, hari)` + gate regime (verdict MP existing).

**Exit:** 48 jam reconcile: `count(signal_events)` == jumlah sinyal dashboard; `GET /api/v1/quant/state` 200 tanpa menyentuh 8787.

### Fase 3 — Satu Feed (3 hari)

**Deliverable:**
- Route baru `frontend/src/routes/ideas.tsx` — feed `/api/v1/opportunities`: kartu simbol/arah/alasan/badge sumber/hit-rate (dari forward-test 2.0.0 kalau ada).
- Perluas `token.$symbol.tsx` jadi Ticket: tab sinyal terkait (dari `signal_events`) + forecast + zona existing + tombol Entry (`execution.permit`/`execute` existing) / Skip (`skip_check` existing). Semua komponen sudah ada — tinggal dirangkai.
- Satu tab "Ideas" di nav (tanpa redesign lain).

**Exit:** alur notifikasi → Ideas → Ticket → keputusan tercatat (entry **atau** skip), semua di `iq.heydewi.com`, ≤2 tap dari notifikasi.

### Sesudahnya (ringkas)

- **Fase 4 — Book (2 hari):** posisi Binance (existing) + Bybit (saat 8100 hidup) di satu layar; alert risiko regime flip.
- **Fase 5 — Polish (2–3 hari):** Lab (scorecard per sumber dari forward-test 2.0.0), konsolidasi nav, Mini App adapter, hapus rute museum.

## 4. Fokus Implementasi Bertahap (Sprint 1 — 2 hari)

**Tujuan:** buktikan "satu produk" di titik kontak harian Dee — Telegram — tanpa menyentuh UI.

**Isi Sprint 1:**
1. `backend/app/delivery/sender.py` — kirim pesan via satu token bot.
2. Hook di `alert_service.py`: setelah alert dibuat → kirim (severity satu-satunya aturan; tidak ada rules engine).
3. Pindahkan **satu** alert nyata: digest pagi Quant (regime + confidence + jumlah sinyal) → POST `alerts/ingest` → MP kirim.
4. Deep link di pesan.

**Exit criteria:**
- 2 pagi berturut: digest terkirim **sekali**, dari **satu** bot, deep link terbuka ke halaman token yang benar.
- Rollback = 1 flag di notifier-bot (balik kirim langsung).

**Kenapa ini?** Persepsi "satu produk" terbentuk di notifikasi, bukan di tab. Tiga mulut = tiga produk; satu mulut yang menunjuk ke satu tempat = satu produk — biaya 2 hari, risiko hampir nol, dan Fase 1–3 tinggal memperlebar loop yang sudah terbukti. Kalau sprint ini gagal, tidak ada yang rusak: notifier lama masih jalan.
