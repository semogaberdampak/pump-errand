# Panduan Deploy — Backend Supabase (RBAC + Database)

> **Ringkas:** backend ada di satu file `supabase/schema.sql`. Setelah dijalankan di
> Supabase, frontend memanggil **satu fungsi RPC** (`public.pameran_rpc_call`) memakai
> *Project URL* + *anon/publishable key*. Semua tabel & fungsi internal hidup di schema
> **`pameran`**, jadi aman dipasang di proyek yang sudah dipakai aplikasi lain. Tabel
> dikunci RLS, sehingga kunci publik itu tidak bisa dipakai membaca data langsung.

---

## 0. Proyek Supabase: baru atau yang sudah ada?

Keduanya bisa. Skrip ini **tidak membuat objek apa pun di schema `public`** selain satu
fungsi pintu: `public.pameran_rpc_call(...)`. Nama yang rawan bentrok (`users`,
`transaksi`, `sessions`, dst.) berada di `pameran.*`, sehingga tidak menimpa atau
mengganggu tabel aplikasi lain di proyek yang sama.

Catat **Project URL** (mis. `https://abcdefgh.supabase.co`) dan **anon public**
(di dashboard baru: **publishable key**) dari **Project Settings → API**.

> Kunci ini memang terlihat di browser. Yang melindungi data adalah RLS + pemeriksaan
> sesi/peran di dalam fungsi SQL, bukan kerahasiaan kunci.

## 1. Pasang database & fungsi (sekali saja)

1. Buka **SQL Editor → New query**.
2. Tempel **seluruh isi** `supabase/schema.sql`, lalu **Run**.
3. Ulangi hanya bila file itu berubah. Semua perintah memakai
   `create schema/table if not exists` / `create or replace function`, jadi data yang
   sudah ada **tidak** terhapus.

Tidak perlu mengubah **Project Settings → API → Exposed schemas**. Cukup `public`
(seperti bawaan), karena aplikasi hanya memanggil pembungkus di `public`.

Yang dibuat (semua di schema `pameran`):

| Tabel | Isi |
|---|---|
| `pameran.users` | akun `{email, nama, cabang, role, aktif, pass_hash}` (sandi bcrypt) |
| `pameran.sessions` | token sesi 6 jam |
| `pameran.login_rate` | pembatas 5x gagal sandi → kunci 15 menit |
| `pameran.master_produk` | sumber produk (dulu sheet `Master`) |
| `pameran.produk_pameran` | produk yang dibawa per event/cabang/tanggal |
| `pameran.transaksi` + `pameran.transaksi_item` | transaksi penjualan (header + item) |
| `pameran.log_aktivitas` | catatan login / hapus produk / pembatalan |

Fungsi yang bisa dipanggil aplikasi hanya `public.pameran_rpc_call(action, token, payload)`,
yang meneruskan ke `pameran.rpc_call(...)`. Anon key tidak punya `USAGE` pada schema
`pameran`, jadi fungsi internal tidak bisa dipanggil langsung dari browser.

### Bila versi lama sudah pernah dijalankan di proyek ini

Versi pertama skrip ini menaruh semuanya di `public` (fungsi `public.rpc_call`).
Urutan pindah yang aman:

1. Jalankan `supabase/schema.sql` (membuat schema `pameran` + `public.pameran_rpc_call`).
2. Jalankan `supabase/pindah-ke-schema-pameran.sql` — menyalin `public.users` dan
   `public.master_produk` ke schema baru. Skrip ini **tidak menghapus apa pun** dan
   melewati tabel yang bentuknya bukan milik aplikasi pameran. Sandi ikut pindah
   karena sama-sama bcrypt, jadi pengguna lama tetap bisa login.
3. Deploy frontend versi baru (`pameran-v8`); pastikan login & simpan transaksi jalan.
4. Baru bersihkan objek lama: buka blok komentar di bagian bawah
   `pindah-ke-schema-pameran.sql`, cek isinya, lalu hapus objek yang memang milik
   aplikasi pameran. Jangan hapus tabel yang dipakai aplikasi lain.

Selama langkah 4 belum dijalankan, `public.rpc_call` lama masih ada dan tidak
mengganggu; yang dipakai frontend baru adalah `public.pameran_rpc_call`.

## 2. Buat admin pertama (sekali saja)

Di bagian paling bawah `supabase/schema.sql` ada contoh `insert` yang masih dikomentari.

1. Salin blok itu ke SQL Editor.
2. Ganti `email` dan sandi (min. 10 karakter), hapus tanda komentar, lalu **Run**.
3. Jangan simpan sandi sungguhan di file yang di-commit.
4. Login ke aplikasi, lalu buat akun cabang lain dari tab **Admin → Tambah Cabang / User**.

## 3. Isi master produk

Dulu sheet `Master` diisi manual. Sekarang isi `pameran.master_produk` lewat SQL Editor
(Table Editor juga bisa, pilih schema `pameran`):

```sql
insert into pameran.master_produk (kode, isbn, nama, harga) values
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
  (sekarang `pameran-v8`) lalu muat ulang agar perangkat memakai versi baru.
- Pastikan semua file ikut ter-commit, termasuk `js/supabase.js` dan folder `vendor/`.

## 6. Menguji koneksi

Login sebagai Admin → tab **Admin**:
   - **Tes Koneksi** → muncul `OK (… ms)` dan `{"pong": "...", "database": "supabase"}`.
   - **Seed Data Tes** → menambah satu baris `TEST-…` di `pameran.master_produk`.

Bila gagal, lihat tabel Troubleshooting di bawah.

## Berbagi tabel dengan aplikasi lain (opsional)

Karena datanya sudah di schema sendiri, aplikasi lain bisa membaca tabel yang sama
tanpa mengubah skrip ini:

```sql
-- role milik aplikasi lain (atau pakai service role di server aplikasi itu)
grant usage on schema pameran to app_lain;
grant select on all tables in schema pameran to app_lain;
```

- Hanya **baca**: tidak ada policy tulis dan tidak ada `insert/update/delete` yang
  diberikan, jadi aplikasi lain tidak bisa merusak data pameran.
- Bila aplikasi lain perlu menulis, tambahkan policy RLS yang sempit untuk role itu —
  jangan membuka `anon`/`authenticated`.
- Jangan memberi `authenticated` akses ke `pameran.users` (berisi hash sandi).

## Sesi, keluar otomatis & hak akses

- **Keluar otomatis setelah 1 jam tanpa aktivitas** di aplikasi (tetap seperti sebelumnya).
  Sesi server berlaku **6 jam**; setelah itu login ulang.
- Logout mencabut token di tabel `pameran.sessions` (bukan hanya di perangkat).
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
| `Master` | Ekspor CSV → impor ke `pameran.master_produk`. Petakan `produk_id→kode`, `isbn→isbn`, `nama_produk→nama`, `harga→harga`. |
| `produk_pameran_<tanggal>` | Ekspor CSV → impor ke `pameran.produk_pameran`; tambahkan kolom `tgl` (YYYY-MM-DD), `event`, `cabang`. |
| `transaksi_pameran_<tanggal>` | Struktur berubah (header + item). Paling aman: selesaikan pameran berjalan di sistem lama, mulai pameran baru di Supabase. |
| `Users` | Sandi lama memakai hash SHA-256; tidak bisa dipindahkan. Buat ulang akun dari tab Admin. |

## Troubleshooting

| Gejala | Penyebab umum | Solusi |
|---|---|---|
| `SUPABASE_URL di js/supabase.js belum diisi / tidak valid` | Konstanta masih placeholder | Isi URL proyek (lihat langkah 4) |
| `SUPABASE_ANON_KEY di js/supabase.js belum diisi` | Kunci masih placeholder | Isi anon/publishable key |
| `Fungsi pameran_rpc_call belum ada di Supabase` | `schema.sql` belum dijalankan (atau baru dijalankan versi lama) | Jalankan langkah 1 |
| `permission denied` / `Sesi kedaluwarsa` padahal baru saja menjalankan skrip lama | Proyek masih memakai `public.rpc_call` versi pertama | Jalankan `supabase/schema.sql` terbaru |
| `permission denied for schema pameran` | Skrip versi lama/terpotong; pembungkus hilang | Jalankan ulang bagian pembungkus + blok keamanan di akhir `schema.sql` |
| `Supabase menolak anon key` | Kunci salah / proyek lain | Salin ulang dari Project Settings → API |
| `Sesi kedaluwarsa, silakan login ulang` | Lewat 6 jam / token dicabut | Login ulang |
| `Terlalu banyak percobaan` | 5x salah sandi | Tunggu 15 menit |
| `Email atau kata sandi salah` padahal benar | Akun dibuat langsung di tabel tanpa bcrypt | Buat ulang lewat tab Admin |
| `Kode ... tidak ada di tabel master_produk` | Kode belum ada / salah | Tambahkan ke `pameran.master_produk` |
| `Produk sudah dipakai di transaksi aktif` | Ada transaksi aktif memakai produk itu | Batalkan transaksinya dulu |
| `⚠ N gagal sinkron` | Server menolak (format/produk/pemilik salah) | Ketuk lencana → baca alasan → *Coba lagi* / *Buang* |
| Kamera tidak terbuka | Izin kamera ditolak / bukan HTTPS | Izinkan kamera; pakai kolom ketik |
| Tampilan lama masih muncul | Cache service worker | Naikkan `CACHE` di `sw.js`, muat ulang |
| Proyek Supabase "paused" | Paket gratis tidak aktif lama | Buka dashboard Supabase → Restore project |
