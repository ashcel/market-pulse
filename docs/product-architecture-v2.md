# Product Architecture v2 — Market Analysis Platform

> Status: proposal (2026-08-01) · Author: Bima (Principal Product Architect)
> Pengganti dari: model "3 aplikasi ditempel" (quant dashboard + Market Pulse + standalone miniapp)

---

## 1. Kritik Arsitektur Produk Saat Ini

Yang ada sekarang bukan 1 produk — tapi 3 permukaan UI + 1 lapisan proxy:

| Surface | Sebenarnya | Masalah |
|---|---|---|
| `quant.dev.heydewi.com` | Dashboard sinyal Quant | UI terpisah, auth sendiri, data sendiri |
| `iq.heydewi.com` (Market Pulse) | Platform keputusan paling lengkap | UI desktop, belum mobile-first, Mini App-nya cuma shell |
| `mini.dev.heydewi.com` | Proxy glue | Tab Market cuma 2 endpoint, token MP 404, rantai proxy rapuh |
| Tradeway (bot Bybit) | Eksekusi | Tanpa permukaan UI, keys Bybit nggak ada di infra ini |

**Kritik struktural (bukan cuma teknis):**

1. **IA-nya by data-type, bukan by workflow.** Tab "Market / Quant / Posisi / Journal" = 4 gudang data. Trader nggak mikir "aku mau buka tab Market" — dia mikir "apa yang terjadi hari ini?", "mana peluangnya?", "haruskah aku masuk?". Produk harus mengikuti alur berpikir trader, bukan struktur database.
2. **Quant dianggap produk, padahal dia engine.** Quant = pipeline deteksi sinyal yang tervalidasi ratusan jam backtest. Nilainya ada di *deteksi*, bukan di *UI-nya*. Mempertahankan dashboard Quant sebagai permukaan produk = mempertahankan duplikasi.
3. **Market dianggap satu domain, padahal dia lapisan konteks.** Sentimen/makro/regime adalah INPUT keputusan, bukan tujuan browsing.
4. **Posisi dianggap modul, padahal dia state.** Posisi adalah kondisi portfolio saat ini — dia muncul di banyak tempat (alert, portfolio, review), bukan tab yang berdiri sendiri. (Keputusan Dee benar: posisi = fitur.)
5. **"Merge" dipahami sebagai penyatuan codebase, padahal masalahnya penyatuan produk.** Menggabungkan kode 3 app = tetap 3 app dalam 1 kode. Yang harus digabung: pengalaman, alur, dan identitas.

**Keputusan desain Dee yang sebelumnya — dikritisi jujur:**
- *"Merge marketpulse ke tradeway mini app"* → mental model "tradeway = produk". Tradeway adalah infrastruktur eksekusi (Bybit bot). Produk harusnya platform analisis; Tradeway jadi provider eksekusi di belakangnya. Nama "tradeway mini app" tidak akan pernah menghasilkan satu produk profesional — nama itu menempel ke satu layer.
- *"Full convert, gak harus ke market pulse"* → arahnya benar (Mini App nggak boleh keliatan kayak desktop MP), tapi yang salah adalah solusinya (app baru + proxy). Yang benar: **satu app yang responsif** — Mini App adalah *wajah mobile* dari produk yang sama, bukan app kedua.

---

## 2. Product Vision (satu kalimat)

> **Satu platform yang menuntun trader dari konteks pasar → keputusan → eksekusi → refleksi, sebagai satu alur yang utuh — ditemukan peluangnya, diputuskan dengan bukti, dipantau posisinya, dan direview hasilnya — dari mana saja, dalam hitungan detik.**

Pola: **Context → Opportunity → Decision → Action → Reflection.** Semua fitur yang nggak melayani pola ini dipertanyakan.

---

## 3. User Journey Ideal (trader → keputusan)

**Scenya: Dee, trader futures, membuka Mini App di Telegram.**

1. **07:00 WIB — Brief (10 detik).** Buka app → langsung: regime **BEAR** (confidence 0.8), bias 1D bearish / 4H bearish, 2 event makro high-impact hari ini, sentimen negatif. Dee langsung tahu kondisi. Tanpa scroll.
2. **Opportunities (20 detik).** Feed peluang: 1 sinyal **high conviction** (ETHUSDT short, alasan: OB bearish + regime align) + verdict universe (BTC wait, ETH go-short, SOL no-go) + watchlist. Diurutkan: conviction × alignment × freshness.
3. **Trade — analisis (60 detik).** Tap ETH → chart + forecast (TP/SL probability), events terkait (regulatory warning, impact 75), konteks risiko (funding, leverage aman), AI validation. Semua di satu layar, nggak pindah app.
4. **Trade — keputusan & eksekusi (10 detik).** Panel keputusan: conviction + sizing (sesuai konstitusi) + permit → **Execute** → order masuk via execution engine.
5. **Portfolio (monitoring).** Posisi muncul real-time (entry, uPnl). Alert otomatis: SL/TP dekat, regime flip, funding ekstrem. Dee nggak perlu buka exchange.
6. **Journal (malam, 5 menit).** Review otomatis: forensics tiap trade (kenapa menang/kalah), decision history. Input besok. Loop tertutup.

**Prinsip journey:** *setiap layar = satu pertanyaan trader, dijawab dalam ≤60 detik, tanpa pindah app.*

---

## 4. Information Architecture & Navigation (baru)

**Bottom nav (5 domain, mobile-first):**

```
┌─────────────────────────────────────────────┐
│  Brief  │  Opportunities  │  Trade  │  Portfolio  │  Journal  │
└─────────────────────────────────────────────┘
```

| Domain | Pertanyaan trader | Isi |
|---|---|---|
| **Brief** | "Apa yang terjadi sekarang?" | Regime + confidence · bias 1D/4H · makro hari ini · sentimen · (opsional) ringkasan AI |
| **Opportunities** | "Mana yang layak kulihat?" | Sinyal Quant (ranked by conviction) · verdict universe (go/wait/no_go) · watchlist |
| **Trade** | "Haruskah aku masuk?" | Analisis token: chart + forecast + events + risiko → panel keputusan (conviction/permit/sizing) → execute |
| **Portfolio** | "Di mana posisiku?" | Posisi live + P&L · exposure meter · risiko · alert terakhir · (posisi = state, bukan modul) |
| **Journal** | "Apa yang aku pelajari?" | Review otomatis · forensics per trade · decision history · pelajaran |

**Menjawab challenge Dee:**
- **Quant layak jadi tab utama?** → **Tidak.** Quant = engine deteksi. Output-nya jadi *data* di Brief (regime) dan Opportunities (sinyal). Tab "Quant" dihapus.
- **Market perlu dipisah?** → **Tidak.** Konteks market (sentimen/makro/universe) = lapisan yang mengisi Brief + Opportunities. Tab "Market" dihapus.
- **Position jadi fitur, bukan modul?** → **Setuju.** Posisi = state portfolio, dirender di Portfolio + dipakai alerting.
- **Flow mengikuti workflow trader?** → **Sekarang ya.** Brief → Opportunities → Trade → Portfolio → Journal = urutan siklus keputusan trader.

---

## 5. Domain Model (final)

**Domain (produk):**
1. **Context** — regime, bias, makro, sentimen (sumber: engine quant + MP market)
2. **Opportunity** — sinyal, verdict, watchlist (sumber: quant detectors → tabel signals)
3. **Decision** — analisis token, conviction, permit, sizing (sumber: MP decision/execution)
4. **Execution** — order placement, provider abstraction (Binance native → Bybit via Tradeway)
5. **Portfolio** — posisi, P&L, exposure, risk (sumber: exchange state)
6. **Reflection** — review, forensics, journal (sumber: MP review)

**Bukan domain (infrastruktur):** Quant detection pipeline (engine), Tradeway bot (execution provider), Binance/Bybit API (data/exchange).

---

## 6. Hapus · Gabung · Pindah

| Aksi | Item | Alasan |
|---|---|---|
| **HAPUS** | `mini.dev.heydewi.com` (standalone miniapp) | Proxy glue, shallow, duplikasi UI |
| **HAPUS** | Tab "Market", "Posisi", "Quant" sebagai domain | Bukan alur trader; jadi bagian domain lain |
| **HAPUS** | `quant.dev.heydewi.com` sebagai surface produk | **Redirect** ke platform; kontennya (regime, feed, forecast) jadi fitur native |
| **HAPUS** | Rantai proxy miniapp (→8787/→8100/→8002) | Diganti ingestion data → Postgres + satu API |
| **GABUNG** | Konteks market → **Brief** | Sentimen/makro/regime = input keputusan |
| **GABUNG** | Sinyal Quant + verdict → **Opportunities** | Satu feed peluang, ranked |
| **GABUNG** | Forecast chart + analisis MP → **Trade** | Satu layar keputusan per token |
| **GABUNG** | Posisi → **Portfolio** (fitur) | State, bukan domain |
| **PINDAH** | Quant detection → **ingestion service** (tulis ke Postgres MP) | Engine nulis data, bukan nampilin UI |
| **PINDAH** | Tradeway → **execution provider** (belakangan) | Satu antarmuka eksekusi, banyak provider |

---

## 7. Software Architecture (mendukung product architecture)

```
┌─────────────────────────────────────────────────────────┐
│  SATU PRODUK: Market Pulse platform (TanStack SSR)      │
│  Mini App = wajah mobile (responsive, menu button TG)   │
│  Auth: initData Telegram → MP session (satu identitas)  │
├─────────────────────────────────────────────────────────┤
│  API: FastAPI /api/v1 — orchestrators:                 │
│   brief · opportunities · trade/{sym} · portfolio · journal │
│  (memakai router existing: market, universe, signals,   │
│   position, review, decision, execution)                │
├─────────────────────────────────────────────────────────┤
│  DATA (Postgres — "semua data di postgres"):           │
│   signals (dari quant engine) · candles (parquet cache) │
│   regime/sentiment/macro · positions · reviews          │
├─────────────────────────────────────────────────────────┤
│  INGESTION (worker/cron):                              │
│   quant detectors → tabel signals (bukan proxy!)        │
│   data harian → parquet → Postgres                      │
├─────────────────────────────────────────────────────────┤
│  EXECUTION (provider pattern):                         │
│   Binance (native) → Bybit (via Tradeway API) [fase 4] │
└─────────────────────────────────────────────────────────┘
```

**Prinsip:**
- **Satu URL, satu codebase, satu auth.** `quant.dev` redirect; `mini.dev` mati; `iq.heydewi.com` = satu-satunya produk.
- **No live-proxy antar sistem.** Detektor nulis ke Postgres (tabel `signals` sudah ada), frontend baca dari API MP. Kalau data belum ada → state kosong yang jujur, bukan proxy yang pura-pura.
- **Forecast engine di-port** ke MP (lib bersama) — chart forecast jadi komponen native, bukan fetch ke 8787.
- **Parquet → Postgres** sesuai rencana Dee: data mentah di parquet, data produk di Postgres, Zipline baca dari Postgres/parquet untuk backtest harian (loop 03:00/07:00 WIB).

---

## 8. Migration Plan (bertahap, tanpa big-bang)

| Fase | Durasi | Isi | Keluar |
|---|---|---|---|
| **F1 — Fondasi** | 1–2 hari | Redirect `quant.dev` → platform · matikan `mini.dev` · unify auth · port komponen chart/forecast + signal feed jadi native MP (design system MP, bukan vanilla) | Satu surface |
| **F2 — IA baru** | 2–4 hari | Bangun 5 domain mobile-first (Brief/Opportunities/Trade/Portfolio/Journal) di atas router MP existing; menu button TG → URL platform | Satu alur |
| **F3 — Ingestion** | 1–2 hari | Quant detectors → tulis ke Postgres MP (cron/worker); regime/scoreboard jadi tabel; history tersimpan; hapus proxy 8787 | Satu data |
| **F4 — Portfolio & provider** | 1–2 hari | Posisi jadi state portfolio (alerting terpadu); execution provider pattern (Binance native; Bybit via Tradeway API sebagai provider kedua) | Satu eksekusi |
| **F5 — Polish** | 2–3 hari | Design system penuh, empty states, onboarding, performance, pensiunkan artefak lama (/app kasar, dashboard server) | Satu produk |

**Aturan migrasi:**
- Setiap fase berakhir di state yang **live & bisa dipakai** (no broken window).
- Tidak ada fase yang memaksa ngoding ulang 3 app sekaligus.
- `quant.dev` redirect sejak F1 → pengguna nggak pernah kehilangan akses.
- Tradeway (Bybit) sengaja di-fase-4: keys-nya belum ada di infra, dan nilainya cuma sebagai provider kedua — bukan blocker produk.

---

## Lampiran: Yang TIDAK Berubah

- Pipeline validasi sinyal Quant (AGENTS.md notifier-bot) — ini aset paling berharga, **tetap** sebagai gerbang sebelum sinyal naik ke Opportunities. Tidak ada sinyal baru tanpa validasi.
- Loop backtest harian 03:00/07:00 WIB — tetap, sekarang output-nya nulis ke Postgres + dashboard hasil backtest di platform (bukan app terpisah).
- Kepemilikan kode: engine deteksi tetap di repo Quant; platform di repo market-pulse; Tradeway tetap bot — yang digabung adalah **produk**, bukan repo.
