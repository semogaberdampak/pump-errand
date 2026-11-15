# Panduan Deploy — Pameran di proyek Supabase POS

> **Ringkas:** satu file `supabase/schema.sql` dijalankan di **proyek Supabase aplikasi POS**.
> Semua tabel & fungsi pameran hidup di schema **`pameran`**, jadi tabel POS
> (`products`, `profiles`, `sales`, …) tidak disentuh. Login memakai **akun POS**
> (Supabase Auth); frontend memanggil satu pintu RPC `public.pameran_rpc_call`.

---

## 0. Prasyarat

- Proyek Supabase POS (mis. `koerpzbwkfejfrhervxa`) sudah berjalan dan memakai
  **Supabase Auth** — ada tabel `public.profiles`, `public.roles`, `public.branches`.
- File `schema.sql` akan **berhenti dengan pesan jelas** bila dijalankan di proyek
  yang tidak punya ketiga tabel itu, jadi tidak ada risiko salah proyek.

## 1. Pasang database & fungsi (sekali saja)

1. Buka proyek **POS** → **SQL Editor → New query**.
2. Tempel **seluruh isi** `supabase/schema.sql`, lalu **Run**.
3. Ulangi hanya bila file itu berubah (`create … if not exists` / `create or replace`).

Yang dibuat, semuanya di schema `pameran`:

| Tabel | Isi |
|---|---|
| `pameran.master_produk` | produk yang dijual di pameran (dulu sheet `Master`) |
| `pameran.produk_pameran` | produk yang dibawa per event/cabang/tanggal |
| `pameran.transaksi` + `pameran.transaksi_item` | penjualan pameran (header + item) |
| `pameran.log_aktivitas` | catatan login/aksi penting |

Dan satu objek di `public`: `public.pameran_rpc_call(action, payload)`.

Tidak perlu mengubah **Project Settings → API → Exposed schemas**, tidak perlu
memindahkan atau mengubah tabel POS, dan tidak ada tabel bernama sama di `public`.

## 2. Akun, peran, dan cabang

Tidak ada akun khusus pameran. Setiap pengguna memakai akun POS-nya:

- **email** → `auth.users.email`
- **nama** → `profiles.full_name`
- **cabang** → `profiles.branch_id` → `branches.name`
- **peran** → `profiles.role_id` → `roles.name`

Aturan yang dipakai aplikasi:

- Peran dianggap **ADMIN pameran** bila nama perannya mengandung `admin`, `owner`,
  `manajer`, `manager`, atau `supervisor`. Selain itu USER.
  Bila nama peran POS Anda lain, ubah satu pola di fungsi `pameran.f_peran_admin`
  (bagian awal `schema.sql`), lalu jalankan ulang file itu.
- USER **wajib** punya `branch_id`; tanpa cabang, login ditolak dengan pesan jelas.
- ADMIN tanpa cabang memakai label `Semua cabang` dan boleh memilih cabang lain.
- `profiles.is_active = false` → login ditolak (`Akun dinonaktifkan`).
- Tab **Admin** aplikasi pameran hanya menampilkan daftar pengguna POS (baca saja);
  pembuatan akun tetap di aplikasi POS.

## 3. Master produk

Sumber utama produk adalah tabel **`public.products` milik aplikasi POS**.
Saat kode/ISBN yang di-scan belum ada di `pameran.master_produk`, aplikasi
menyelaraskan produk dari `public.products` ke `pameran.master_produk` lalu
mencari lagi — jadi produk baru di POS **langsung bisa** dipakai di pameran
tanpa mengisi apa pun secara manual. Tabel POS hanya **dibaca**, tidak diubah.

Deteksi kolom otomatis (nama yang umum dipakai POS):

| Isi | Kolom yang dikenali (urutan prioritas) |
|---|---|
| kode | `code`, `kode`, `sku`, `product_code`, `barcode`, `isbn` |
| nama | `name`, `nama`, `nama_produk`, `product_name`, `title`, `judul` |
| harga | `price`, `harga`, `harga_jual`, `sell_price`, `sale_price`, `unit_price` |
| isbn (opsional) | `isbn`, `barcode`, `ean`, `kode_barcode` |

Bila produk POS memakai `is_active = false` atau `deleted_at` terisi, baris itu
tidak ditarik. Bila nama kolom POS Anda tidak ada di daftar, tambahkan ke
`pameran.f_sync_master_pos` lalu jalankan ulang `schema.sql`.

`pameran.master_produk` tetap bisa diisi manual untuk produk yang **tidak** ada
di POS (mis. hanya dijual saat pameran) — baris manual tidak pernah ditimpa:

```sql
insert into pameran.master_produk (kode, isbn, nama, harga) values
  ('BK-001', '9789792123456', 'Judul Buku Contoh', 75000);
```

- Scan/ketikan dicocokkan ke `kode` **atau** `isbn` (tanda hubung & huruf besar-kecil diabaikan).
- ISBN-10 dan ISBN-13 dianggap sama; nol di depan diabaikan.
- Pencarian judul maksimal 50 hasil.
- CSV dari Google Sheet diimpor lewat **Table Editor → schema `pameran` → master_produk**
  (petakan `produk_id→kode`, `isbn→isbn`, `nama_produk→nama`, `harga→harga`).

## 4. Konfigurasi frontend

`js/supabase.js` sudah berisi URL + anon key proyek POS:

```js
const SUPABASE_URL = 'https://koerpzbwkfejfrhervxa.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOi...'; // anon public / publishable key POS
```

- Kedua nilai **dikunci di kode**; tidak bisa diubah dari layar login, halaman Admin,
  atau parameter URL — mencegah login dibelokkan ke backend lain.
- Ganti keduanya bila pindah proyek, lalu naikkan `CACHE` di `sw.js`.

## 5. Deploy & cache

- Frontend statis (GitHub Pages/Netlify), tanpa build step.
- Service worker memakai strategi network-first; setelah mengubah file frontend,
  naikkan `CACHE` di `sw.js` (sekarang `pameran-v9`) lalu muat ulang.
- Pastikan `js/supabase.js` dan folder `vendor/` ikut ter-commit.

## 6. Menguji

1. Login dengan akun POS (email + sandi POS yang biasa dipakai).
2. Tab **Admin** → **Tes Koneksi** → `OK (… ms)` dan `{"pong": "…", "database": "supabase"}`.
3. **Seed Data Tes** → menambah baris `TEST-…` di `pameran.master_produk`.
4. Cek daftar **Pengguna POS** muncul (nama, cabang, peran hasil pemetaan).

## Sesi

- Login = Supabase Auth. Access token berlaku **1 jam** dan diperbarui otomatis
  (`/auth/v1/token?grant_type=refresh_token`) sebelum kedaluwarsa, jadi pengguna
  tidak dipaksa login ulang di tengah pameran.
- **Keluar otomatis setelah 1 jam tanpa aktivitas** tetap berlaku di aplikasi.
- Logout mencabut refresh token di Supabase (`/auth/v1/logout`) dan menghapus sesi
  lokal. Antrean sinkron di perangkat tidak dihapus; hanya akun pembuatnya yang
  mengirim antrean itu.
- Identitas selalu diambil dari JWT di server (`auth.uid()` → `profiles`); klien
  tidak pernah mengirim nama/cabang/peran, jadi tidak bisa mengaku akun lain.

## Troubleshooting

| Gejala | Penyebab | Solusi |
|---|---|---|
| `Tabel POS (public.profiles / public.roles / public.branches) tidak ada` saat Run | File dijalankan di proyek yang salah | Jalankan di proyek POS |
| `Fungsi pameran_rpc_call belum ada di Supabase` | `schema.sql` belum dijalankan | Langkah 1 |
| `Tidak ada koneksi ke server` | Offline / URL proyek salah | Cek jaringan & `js/supabase.js` |
| `Email atau kata sandi salah` | Akun POS memang tidak cocok | Uji login di aplikasi POS |
| `Akun ini tidak memiliki profil di aplikasi POS` | `auth.users` ada tapi `profiles` tidak | Buat profil di POS |
| `Akun belum ditetapkan ke cabang mana pun di POS` | `profiles.branch_id` kosong untuk USER | Isi cabang di POS |
| `Akun dinonaktifkan` | `profiles.is_active = false` | Aktifkan di POS |
| Halaman Admin tidak muncul padahal admin | Nama peran POS tidak cocok pola | Sesuaikan `pameran.f_peran_admin` |
| `Sesi kedaluwarsa, silakan login ulang` | Refresh token dicabut/kedaluwarsa | Login ulang |
| `Kode ... tidak ada di tabel master_produk maupun produk POS` | Kode tidak ada di `public.products` POS dan belum diisi manual | Langkah 3 |
| `⚠ N gagal sinkron` | Server menolak (format/produk/pemilik) | Ketuk lencana → baca alasan |
| Tampilan lama masih muncul | Cache service worker | Naikkan `CACHE` di `sw.js`, muat ulang |
