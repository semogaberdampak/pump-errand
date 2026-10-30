/* ============================================================
   rbac-apps-script.gs — Backend Google Apps Script
   (paste di Extensions → Apps Script pada spreadsheet Anda,
    lalu Deploy → New deployment → Web app,
    Execute as: Me, Who has access: Anyone)

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

var K_SESI = {}; // token → {email, role, _exp}

function doGet(e) { return handle_(e); }
function doPost(e) { return handle_(e); }

function handle_(e) {
  var out;
  try {
    var action = e.parameter.action || '';
    var payload = JSON.parse(e.parameter.payload || '{}');
    var data = route_(action, payload, e.parameter.token || '');
    out = { ok: true, data: data };
  } catch (err) {
    out = { ok: false, error: String(err && err.message || err), code: (err && err.code) || '' };
  }
  return ContentService.createTextOutput(JSON.stringify(out))
    .setMimeType(ContentService.MimeType.JSON);
}

function route_(action, p, token) {
  switch (action) {
    case 'login': return login_(p.email, p.pass);
    case 'listUsers': requireAdmin_(token); return listUsers_();
    case 'addUser': requireAdmin_(token); return addUser_(p);
    case 'deleteUser': requireAdmin_(token); return deleteUser_(p.email);
    case 'test': requireAdmin_(token); return runTest_(p.name);
    case 'clearLog': requireAdmin_(token); return clearLog_();
    case 'getMasterProduk': requireLogin_(token); return getMasterProduk_();
    case 'savePrepScan': requireLogin_(token); return savePrepScan_(p);
    case 'getPrepScans': requireLogin_(token); return getPrepScans_(p);
    case 'saveTransaksi': requireLogin_(token); return saveTransaksi_(p);
    case 'getTransaksiList': requireLogin_(token); return getTransaksiList_(p);
    case 'tutupSetoran': requireLogin_(token); return tutupSetoran_(p);
    case 'saveInputan': requireLogin_(token); return saveInputan_(p);
    case 'saveRekap': requireLogin_(token); return saveRekap_(p);
    default: throw new Error('Aksi tidak dikenal: ' + action);
  }
}

/* ---------------- Util sheet ---------------- */
function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }

function sheetAturan_(nama, header) {
  var sh = ss_.getSheetByName(nama);
  if (!sh) sh = ss_.insertSheet(nama);
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
  var sh = sheetAturan_('Users', ['email', 'nama', 'cabang', 'passHash', 'salt', 'role', 'aktif', 'dibuat']);
  var rows = sh.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]).toLowerCase() !== email) continue;
    if (rows[i][6] === false || rows[i][6] === 'FALSE') throw new Error('Akun dinonaktifkan');
    var cek = hashPass_(pass, rows[i][4]);
    if (cek !== rows[i][3]) throw new Error('Kata sandi salah');
    var user = { email: rows[i][0], nama: rows[i][1], cabang: rows[i][2], role: rows[i][5] };
    var token = Utilities.getUuid();
    K_SESI[token] = { email: user.email, role: user.role, _exp: Date.now() + 12 * 3600e3 };
    catatLog_('login', user.email + ' (' + user.role + ') OK');
    return { user: user, session: { token: token, user: user } };
  }
  throw new Error('User tidak terdaftar — minta Admin membuat akun Cabang/User');
}

function requireLogin_(token) {
  var s = K_SESI[token];
  if (!s || s._exp < Date.now()) throw new Error('Sesi kedaluwarsa, silakan login ulang');
  return s;
}
function requireAdmin_(token) {
  var s = requireLogin_(token);
  if (s.role !== 'ADMIN') throw new Error('Halaman khusus Admin');
  return s;
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
  var sh = ss_.getSheetByName(nm);
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
  var sh = ss_.getSheetByName(nm);
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
  if (name === 'ping') return { pong: new Date().toISOString(), spreadsheet: ss_.getName() };
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
  var sh = ss_.getSheetByName('LogTes');
  if (sh) sh.clear();
  return { dibersihkan: true };
}

/* ---------------- Setup awal ---------------- */
function setup() {
  sheetAturan_('Users', ['email', 'nama', 'cabang', 'passHash', 'salt', 'role', 'aktif', 'dibuat']);
  sheetAturan_('MasterProduk', ['kode', 'nama', 'kategori', 'harga']);
  sheetAturan_('LogTes', ['waktu', 'fungsi', 'hasil']);
}

// Jalankan SEKALI dari editor Apps Script (Run fungsi ini), lalu lihat
// "Execution log" — kredensial admin tercetak di sana. GANTI passwordnya
// setelah login pertama (tambah user admin baru via tab Admin, lalu hapus yang ini).
function buatAdminPertama() {
  var email = 'admin@pameran.id';
  var pass  = 'GantiSandi123'; // <-- ubah sebelum menjalankan
  addUser_({ email: email, nama: 'Admin', cabang: 'Pusat', pass: pass, role: 'ADMIN' });
  Logger.log('=== ADMIN DIBUAT ===\nEmail    : %s\nPassword : %s\n(ubah segera setelah login pertama)', email, pass);
}
