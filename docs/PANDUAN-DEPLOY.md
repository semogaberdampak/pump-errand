# Panduan Deploy — Backend Supabase (RBAC + Database)

> **Ringkas:** backend ada di satu file `supabase/schema.sql`. Setelah dijalankan di
> Supabase, frontend memanggil **satu fungsi RPC** (`public.rpc_call`) memakai
> *Project URL* + *anon/publishable key*. Tabel dikunci RLS, jadi kunci publik itu
> tidak bisa dipakai membaca data langsung.

---

## 0. Persiapan (sekali saja)

1. Buat proyek baru di [supabase.com](https://supabase.com) (paket gratis cukup).
   Catat **Project URL** (mis. `https://abcdefgh.supabase.co`).
2. Buka **Project Settings → API** dan salin:
   - **Project URL**
   - **anon public** (di dashboard baru namanya **publishable key**)
   > Kunci ini memang terlihat di browser. Yang melindungi data adalah RLS + pemeriksaan
   > sesi/peran di dalam fungsi SQL, bukan kerahasiaan kunci.

## 1. Pasang database & fungsi (sekali saja)

1. Buka **SQL Editor → New query**.
2. Tempel **seluruh isi** `supabase/schema.sql`, lalu **Run**.
3. Ulangi hanya bila file itu berubah. Semua perintah memakai
   `create table if not exists` / `create or replace function`, jadi data yang sudah
   ada **tidak** terhapus.

Yang dibuat:

| Tabel | Isi |
|---|---|
| `users` | akun `{email, nama, cabang, role, aktif, pass_hash}` (sandi bcrypt) |
| `sessions` | token sesi 6 jam |
| `login_rate` | pembatas 5x gagal sandi → kunci 15 menit |
| `master_produk` | sumber produk (dulu sheet `Master`) |
| `produk_pameran` | produk yang dibawa per event/cabang/tanggal |
| `transaksi` + `transaksi_item` | transaksi penjualan (header + item) |
| `log_aktivitas` | catatan login / hapus produk / pembatalan |

Fungsi yang bisa dipanggil aplikasi hanya `public.rpc_call(action, token, payload)`.

## 2. Buat admin pertama (sekali saja)

Di bagian paling bawah `supabase/schema.sql` ada contoh `insert` yang masih dikomentari.

1. Salin blok itu ke SQL Editor.
2. Ganti `email` dan sandi (min. 10 karakter), hapus tanda komentar, lalu **Run**.
3. Jangan simpan sandi sungguhan di file yang di-commit.
4. Login ke aplikasi, lalu buat akun cabang lain dari tab **Admin → Tambah Cabang / User**.

## 3. Isi master produk

Dulu sheet `Master` diisi manual. Sekarang isi tabel `master_produk` lewat
**Table Editor → master_produk → Insert row**, atau SQL:

```sql
insert into public.master_produk (kode, isbn, nama, harga) values
  ('BK-001', '9789792123456', 'Judul Buku Contoh', 75000);
```

- Scan/ketikan dicocokkan ke `kode` **atau** `isbn` (tanda hubung & huruf besar-kecil diabaikan).
- ISBN-10 dan ISBN-13 dianggap sama, nol di depan diabaikan.
- Pencarian judul menampilkan maksimal 50 hasil (judul yang diawali kata kunci di atas).

## 4. Pasang URL & kunci di frontend

Buka `js/supabase.js` dan isi dua konstanta di bagian atas:

```js
const SUPABASE_URL = 'https://abcdefgh.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOi...'; // anon public / publishable key
```

- Nilai ini **dikunci di kode**; tidak bisa diubah dari layar login, halaman Admin,
  atau parameter URL. Ini mencegah tautan palsu membelokkan login ke backend orang lain.
- Bila mengganti proyek Supabase, ubah kedua nilai itu lalu naikkan `CACHE` di `sw.js`.

## 5. Deploy & cache

- Frontend tetap statis (GitHub Pages, Netlify, dll). Tidak ada build step.
- File aplikasi diambil **network-first** oleh service worker; setelah mengubah
  `js/supabase.js` atau file frontend lain, naikkan `CACHE` di `sw.js`
  (sekarang `pameran-v7`) lalu muat ulang agar perangkat memakai versi baru.
- Pastikan semua file ikut ter-commit, termasuk `js/supabase.js` dan folder `vendor/`.

## 6. Menguji koneksi

Login sebagai Admin → tab **Admin**:
   - **Tes Koneksi** → muncul `OK (… ms)` dan `{"pong": "...", "database": "supabase"}`.
   - **Seed Data Tes** → menambah satu baris `TEST-…` di `master_produk`.

Bila gagal, lihat tabel Troubleshooting di bawah.

## Sesi, keluar otomatis & hak akses

- **Keluar otomatis setelah 1 jam tanpa aktivitas** di aplikasi (tetap seperti sebelumnya).
  Sesi server berlaku **6 jam**; setelah itu login ulang.
- Logout mencabut token di tabel `sessions` (bukan hanya di perangkat).
- Identitas & cabang **selalu diambil dari sesi** di dalam `rpc_call`; akun USER tidak
  bisa membaca/menulis data cabang lain. Hanya ADMIN yang bisa menyebut cabang lain.
- Login dikunci 15 menit setelah 5 kali gagal untuk email yang sama; pesan galat sama
  untuk email tak terdaftar dan sandi salah.
- Antrean sinkron di perangkat tidak dihapus saat logout; hanya akun pembuatnya yang
  mengirim antrean itu.

## Zona waktu

- Cap waktu disimpan sebagai `timestamptz` (UTC) dan ditampilkan aplikasi dalam
  **WIB (Asia/Jakarta)**, apa pun zona waktu perangkat.
- "Ping" menampilkan waktu WIB dari database.

## Migrasi data dari Google Sheet (opsional)

| Data lama | Cara pindah |
|---|---|
| `Master` | Ekspor CSV → **Table Editor → master_produk → Import data**. Petakan `produk_id→kode`, `isbn→isbn`, `nama_produk→nama`, `harga→harga`. |
| `produk_pameran_<tanggal>` | Ekspor CSV → impor ke `produk_pameran`; tambahkan kolom `tgl` (YYYY-MM-DD), `event`, `cabang`. |
| `transaksi_pameran_<tanggal>` | Struktur berubah (header + item). Paling aman: selesaikan pameran berjalan di sistem lama, mulai pameran baru di Supabase. |
| `Users` | Sandi lama memakai hash SHA-256; tidak bisa dipindahkan. Buat ulang akun dari tab Admin. |

## Troubleshooting

| Gejala | Penyebab umum | Solusi |
|---|---|---|
| `SUPABASE_URL di js/supabase.js belum diisi / tidak valid` | Konstanta masih placeholder | Isi URL proyek (lihat langkah 4) |
| `SUPABASE_ANON_KEY di js/supabase.js belum diisi` | Kunci masih placeholder | Isi anon/publishable key |
| `Fungsi rpc_call belum ada di Supabase` | `schema.sql` belum dijalankan | Jalankan langkah 1 |
| `Supabase menolak anon key` | Kunci salah / proyek lain | Salin ulang dari Project Settings → API |
| `Sesi kedaluwarsa, silakan login ulang` | Lewat 6 jam / token dicabut | Login ulang |
| `Terlalu banyak percobaan` | 5x salah sandi | Tunggu 15 menit |
| `Email atau kata sandi salah` padahal benar | Akun dibuat langsung di tabel tanpa bcrypt | Buat ulang lewat tab Admin |
| `Kode ... tidak ada di tabel master_produk` | Kode belum ada / salah | Tambahkan ke `master_produk` |
| `Produk sudah dipakai di transaksi aktif` | Ada transaksi aktif memakai produk itu | Batalkan transaksinya dulu |
| `⚠ N gagal sinkron` | Server menolak (format/produk/pemilik salah) | Ketuk lencana → baca alasan → *Coba lagi* / *Buang* |
| Kamera tidak terbuka | Izin kamera ditolak / bukan HTTPS | Izinkan kamera; pakai kolom ketik |
| Tampilan lama masih muncul | Cache service worker | Naikkan `CACHE` di `sw.js`, muat ulang |
| Proyek Supabase "paused" | Paket gratis tidak aktif lama | Buka dashboard Supabase → Restore project |
