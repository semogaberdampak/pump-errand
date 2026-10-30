# Panduan Deploy — Backend Google Apps Script (RBAC + Database Sheet)

> **Ringkas:** setiap habis mengubah kode `.gs`, lakukan **Deploy → Manage deployments → ✏️ → New version**. URL `/exec` tidak berubah. URL itu dikunci di `js/gas.js` (`PINNED_URL`), jadi tidak perlu ditempel di layar mana pun.

---

## 0. Persiapan (sekali saja)

1. Buat **Google Spreadsheet** baru, misal `DB Pameran`. **Jangan dibagikan** ke siapa pun — skrip berjalan sebagai pemilik, jadi hanya Anda yang perlu akses.
2. Buka **Extensions (Ekstensi) → Apps Script**.
3. Hapus isi `Code.gs`, lalu **paste seluruh isi** `gas/rbac-apps-script.gs`. Simpan (Ctrl+S).

## 1. Inisialisasi database & akun Admin (sekali saja)

Akun admin **dibuat oleh Anda sendiri** lewat fungsi `buatAdminPertama()`; tidak ada akun bawaan.

1. Pilih fungsi **`setup`** → **Run** (izinkan akses saat diminta). Membuat sheet `Users`, `MasterProduk`, `LogTes`.
2. Di editor Apps Script, buka `buatAdminPertama()` dan **ganti `email` dan `pass`** (sandi min. 10 karakter). Ubah hanya di editor Apps Script, **jangan di GitHub**.
3. Pilih **`buatAdminPertama`** → **Run**. Akun ADMIN masuk ke sheet `Users` (sandi disimpan sebagai hash + salt; sandi tidak dicetak ke log).
4. Kembalikan `pass` ke placeholder `GANTI_DENGAN_SANDI_KUAT` lalu simpan, agar sandi tidak tertinggal di kode.
5. Login ke aplikasi dengan email & sandi tadi. Akun cabang/user lain dibuat dari tab **Admin → Tambah User/Cabang**.

Isi master produk di sheet `MasterProduk` (kolom: `kode | nama | kategori | harga`). Kategori: `KANISIUS / NON_KANISIUS / EKSTERNAL`.

## 2. Deploy sebagai Web App

**Pertama kali:** **Deploy → New deployment → Web app**
- **Execute as:** `Me`
- **Who has access:** `Anyone` (diperlukan agar PWA bisa memanggil tanpa login Google; keamanan ditangani login aplikasi di sisi server)
- Salin URL berakhiran **`/exec`**.

**Setiap kali kode `.gs` berubah ⚠️:** perubahan di editor tidak otomatis berlaku. **Deploy → Manage deployments → ✏️ → Version: New version → Deploy.** URL tidak berubah.

## 3. Pasang URL di aplikasi (frontend)

Satu cara saja: buka `js/gas.js`, isi konstanta **`PINNED_URL`** dengan URL `/exec`, lalu simpan/commit.

```js
const PINNED_URL = 'https://script.google.com/macros/s/XXXX/exec';
```

- URL **tidak bisa** diubah dari layar login, halaman Admin, maupun parameter `?gas=`. Ini disengaja: mencegah tautan palsu membelokkan login ke backend orang lain.
- URL `/exec` bukan rahasia (terlihat di browser). Yang melindungi data adalah login, sesi, dan otorisasi per cabang di `rbac-apps-script.gs`.
- Bila membuat **deployment baru** (URL baru): ganti `PINNED_URL`, naikkan `CACHE` di `sw.js` (mis. `pameran-v4`), lalu **Archive** deployment lama di *Manage deployments* agar URL lama mati.
- Setiap habis mengubah file frontend, naikkan nama `CACHE` di `sw.js` supaya perangkat memuat versi baru.

## 4. Menguji koneksi

Login sebagai Admin → tab **Admin**:
- **Tes Koneksi (Ping)** → harus muncul `{ok:true,...}`.
- **Seed Data Tes** → menulis baris uji ke `MasterProduk`; cek langsung di spreadsheet.

## 5. Keamanan yang sudah berlaku di backend

- Sesi disimpan di `CacheService` (berlaku 6 jam, lalu login ulang).
- Cabang dan nama user selalu diambil dari sesi; user biasa tidak bisa membaca/menulis data cabang lain. Hanya ADMIN yang bisa menyebut cabang lain.
- Login dikunci 15 menit setelah 5 kali gagal untuk email yang sama (pesan galat sama untuk email tak terdaftar dan sandi salah).
- Hanya `POST` yang dilayani; `GET` ditolak agar token/sandi tidak tercatat di URL.

## 6. Troubleshooting

| Gejala | Penyebab umum | Solusi |
|---|---|---|
| `Respons bukan JSON (cek deploy /exec)` | Belum deploy versi baru / URL bukan `/exec` | Ulangi langkah 2, pastikan `PINNED_URL` berakhiran `/exec` |
| `PINNED_URL di js/gas.js belum diisi / tidak valid` | Format URL salah | Salin ulang URL dari *Manage deployments* |
| `Access denied` / redirect login Google | "Who has access" bukan `Anyone` | Ubah setelan deployment |
| `Sesi kedaluwarsa` | Lewat 6 jam / token tidak valid | Login ulang |
| `Terlalu banyak percobaan` | 5x salah sandi | Tunggu 15 menit |
| `Email atau kata sandi salah` padahal benar | User diketik manual di sheet tanpa hash+salt | Buat user lewat tab Admin |
| `Ganti dulu nilai pass...` | Placeholder belum diganti | Lihat langkah 1 |
| Tampilan lama masih muncul | Cache service worker | Naikkan `CACHE` di `sw.js`, muat ulang |
