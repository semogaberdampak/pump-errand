# Panduan Deploy — Backend Google Apps Script (RBAC + Database Sheet)

> Pertanyaan umum: *"Apakah harus meng-update properti skrip setiap kali mengubah kode?"*
> **Jawaban singkat:** Tidak ada "properti" khusus yang perlu diubah. Yang harus Anda lakukan adalah **Deploy ulang** dan menempelkan URL hasil deploy ke aplikasi web. Detail di bawah.

---

## 0. Persiapan (sekali saja)

1. Buat **Google Spreadsheet** baru, misal namanya `DB Pameran`.
2. Buka spreadsheet → menu **Extensions (Ekstensi) → Apps Script**.
3. Di editor Apps Script, hapus isi `Code.gs`, lalu **paste seluruh isi file** `gas/rbac-apps-script.gs` dari repo ini.
4. Simpan (Ctrl+S).

## 1. Inisialisasi database & akun Admin (sekali saja)

Di editor Apps Script:

1. Pilih fungsi **`setup`** pada dropdown fungsi, klik **Run**.
   - Izinkan akses (Authorize) saat diminta.
   - Fungsi ini membuat sheet: `Users`, `MasterProduk`, `LogTes`.
   - ⚠️ Jika muncul error **"SPREADSHEET_ID belum diatur"**, berarti script Anda berjalan **standalone** (dibuat dari *New → Google Apps Script*, bukan dari dalam spreadsheet). Solusi (pilih salah satu):
     - **Cara A (disarankan):** buat script dari dalam spreadsheet — buka Spreadsheet → **Extensions → Apps Script** → paste kode. Dengan begitu `getActiveSpreadsheet()` otomatis menunjuk spreadsheet yang benar dan variabel ID tidak perlu diisi.
     - **Cara B:** salin **ID spreadsheet** dari URL (`https://docs.google.com/spreadsheets/d/`**`ID_INI`**`/edit`), lalu isi di baris `var SPREADSHEET_ID = '';` paling atas kode → simpan → jalankan `setup` lagi.
     - **Cara C:** jalankan sekali fungsi `setSpreadsheetId("ID_INI")` (ID tersimpan permanen di *Script Properties*: Project settings → Script properties → Copy value), lalu jalankan `setup`.
2. Pilih fungsi **`buatAdminPertama`**, klik **Run**.
   - Email & password admin default muncul di **Execution log / View log**.
   - Kredensial bawaan di dalam fungsi `buatAdminPertama()` (lihat `gas/rbac-apps-script.gs` baris ±266):
     - Email: `admin@pameran.id`
     - Password: `GantiSandi123` ← **ubah dulu nilainya di kode sebelum menjalankan**, lalu deploy.
   - Setelah login pertama, segera ganti user/password tersebut lewat tab Admin.

> Ini menjawab pertanyaan "bagaimana mengetahui akun admin": jalankan `buatAdminPertama()` sekali, catat kredensial dari log. Setelah itu Admin bisa membuat user/cabang lain langsung dari aplikasi (tab **Admin → Tambah User/Cabang**) — jumlahnya tidak dipatok di awal.

Isi master produk secukupnya di sheet `MasterProduk` (kolom: `kode | judul | kategori | harga`). Kategori: `KANISIUS / NON_KANISIUS / EKSTERNAL`.

## 2. Deploy sebagai Web App (setiap kali kode berubah ⚠️)

Ini langkah yang sering terlewat: **perubahan kode di editor TIDAK otomatis berlaku di URL `/exec`**. Setiap habis mengedit `.gs`:

1. Klik **Deploy → Manage deployments**.
2. Pada deployment Web App, klik ikon pensil (✏️) → **Version: New version** → **Deploy**.
3. Salin URL baru yang berakhiran **`/exec`**.

Alternatif: **Deploy → New deployment → Web app**, dengan setelan:
- **Execute as:** `Me` (pemilik spreadsheet)
- **Who has access:** `Anyone` *(atau "Anyone with Google account" bila ingin lebih ketat)*

> Tips: URL `/exec` tetap sama antar versi; yang berubah hanyalah *versi kode* yang dilayani. Jadi cukup sekali tempel URL-nya, tetapi **jangan lupa "New version"** tiap habis edit kode.

## 3. Tempel URL ke Aplikasi Web (frontend)

Ada tiga cara, pilih salah satu:

| Cara | Kapan dipakai |
|---|---|
| **A. Kolom "URL Web App (/exec)"** di layar Login (panel pengaturan koneksi), atau di tab **Admin** dalam aplikasi | Paling fleksibel; tersimpan di localStorage perangkat. |
| **B. Parameter URL halaman**: `https://…/index.html?gas=https://script.google.com/macros/s/XXXX/exec` | Praktis untuk membagikan ke banyak perangkat sekaligus — sekali buka, URL tersimpan otomatis. |
| **C. Hardcode** di `js/gas.js` baris `const DEFAULT_URL = '…';` | Bila URL ingin permanen menempel di kode frontend. |

## 4. Menguji koneksi (Sheet Tes)

Setelah login sebagai Admin, buka tab **Admin**:
- Tekan **Ping** → harus muncul respons `{ok:true,...}`.
- Tekan **Seed Data Tes** → backend menulis baris uji ke sheet **`LogTes`**; hasilnya tampil di panel log.
- Buka spreadsheet → sheet `LogTes` untuk memastikan data benar-benar tertulis.

## 5. Ringkas Alur Pembaruan ("apakah harus update properti?")

```
Edit gas/rbac-apps-script.gs di editor Apps Script
        │
        ▼
Deploy → Manage deployments → ✏️ → New version → Deploy   ← WAJIB tiap perubahan kode
        │
        ▼
(URL /exec tidak berubah — frontend tidak perlu disentuh)
```

Yang **tidak** perlu diubah: menu **"Project Properties"** maupun *script properties* — skrip ini tidak menyimpan konfigurasi di sana. Konfigurasi (kredensial admin awal dsb.) berupa variabel biasa di dalam `rbac-apps-script.gs`; cukup edit kodenya → simpan → deploy versi baru (langkah 2).

## 6. Troubleshooting

| Gejala | Penyebab umum | Solusi |
|---|---|---|
| Respons HTML alih-alih JSON (`Respons bukan JSON (cek deploy /exec)`) | Belum deploy versi baru / URL bukan `/exec` | Ulangi langkah 2, pastikan URL berakhiran `/exec` |
| `Access denied` / redirect login Google | "Who has access" bukan `Anyone` | Ubah setelan deployment |
| Data tidak masuk sheet | Nama sheet event bentrok / spreadsheet salah | Cek `LogTes`, pastikan `SPREADSHEET_ID` (variabel di bagian atas skrip, atau jalankan `setSpreadsheetId("ID")` sekali — tersimpan di Script Properties) menunjuk spreadsheet yang benar — secara default skrip memakai spreadsheet tempat ia di-bound |
| Login gagal padahal user benar | Password di-hash SHA-256+salt; user dibuat manual di sheet tanpa salt | Buat user lewat tab Admin, bukan ketik manual di sheet |
