# Panduan Deploy — Backend Google Apps Script (RBAC + Database Sheet)

> **Ringkas:** setiap habis mengubah kode `.gs`, lakukan **Deploy → Manage deployments → ✏️ → New version**. URL `/exec` tidak berubah. URL itu dikunci di `js/gas.js` (`PINNED_URL`), jadi tidak perlu ditempel di layar mana pun.

---

## 0. Persiapan (sekali saja)

1. Buat **Google Spreadsheet** baru, misal `DB Pameran`. **Jangan dibagikan** ke siapa pun — skrip berjalan sebagai pemilik, jadi hanya Anda yang perlu akses.
2. Buka **Extensions (Ekstensi) → Apps Script**.
3. Hapus isi `Code.gs`, lalu **paste seluruh isi** `gas/rbac-apps-script.gs`. Simpan (Ctrl+S).

## 1. Inisialisasi database & akun Admin (sekali saja)

Akun admin **dibuat oleh Anda sendiri** lewat fungsi `buatAdminPertama()`; tidak ada akun bawaan.

1. Pilih fungsi **`setup`** → **Run** (izinkan akses saat diminta). Membuat sheet `Users`, `MasterProduk` (lama, tidak dipakai lagi), `LogTes`.
2. Di editor Apps Script, buka `buatAdminPertama()` dan **ganti `email` dan `pass`** (sandi min. 10 karakter). Ubah hanya di editor Apps Script, **jangan di GitHub**.
3. Pilih **`buatAdminPertama`** → **Run**. Akun ADMIN masuk ke sheet `Users` (sandi disimpan sebagai hash + salt; sandi tidak dicetak ke log).
4. Kembalikan `pass` ke placeholder `GANTI_DENGAN_SANDI_KUAT` lalu simpan, agar sandi tidak tertinggal di kode.
5. Login ke aplikasi dengan email & sandi tadi. Akun cabang/user lain dibuat dari tab **Admin → Tambah User/Cabang**.

### Sheet `Master` (sumber produk) — diisi manual

Buat sheet bernama **`Master`** dengan baris 1 sebagai header, persis:

| produk_id | isbn | nama_produk | harga |
|---|---|---|---|

- Scan/ketikan dicocokkan ke `produk_id` **atau** `isbn` (tanda hubung & huruf besar-kecil diabaikan).
- Urutan kolom bebas, selama nama header sama. `isbn` boleh kosong.
- Pencocokan toleran: ISBN-10 dan ISBN-13 dianggap sama (barcode buku biasanya EAN-13), nol di depan diabaikan, dan baris tanpa `produk_id` tetap bisa dipakai lewat ISBN-nya.
- Pencarian judul menampilkan maksimal 50 hasil (judul yang diawali kata kunci di urutan atas) dan memberi tahu bila hasilnya lebih banyak.

### Sheet `transaksi_pameran_<tanggal>` — dibuat otomatis

Setiap transaksi dikirim ke sheet ini (satu baris per item). Kolom: `event | cabang | trxId | waktu | kasir | metode | kode | nama | harga | qty | diskonTipe | diskonNilai | diskonRp | subtotalItem | netItem | bayar | kembali | status | alasanBatal | dibatalkanOleh | waktuBatal | menggantikan | diperbarui`.

- `netItem` = total per item setelah diskon. Untuk menjumlah omzet: jumlahkan `netItem` pada baris `status = AKTIF`.
- `bayar` dan `kembali` hanya diisi pada baris pertama tiap transaksi (agar tidak terhitung ganda).
- Transaksi yang dibatalkan tetap ada dengan `status = BATAL`.

### Sheet `produk_pameran_<tanggal>` — dibuat otomatis

Saat sesi **Persiapan** menyimpan produk, backend membuat sheet `produk_pameran_YYYY-MM-DD` (tanggal mulai pameran) dengan kolom `event | cabang | kode | isbn | nama | harga | jumlah | user | diperbarui`. Satu sheet dipakai bersama oleh semua cabang; tiap baris menyimpan cabangnya dan hanya terbaca oleh cabang itu. Scan ulang produk yang sama **memperbarui** barisnya (tidak dobel).

## Sesi, keluar otomatis & hak akses

- **Keluar otomatis setelah 1 jam tanpa aktivitas** (ketuk, ketik, geser layar). Satu menit sebelumnya muncul peringatan "Masih di sini?" dengan hitung mundur; menyentuh layar atau menekan *Tetap masuk* membatalkannya. Bila HP dimatikan / tab ditutup lebih dari 1 jam, saat dibuka lagi langsung ke layar login dengan pesan penjelasan. Batasnya bisa diubah lewat konstanta `BATAS_IDLE_MS` di `js/app.js`.
- Saat keluar (otomatis maupun manual), token sesi **dicabut di server** juga, jadi tidak bisa dipakai lagi. Ini butuh backend versi terbaru (Deploy → New version). Tanpa itu, logout tetap jalan di aplikasi, tetapi token baru kedaluwarsa sendiri setelah 6 jam.
- Data pameran dan antrean sinkron **tidak dihapus** saat keluar. Antrean hanya dikirim oleh akun pembuatnya, jadi bila akun lain login di HP yang sama, transaksi akun sebelumnya menunggu sampai akun itu login lagi (tidak salah atribusi kasir/cabang).
- **Halaman terakhir dipulihkan** saat halaman dimuat ulang (mis. tetap di Pameran). Login baru selalu mulai dari Beranda. Halaman Admin hanya dipulihkan untuk Admin, dan halaman yang butuh pameran aktif kembali ke Beranda bila pamerannya sudah tidak ada.
- **Hapus pameran hanya untuk Admin** (tombolnya tidak tampil untuk akun User dan ditolak bila dipanggil langsung). Daftar pameran tersimpan di perangkat, jadi ini kontrol di aplikasi; data di Google Sheet tidak ikut terhapus.

## Zona waktu

Semua tampilan di aplikasi memakai **WIB (Asia/Jakarta)**, apa pun zona waktu HP. Semua cap waktu di sheet (`waktu`, `diperbarui`, `waktuBatal`, `dibuat`, log) ditulis sebagai teks `yyyy-MM-dd HH:mm:ss` WIB. Disarankan juga mengatur zona waktu proyek Apps Script ke Asia/Jakarta (Project Settings → Time zone).

## Pembaruan aplikasi & cache (service worker)

- File aplikasi (html/css/js) kini diambil **network-first**: setiap perubahan yang sudah di-push langsung terpakai saat online; cache hanya cadangan offline. Library di `vendor/` tetap cache-first.
- Bila tampilan terlihat "setengah baru" (mis. elemen tanpa gaya setelah update), muat ulang paksa sekali: Chrome → ⋮ → Info situs/Site settings → *Hapus data*, atau DevTools → Application → Service Workers → *Unregister* lalu muat ulang.
- Setelah mengganti file, pastikan **semua** file di zip ikut ter-commit, termasuk `js/sync.js`, `js/scanner.js`, dan folder `vendor/`.

## Sinkron & lebih dari satu perangkat

- Transaksi dan pembatalan **disimpan di perangkat lebih dulu** lalu dikirim lewat antrean, jadi kasir tetap bisa bekerja saat sinyal buruk. Antrean dikirim otomatis tiap 30 detik, saat koneksi kembali, saat login, dan saat tombol **Sinkron** ditekan. Lencana di halaman Pameran menunjukkan: `✓ Tersinkron`, `⏳ N menunggu kirim`, atau `⚠ N gagal sinkron` (ketuk untuk melihat alasan, *Coba lagi* atau *Buang*).
- Aman dikirim ulang: server memakai ID transaksi sebagai kunci, sehingga respons yang terputus tidak membuat transaksi dobel.
- Selama layar Pameran terbuka, data terbaru dari sheet ditarik tiap ±60 detik, sehingga **stok memperhitungkan penjualan HP lain**.
- **HP kedua:** login dengan akun cabang yang sama (boleh akun kasir lain), lalu buat pameran dengan **judul dan tanggal mulai yang sama** (huruf besar/kecil dan spasi ganda diabaikan). Produk dan transaksi cabang itu otomatis ikut.
- Data yang belum terkirim hilang bila data browser dihapus sebelum sempat tersinkron. Jaga agar lencana kembali `✓ Tersinkron` sebelum membersihkan data/mengganti HP.
- Transaksi uji dari versi sebelum fitur sinkron hanya ada di perangkat (lencana *Hanya di perangkat*) dan tidak dikirim ke sheet. Hapus pameran ujinya sebelum pameran sungguhan.

## Alur pemakaian

0. **Persiapan → Checklist:** centang item, lalu **Simpan Checklist**. Setelah tersimpan, kartu hanya menampilkan status **Persiapan OK** (waktu WIB, jumlah item). **Tampilkan** membuka daftar item yang sudah dicentang; **Koreksi** membuka kembali checklist untuk diubah, lalu **Simpan Koreksi** (tercatat sebagai revisi). Status checklist tersimpan di perangkat.

1. **Persiapan** → *Scan Produk* (atau ketik kode / ISBN / judul) → data ditarik dari sheet `Master` → modal berisi kode & nama (terkunci), **harga** dan **jumlah dibawa** → *Simpan* ke `produk_pameran_<tanggal>`.
2. **Pameran** → *Transaksi Baru* → **Scan Barcode / QR**: produk yang ditemukan tampil sebagai kartu di jendela baru → ketuk kartu untuk memilih → **Scan** (menambah jenis produk lain, kartu sebelumnya tetap) atau **Lanjut** (yang dipilih masuk keranjang; jumlah & diskon diatur di keranjang). Bisa juga ketik / cari produk (dicari hanya dari `produk_pameran_<tanggal>`) → isi **diskon per item** di tiap baris keranjang (% atau Rp) → subtotal, total diskon, total bayar & kembalian dihitung otomatis.
   - Rumus per baris: `harga × qty − diskon` (diskon % dibulatkan ke rupiah; diskon Rp berlaku untuk seluruh baris itu dan tidak boleh melebihi subtotal baris). Total = jumlah semua baris.
   - **Tunai:** isi *Uang diterima* (atau tekan *Uang pas*). Lebih dari total → muncul kembalian; kurang → tampil minus (mis. `Rp -2.000`) dan transaksi tidak bisa disimpan; uang pas atau lebih bisa dilanjutkan. Non-tunai (QRIS/Debit/Transfer) dianggap lunas sesuai total.
3. **Riwayat transaksi** → *Detail* → **Batalkan** (wajib alasan) atau **Koreksi**.
   - *Batalkan*: transaksi **tidak dihapus**, hanya ditandai BATAL (alasan, siapa, kapan). Stok produk otomatis kembali.
   - *Koreksi*: isi transaksi dimuat ke keranjang; saat disimpan, transaksi lama otomatis dibatalkan dan transaksi baru tertaut ke yang lama (kolom `menggantikan`).
   - Hanya pembuat transaksi atau Admin yang boleh membatalkan/mengoreksi.
   - Produk yang masih dipakai transaksi **aktif** tidak bisa dihapus dari daftar pameran; setelah transaksinya dibatalkan, bisa.
4. Kamera butuh **HTTPS** (GitHub Pages sudah HTTPS) dan izin kamera di browser. Kolom ketik tetap tersedia bila kamera tidak bisa dipakai; scanner hardware (keyboard) juga bisa: ketik kode lalu Enter di kolom cari.
5. Library scanner ada di `vendor/html5-qrcode.min.js` (Apache-2.0, versi 2.3.8) — ikut di-commit, tidak memakai CDN.

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
- Setiap habis mengubah file frontend, naikkan nama `CACHE` di `sw.js` supaya perangkat memuat versi baru (saat ini `pameran-v6`).

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
| `Sheet 'Master' tidak ditemukan` / `Header sheet 'Master' harus memuat...` | Sheet belum dibuat / nama header beda | Lihat bagian sheet `Master` |
| `Kode ... tidak ada di sheet Master` saat simpan | Kode dihapus dari Master setelah di-scan | Periksa sheet `Master` |
| Kamera tidak terbuka | Izin kamera ditolak / bukan HTTPS | Izinkan kamera; pakai kolom ketik sebagai cadangan |
| Produk tidak muncul di Pameran | Pameran / tanggal mulai / cabang berbeda dari saat Persiapan | Produk dipisah per judul pameran, tanggal mulai, dan cabang |
| `⚠ js/sync.js tidak termuat` | File `js/sync.js` belum ter-commit / gagal dimuat | Commit file itu lalu muat ulang. Transaksi yang dibuat selagi file hilang hanya tersimpan di perangkat |
| Scan / ketik produk: "Backend Apps Script belum versi terbaru" | Kode `.gs` belum di-deploy | Deploy → Manage deployments → ✏️ → New version → Deploy |
| Kode barcode tidak ditemukan | Kode yang terbaca tidak ada di `produk_id`/`isbn` sheet Master | Lihat kode yang tampil di jendela "Produk tidak ditemukan"; samakan isi sheet Master atau cari dengan judul |
| Keluar sendiri ke layar login | Tidak aktif ≥ 1 jam, atau sesi server berakhir | Login lagi; data & antrean tetap aman |
| Tombol Hapus pameran tidak ada | Akun bukan Admin | Gunakan akun Admin |
| `⚠ N gagal sinkron` | Server menolak (mis. produk/format tidak valid, bukan pembuat transaksi) | Ketuk lencana → baca alasan → *Coba lagi* / *Buang* |
| `Sesi habis — login ulang untuk sinkron` | Sesi 6 jam berakhir | Login lagi; antrean terkirim otomatis |
| `Produk sudah dipakai di transaksi aktif` | Ada transaksi aktif memakai produk itu (mungkin di HP lain) | Batalkan transaksinya dulu |
| Tampilan lama masih muncul | Cache service worker | Naikkan `CACHE` di `sw.js`, muat ulang |
