/* ============================================================
   rbac-apps-script.gs — Backend Google Apps Script
   (paste di Extensions → Apps Script pada spreadsheet Anda,
    lalu Deploy → New deployment → Web app,
    Execute as: Me, Who has access: Anyone)
   Keamanan: sesi di CacheService, cabang/user dari sesi, login dibatasi 5x gagal/15 menit.

   STRUKTUR SPREADSHEET (dibuat otomatis oleh setup()):
     Users        : email | nama | cabang | passHash | salt | role | aktif | dibuat
     MasterProduk : kode | judul/nama | kategori (KANISIUS/NON_KANISIUS/EKSTERNAL) | harga
     Sheet data per pameran, nama = <JudulEvent>_<Tanggal>_<Cabang>:
        ..._Prep      : waktu | kode | judul | jumlah | kategori | sumber(scan/manual) | user
        ..._Transaksi : noTransaksi | tanggal | kode | judul | jumlah | diskon | metode | nominalBayar | user | tutup
        ..._Inputan   : waktu | kode | judul | jumlah | user
        ..._Rekap     : key | value (totalPenjualan fix, potongan1, potongan2, nilaiFinal)
     LogTes       : waktu | fungsi | hasil  (sheet tes untuk Admin)
   ============================================================ */

var SESI_DETIK_ = 21600;        // masa sesi; batas maksimum CacheService = 6 jam
var LOGIN_MAKS_GAGAL_ = 5;      // gagal berturut-turut per email
var LOGIN_KUNCI_DETIK_ = 900;   // dikunci 15 menit

// GET tidak dipakai (token/sandi bisa tercatat di URL). Semua aksi lewat POST.
function doGet() { return json_({ ok: false, error: 'Gunakan POST' }); }
function doPost(e) { return handle_(e); }

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// Klien mengirim body text/plain berisi "a=1&b=2". Apps Script hanya mengisi
// e.parameter untuk form-urlencoded, jadi body diurai sendiri sebagai pengaman.
function param_(e) {
  var p = {}, k;
  for (k in (e.parameter || {})) p[k] = e.parameter[k];
  var raw = e.postData && e.postData.contents;
  if (raw && !p.action) {
    raw.split('&').forEach(function (kv) {
      var i = kv.indexOf('=');
      if (i < 0) return;
      p[decodeURIComponent(kv.slice(0, i).replace(/\+/g, ' '))] =
        decodeURIComponent(kv.slice(i + 1).replace(/\+/g, ' '));
    });
  }
  return p;
}

function handle_(e) {
  var out;
  try {
    var q = param_(e);
    var data = route_(q.action || '', JSON.parse(q.payload || '{}'), q.token || '');
    out = { ok: true, data: data };
  } catch (err) {
    out = { ok: false, error: String(err && err.message || err), code: (err && err.code) || '' };
  }
  return json_(out);
}

var AKSI_ADMIN_ = ['listUsers', 'addUser', 'deleteUser', 'test', 'clearLog'];

function route_(action, p, token) {
  if (action === 'login') return login_(p.email, p.pass);
  var s = requireLogin_(token);
  if (AKSI_ADMIN_.indexOf(action) >= 0 && s.role !== 'ADMIN') throw new Error('Halaman khusus Admin');
  p = paksaIdentitas_(p, s);
  switch (action) {
    case 'listUsers': return listUsers_();
    case 'addUser': return addUser_(p);
    case 'deleteUser': return deleteUser_(p.email);
    case 'test': return runTest_(p.name);
    case 'clearLog': return clearLog_();
    case 'getMasterProduk': return getMasterProduk_();
    case 'savePrepScan': return savePrepScan_(p);
    case 'getPrepScans': return getPrepScans_(p);
    case 'saveTransaksi': return saveTransaksi_(p);
    case 'getTransaksiList': return getTransaksiList_(p);
    case 'tutupSetoran': return tutupSetoran_(p);
    case 'saveInputan': return saveInputan_(p);
    case 'saveRekap': return saveRekap_(p);
    default: throw new Error('Aksi tidak dikenal: ' + action);
  }
}

// Identitas & cabang SELALU dari sesi server, bukan dari kiriman klien.
// Hanya ADMIN yang boleh menyebut cabang lain.
function paksaIdentitas_(p, s) {
  p = p || {};
  p.user = s.email;
  if (s.role !== 'ADMIN' || !p.cabang) p.cabang = s.cabang;
  return p;
}

/* ---------------- Util sheet ---------------- */
function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }

function sheetAturan_(nama, header) {
  var sh = ss_().getSheetByName(nama);
  if (!sh) sh = ss_().insertSheet(nama);
  if (sh.getLastRow() === 0) {
    sh.appendRow(header);
    sh.getRange(1, 1, 1, header.length).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function hashPass_(pass, salt) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + ':' + pass)
    .map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

function namaSheetData_(event, tgl, cabang) {
  // Judul event + tanggal + cabang. Sheet max 31 char, tanpa karakter []:*?/\
  var bersih = function (s) { return String(s).replace(/[\[\]:*?\/\\]/g, '').trim(); };
  var nm = bersih(event) + '_' + bersih(tgl) + '_' + bersih(cabang);
  return nm.slice(0, 24); // sisakan ruang utk suffix _Prep/_Transaksi/_Inputan/_Rekap
}

/* ---------------- Auth / RBAC ---------------- */
function login_(email, pass) {
  email = String(email || '').trim().toLowerCase();
  pass = String(pass || '');
  var cache = CacheService.getScriptCache();
  var kunci = 'gagal:' + email.slice(0, 100);
  var gagal = Number(cache.get(kunci) || 0);
  if (gagal >= LOGIN_MAKS_GAGAL_) {
    throw new Error('Terlalu banyak percobaan. Coba lagi ' + Math.round(LOGIN_KUNCI_DETIK_ / 60) + ' menit lagi');
  }
  var sh = sheetAturan_('Users', ['email', 'nama', 'cabang', 'passHash', 'salt', 'role', 'aktif', 'dibuat']);
  var rows = sh.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]).toLowerCase() !== email) continue;
    if (hashPass_(pass, rows[i][4]) !== rows[i][3]) break;
    if (rows[i][6] === false || rows[i][6] === 'FALSE') throw new Error('Akun dinonaktifkan');
    cache.remove(kunci);
    var user = { email: rows[i][0], nama: rows[i][1], cabang: rows[i][2], role: rows[i][5] };
    catatLog_('login', user.email + ' (' + user.role + ') OK');
    return { user: user, session: { token: buatSesi_(user), user: user } };
  }
  cache.put(kunci, String(gagal + 1), LOGIN_KUNCI_DETIK_);
  // Pesan sama untuk email tak terdaftar & sandi salah (tidak membocorkan daftar akun)
  throw new Error('Email atau kata sandi salah');
}

// Sesi disimpan di CacheService: variabel global Apps Script tidak bertahan antar request.
function buatSesi_(user) {
  var token = Utilities.getUuid() + Utilities.getUuid();
  CacheService.getScriptCache().put('sesi:' + token,
    JSON.stringify({ email: user.email, role: user.role, cabang: user.cabang }), SESI_DETIK_);
  return token;
}

function requireLogin_(token) {
  var raw = token && CacheService.getScriptCache().get('sesi:' + token);
  if (!raw) throw new Error('Sesi kedaluwarsa, silakan login ulang');
  return JSON.parse(raw);
}

/* ---------------- Manajemen Cabang/User (dinamis) ---------------- */
function listUsers_() {
  var sh = sheetAturan_('Users', ['email', 'nama', 'cabang', 'passHash', 'salt', 'role', 'aktif', 'dibuat']);
  return sh.getDataRange().getValues().slice(1)
    .filter(function (r) { return r[0]; })
    .map(function (r) { return { email: r[0], nama: r[1], cabang: r[2], role: r[5], aktif: r[6] !== false }; });
}

function addUser_(p) {
  if (!p.email || !p.cabang || !p.pass || p.pass.length < 6) throw new Error('Data tidak lengkap (sandi ≥6)');
  var sh = sheetAturan_('Users', ['email', 'nama', 'cabang', 'passHash', 'salt', 'role', 'aktif', 'dibuat']);
  var ada = listUsers_().some(function (u) { return u.email.toLowerCase() === String(p.email).toLowerCase(); });
  if (ada) throw new Error('Email sudah terdaftar');
  var salt = Utilities.getUuid();
  sh.appendRow([String(p.email).toLowerCase(), p.nama || String(p.email).split('@')[0],
                p.cabang, hashPass_(p.pass, salt), salt, p.role === 'ADMIN' ? 'ADMIN' : 'USER',
                true, new Date()]);
  catatLog_('addUser', p.email + ' ' + p.cabang + ' ' + p.role);
  return { ditambahkan: p.email };
}

function deleteUser_(email) {
  var sh = sheetAturan_('Users', ['email', 'nama', 'cabang', 'passHash', 'salt', 'role', 'aktif', 'dibuat']);
  var rows = sh.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]).toLowerCase() === String(email).toLowerCase()) {
      if (rows[i][5] === 'ADMIN' && countAdmin_() <= 1) throw new Error('Tidak bisa menghapus admin terakhir');
      sh.deleteRow(i + 1);
      catatLog_('deleteUser', email);
      return { dihapus: email };
    }
  }
  throw new Error('User tidak ditemukan');
}
function countAdmin_() {
  return listUsers_().filter(function (u) { return u.role === 'ADMIN'; }).length;
}

/* ---------------- Master produk ---------------- */
function getMasterProduk_() {
  var sh = sheetAturan_('MasterProduk', ['kode', 'nama', 'kategori', 'harga']);
  return sh.getDataRange().getValues().slice(1)
    .filter(function (r) { return r[0]; })
    .map(function (r) { return { kode: r[0], nama: r[1], kategori: r[2], harga: Number(r[3] || 0) }; });
}

/* ---------------- Persiapan: scan/input barang bawaan ---------------- */
// p = {event, tglRentang, cabang, produk:{kode,nama,kategori}, jumlah, sumber, user}
function savePrepScan_(p) {
  var sh = sheetAturan_(namaSheetData_(p.event, p.tglRentang, p.cabang) + '_Prep',
                        ['waktu', 'kode', 'judul', 'jumlah', 'kategori', 'sumber', 'user']);
  sh.appendRow([new Date(), p.produk.kode, p.produk.nama, Number(p.jumlah || 0),
                p.produk.kategori, p.sumber || 'scan', p.user || '']);
  return { tersimpan: true };
}
function getPrepScans_(p) {
  var nm = namaSheetData_(p.event, p.tglRentang, p.cabang) + '_Prep';
  var sh = ss_().getSheetByName(nm);
  if (!sh) return [];
  return sh.getDataRange().getValues().slice(1).filter(function (r) { return r[1]; }).map(function (r) {
    return { waktu: r[0], kode: r[1], judul: r[2], jumlah: Number(r[3] || 0), kategori: r[4], sumber: r[5], user: r[6] };
  });
}

/* ---------------- Transaksi pameran ---------------- */
// p = {event, tglRentang, cabang, user, transaksi:{noTransaksi,tanggal,kode,judul,jumlah,diskon,metode,nominalBayar}}
function saveTransaksi_(p) {
  var t = p.transaksi;
  var sh = sheetAturan_(namaSheetData_(p.event, p.tglRentang, p.cabang) + '_Transaksi',
                        ['noTransaksi', 'tanggal', 'kode', 'judul', 'jumlah', 'diskon', 'metode', 'nominalBayar', 'user', 'tutup']);
  sh.appendRow([t.noTransaksi, t.tanggal, t.kode, t.judul, t.jumlah, t.diskon || '', t.metode,
                t.nominalBayar, p.user || '', '']);
  return { tersimpan: t.noTransaksi };
}
function getTransaksiList_(p) {
  var nm = namaSheetData_(p.event, p.tglRentang, p.cabang) + '_Transaksi';
  var sh = ss_().getSheetByName(nm);
  if (!sh) return { rows: [], tertutup: false };
  var rows = sh.getDataRange().getValues().slice(1).filter(function (r) { return r[0] && r[0] !== '—SETORAN—'; });
  return {
    rows: rows.map(function (r) {
      return { noTransaksi: r[0], tanggal: r[1], kode: r[2], judul: r[3], jumlah: Number(r[4] || 0),
               diskon: r[5], metode: r[6], nominalBayar: Number(r[7] || 0), user: r[8] };
    }),
    tertutup: rows.some(function (r) { return r[9] === 'TUTUP'; }),
  };
}
// Tutup Setoran (hari terakhir): tandai TUTUP → klien memblokir tambah transaksi
function tutupSetoran_(p) {
  var nm = namaSheetData_(p.event, p.tglRentang, p.cabang) + '_Transaksi';
  var sh = sheetAturan_(nm, ['noTransaksi', 'tanggal', 'kode', 'judul', 'jumlah', 'diskon', 'metode', 'nominalBayar', 'user', 'tutup']);
  var last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 10, last - 1, 1).setValue('TUTUP');
  sh.appendRow(['—SETORAN—', new Date(), '', 'TOTAL TUTUP SETORAN', '', '', '', Number(p.totalHariItu || 0), p.user || '', 'TUTUP']);
  catatLog_('tutupSetoran', p.event + ' ' + p.cabang);
  return { tertutup: true };
}

/* ---------------- Penginputan (finalisasi) ---------------- */
function saveInputan_(p) {
  var sh = sheetAturan_(namaSheetData_(p.event, p.tglRentang, p.cabang) + '_Inputan',
                        ['waktu', 'kode', 'judul', 'jumlah', 'user']);
  p.rows.forEach(function (r) { sh.appendRow([new Date(), r.kode, r.judul, r.jumlah, p.user || '']); });
  return { disimpan: p.rows.length };
}

function saveRekap_(p) {
  var sh = sheetAturan_(namaSheetData_(p.event, p.tglRentang, p.cabang) + '_Rekap', ['key', 'value']);
  [
    ['totalPenjualan', p.totalPenjualan],
    ['potonganDiskon1', p.potongan1 || ''],
    ['potonganDiskon2', p.potongan2 || ''],
    ['nilaiFinal', p.nilaiFinal],
    ['finalPada', new Date().toISOString()],
    ['user', p.user || ''],
  ].forEach(function (kv) { sh.appendRow(kv); });
  catatLog_('saveRekap', p.event + ' final=' + p.nilaiFinal);
  return { tersimpan: true };
}

/* ---------------- Sheet Tes (untuk Admin) ---------------- */
function runTest_(name) {
  if (name === 'ping') return { pong: new Date().toISOString(), spreadsheet: ss_().getName() };
  if (name === 'seedTest') {
    var sh = sheetAturan_('MasterProduk', ['kode', 'nama', 'kategori', 'harga']);
    var awal = sh.getLastRow();
    sh.appendRow(['TEST-' + Date.now(), 'Produk Tes', 'KANISIUS', 10000]);
    catatLog_('seedTest', 'baris tes ditambahkan ke MasterProduk');
    return { barisSebelum: awal, barisSesudah: sh.getLastRow() };
  }
  throw new Error('Test tidak dikenal: ' + name);
}

function catatLog_(fn, hasil) {
  var sh = sheetAturan_('LogTes', ['waktu', 'fungsi', 'hasil']);
  sh.appendRow([new Date(), fn, String(hasil)]);
}
function clearLog_() {
  var sh = ss_().getSheetByName('LogTes');
  if (sh) sh.clear();
  return { dibersihkan: true };
}

/* ---------------- Setup awal ---------------- */
function setup() {
  sheetAturan_('Users', ['email', 'nama', 'cabang', 'passHash', 'salt', 'role', 'aktif', 'dibuat']);
  sheetAturan_('MasterProduk', ['kode', 'nama', 'kategori', 'harga']);
  sheetAturan_('LogTes', ['waktu', 'fungsi', 'hasil']);
}

// Jalankan SEKALI dari editor Apps Script (pilih fungsi ini lalu Run).
// 1) Ganti `email` dan `pass` di bawah (pass min. 10 karakter) HANYA di editor Apps Script.
// 2) Run -> akun ADMIN masuk ke sheet Users (sandi disimpan sebagai hash).
// 3) Kembalikan `pass` ke placeholder dan simpan, agar sandi tidak tertinggal di kode.
// Jangan commit sandi sungguhan ke GitHub.
function buatAdminPertama() {
  var email = 'admin@pameran.id';              // <-- ganti dengan email Anda
  var pass  = 'GANTI_DENGAN_SANDI_KUAT';       // <-- ganti sebelum Run
  if (pass === 'GANTI_DENGAN_SANDI_KUAT' || pass.length < 10) {
    throw new Error('Ganti dulu nilai `pass` (min. 10 karakter) sebelum menjalankan fungsi ini.');
  }
  addUser_({ email: email, nama: 'Admin', cabang: 'Pusat', pass: pass, role: 'ADMIN' });
  Logger.log('Admin dibuat: %s (sandi tidak dicetak). Kembalikan `pass` ke placeholder lalu simpan.', email);
}
