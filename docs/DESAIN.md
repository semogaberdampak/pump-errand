# Pencatatan Pameran — Catatan Desain

Aplikasi web ringan (frontend statis + Supabase, cache localStorage) untuk pencatatan saat pameran,
mengikuti **konsep layout ScanStock** (`index-scanstock.html`): layar penuh (`.screen`),
bottom bar sticky, palet & token yang sama, dark mode via `data-theme`.

## Struktur File

```
index.html        → halaman utama aplikasi (PWA, entry point) (4 screen: home + 3 sesi)
css/tokens.css    → variabel desain (:root, dark) disalin dari index-scanstock.html (ScanStock) + base body
css/pameran.css   → layout & komponen khusus aplikasi pameran
js/store.js       → lapisan data localStorage, ternormalisasi per event
js/supabase.js    → klien Supabase (login/RBAC + baca/tulis data lewat RPC)
supabase/schema.sql → skema database + fungsi RPC (jalankan sekali di SQL Editor)
js/app.js         → bootstrap: tunggu penyimpanan siap, pulihkan sesi, shortcut, sinkron otomatis
js/app/core.js    → state bersama (App.state), utilitas, modal, navigasi layar, tema
js/app/audio.js   → bunyi + getar umpan balik scan (Web Audio, tanpa berkas audio)
js/app/auth.js    → login/logout, RBAC, pemulihan sesi, keluar otomatis 1 jam
js/app/home.js    → beranda: daftar/buat/buka/selesai/hapus pameran
js/app/persiapan.js → sesi 1: checklist + produk yang dibawa
js/app/pameran.js → sesi 2: cari, keranjang, diskon, bayar, riwayat, scan (kamera & scan gun)
js/app/penginputan.js → sesi 3: input manual, rekap, unduh CSV
js/app/admin.js   → halaman Admin (status koneksi, uji DB, daftar pengguna)
docs/DESAIN.md    → dokumen ini
```

## Alur 3 Sesi

### 1. Persiapan (`scr-persiapan`)
- Checklist persiapan booth (item standar + tambah/hapus/centang, progress bar).
- Pencatatan **stok awal** per produk → dasar perhitungan rekap.
- Kelola master produk (modal "+ Produk").

### 2. pameran (`scr-pameran`)
- Pencarian produk cepat (nama/kode, debounce; shortcut `/`).
- Keranjang multi-item + qty stepper + catatan diskon per item.
- Pembayaran Tunai/QRIS/Debit/Transfer, kembalian otomatis.
- Statistik harian (jumlah transaksi, pcs, omzet) + riwayat + soft-delete.

### 3. Penginputan (`scr-penginputan`)
- Input manual jumlah (pcs) per produk & kategori — meniru alur input ScanStock
  (KANISIUS / NON_KANISIUS / EKSTERNAL).
- Daftar input + soft-delete.
- **Rekap akhir**: `sisa estimasi = stok awal − terjual + input manual`,
  tabel modal + ekspor CSV (rekap & transaksi).

## Model Data (localStorage)

| Kunci | Isi |
|---|---|
| `pameran.events` | daftar event `{id, nama, tanggal, catatan, dibuat, selesai}` |
| `pameran.active` | id event yang sedang dibuka |
| `pameran.products` | cache master produk `{kode, nama, kategori, harga}` |
| `pameran.<id>.stokawal` | map kode→qty |
| `pameran.<id>.cek` | array `{teks, done}` |
| `pameran.<id>.transaksi` | array trx `{id, waktu, metode, total, items[], deleted}` |
| `pameran.<id>.inputan` | array input `{id, waktu, kode, qty, kategori, catatan, deleted}` |
| `pameran.theme` | `light`/`dark` |

Beberapa pameran dapat berjalan paralel; semuanya terisolasi per event id.

## Keputusan Desain
- Tanpa framework, tanpa build step — konsisten dengan proyek induk (file statis).
- Semua penghapusan bersifat soft-delete agar audit trail terjaga (kecuali hapus event).
- Target mobile-first: kontrol ≥44px, safe-area, max-width 540px.
- Umpan balik scan tanpa perlu melihat layar: bunyi Web Audio (OK / melebihi stok / kode tidak dikenal) + getar. Tidak ada berkas audio, jadi tetap bekerja offline; di iOS bunyi ikut sakelar senyap.
- Kode UI dipecah per sesi di `js/app/`: satu objek `App` berisi state bersama, setiap modul menempelkan fungsinya ke `App` dan tetap mengekspos handler ke `window` untuk atribut `onclick` di HTML. Urutan `<script>` di `index.html` penting: `core` paling awal, `app.js` (bootstrap) paling akhir.

## Pengembangan Lanjutan (ide)
- Data server: Supabase (Postgres + RPC) — lihat `supabase/schema.sql`.
- Scanner QR/barcode produk memakai `vendor/html5-qrcode.min.js` yang sudah dipakai induk.
- Multi-user (kasir vs verifikator) mengikuti pola peran pada index.html.
- PWA: manifest + service worker offline.

---

📌 **Panduan deploy backend (Supabase) tersedia di [`PANDUAN-DEPLOY.md`](PANDUAN-DEPLOY.md).**
