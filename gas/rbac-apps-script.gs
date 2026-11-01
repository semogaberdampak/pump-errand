/* ============================================================
   rbac-apps-script.gs — Backend Google Apps Script
   (paste di Extensions → Apps Script pada spreadsheet Anda,
    lalu Deploy → New deployment → Web app,
    Execute as: Me, Who has access: Anyone)
   Keamanan: sesi di CacheService, cabang/user dari sesi, login dibatasi 5x gagal/15 menit.

   STRUKTUR SPREADSHEET (dibuat otomatis oleh setup()):
     Users        : email | nama | cabang | passHash | salt | role | aktif | dibuat
     Master       : produk_id | isbn | nama_produk | harga   (DIISI MANUAL; sumber data scan Persiapan)
     produk_pameran_<YYYY-MM-DD> : event | cabang | kode | isbn | nama | harga | jumlah | user | diperbarui
                    (dibuat otomatis saat Persiapan menyimpan produk; sumber data transaksi Pameran)
     transaksi_pameran_<YYYY-MM-DD> : event | cabang | trxId | waktu | kasir | metode | kode | nama | harga | qty |
                    diskonTipe | diskonNilai | diskonRp | subtotalItem | netItem | bayar | kembali |
                    status (AKTIF/BATAL) | alasanBatal | dibatalkanOleh | waktuBatal | menggantikan | diperbarui
                    (satu baris per item; transaksi dibatalkan TIDAK dihapus, hanya ditandai BATAL)
     MasterProduk : (lama, tidak dipakai lagi oleh alur Persiapan/Pameran)
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
  if (action === 'logout') {                       // cabut token di server (logout manual / otomatis)
    if (token) CacheService.getScriptCache().remove('sesi:' + token);
    return { keluar: true };
  }
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
    case 'cariMaster': return cariMaster_(p);
    case 'getProdukPameran': return getProdukPameran_(p);
    case 'simpanProdukPameran': return simpanProdukPameran_(p);
    case 'hapusProdukPameran': return hapusProdukPameran_(p);
    case 'getTransaksiPameran': return getTransaksiPameran_(p);
    case 'simpanTransaksiPameran': return simpanTransaksiPameran_(p);
    case 'batalkanTransaksiPameran': return batalkanTransaksiPameran_(p);
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
  p.peranSesi = s.role; // peran pemanggil (terpisah dari p.role milik aksi addUser)
  if (s.role !== 'ADMIN' || !p.cabang) p.cabang = s.cabang;
  return p;
}

/* ---------------- Util sheet ---------------- */
function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }

/* ---- Waktu WIB (Asia/Jakarta). Semua cap waktu di sheet ditulis sebagai teks "yyyy-MM-dd HH:mm:ss" WIB ---- */
var ZONA_ = 'Asia/Jakarta';
function wib_(d) { return Utilities.formatDate(d, ZONA_, 'yyyy-MM-dd HH:mm:ss'); }
function kini_() { return wib_(new Date()); }
// Sel waktu → ISO (UTC) untuk klien. Mengenali teks WIB, ISO lama, dan nilai Date.
function isoDariSel_(v) {
  if (v instanceof Date) return v.toISOString();
  var t = String(v == null ? '' : v);
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(t)) return new Date(t.replace(' ', 'T') + '+07:00').toISOString();
  return t;
}

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
  // Use hash of full email to avoid collisions from similar email prefixes
  var emailHash = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, email)
    .map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('').slice(0, 32);
  var kunci = 'gagal:' + emailHash;
  var gagal = Number(cache.get(kunci) || 0);
  if (gagal >= LOGIN_MAKS_GAGAL_) {
    throw new Error('Terlalu banyak percobaan. Coba lagi ' + Math.round(LOGIN_KUNCI_DETIK_ / 60) + ' menit lagi');
  }
  var sh = sheetAturan_('Users', ['email', 'nama', 'cabang', 'passHash', 'salt', 'role', 'aktif', 'dibuat']);
  var rows = sh.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]).toLowerCase() !== email) continue;
    if (hashPass_(pass, rows[i][4]) !== rows[i][3]) break;
    // Cek aktif: handle berbagai representasi falsy dari Sheets (false, 'FALSE', 0, '0', '')
    var aktifVal = rows[i][6];
    var isAktif = !(aktifVal === false || String(aktifVal).toUpperCase() === 'FALSE' || aktifVal === 0 || aktifVal === '0' || aktifVal === '');
    if (!isAktif) throw new Error('Akun dinonaktifkan');
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
                true, kini_()]);
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

/* ---------------- Sheet "Master": sumber produk (produk_id | isbn | nama_produk | harga) ---------------- */
var SHEET_MASTER_ = 'Master';

// Samakan format kode: abaikan spasi/tanda hubung & huruf besar-kecil (ISBN "978-979-21" == "97897921")
function normKode_(v) { return String(v == null ? '' : v).replace(/[^0-9A-Za-z]/g, '').toUpperCase(); }

function bacaMaster_() {
  var sh = ss_().getSheetByName(SHEET_MASTER_);
  if (!sh) throw new Error("Sheet '" + SHEET_MASTER_ + "' tidak ditemukan di spreadsheet");
  var v = sh.getDataRange().getValues();
  if (v.length < 2) return [];
  var h = v[0].map(function (x) { return String(x).trim().toLowerCase(); });
  var iId = h.indexOf('produk_id'), iIsbn = h.indexOf('isbn'),
      iNama = h.indexOf('nama_produk'), iHarga = h.indexOf('harga');
  if (iId < 0 || iNama < 0) throw new Error("Header sheet 'Master' harus memuat kolom produk_id dan nama_produk");
  var out = [];
  for (var i = 1; i < v.length; i++) {
    var id = String(v[i][iId] == null ? '' : v[i][iId]).trim();
    var isbn = iIsbn >= 0 ? String(v[i][iIsbn] == null ? '' : v[i][iIsbn]).trim() : '';
    var kode = id || isbn;            // baris tanpa produk_id tetap bisa dipakai lewat ISBN-nya
    if (!kode) continue;
    out.push({
      kode: kode,
      isbn: isbn,
      nama: String(v[i][iNama] == null ? '' : v[i][iNama]).trim() || '(tanpa nama)',
      harga: iHarga >= 0 ? Number(v[i][iHarga] || 0) : 0,
    });
  }
  return out;
}

// ISBN-10 ⇄ ISBN-13 (awalan 978). Barcode buku biasanya EAN-13, sedangkan sheet bisa memuat ISBN-10.
function isbn13dari10_(n) {
  var d = '978' + n.slice(0, 9), sum = 0;
  for (var i = 0; i < 12; i++) sum += Number(d[i]) * (i % 2 ? 3 : 1);
  return d + ((10 - (sum % 10)) % 10);
}
function isbn10dari13_(n) {
  var d = n.slice(3, 12), sum = 0;
  for (var i = 0; i < 9; i++) sum += Number(d[i]) * (10 - i);
  var c = (11 - (sum % 11)) % 11;
  return d + (c === 10 ? 'X' : String(c));
}
// Semua bentuk setara dari satu kode: apa adanya, tanpa nol di depan (UPC-A ⇄ EAN-13), dan ISBN-10 ⇄ ISBN-13
function varian_(v) {
  var n = normKode_(v), out = [];
  if (!n) return out;
  out.push(n);
  if (/^\d+$/.test(n)) {
    var t = n.replace(/^0+/, '');
    if (t && t !== n) out.push(t);
    if (n.length === 13 && n.indexOf('978') === 0) out.push(isbn10dari13_(n));
  }
  if (/^\d{9}[\dX]$/.test(n)) out.push(isbn13dari10_(n));
  return out;
}
function samaKode_(setA, nilai) {
  if (!nilai) return false;
  var vs = varian_(nilai);
  for (var i = 0; i < vs.length; i++) if (setA[vs[i]]) return true;
  return false;
}

// p = {q, exact?}. Cocok persis dengan produk_id atau isbn lebih dulu (hasil scan; toleran ISBN-10/13 & nol di depan).
// Bila tidak ada & exact bukan true → cari kata kunci pada nama/kode/isbn, urut paling relevan (maks. 50 ditampilkan).
function cariMaster_(p) {
  var q = String(p.q || '').trim();
  if (!q) throw new Error('Kode atau kata kunci kosong');
  if (q.length > 100) throw new Error('Kata kunci terlalu panjang');
  var semua = bacaMaster_(), i;
  var setQ = {};
  varian_(q).forEach(function (x) { setQ[x] = 1; });
  var exact = null;
  if (Object.keys(setQ).length) {
    for (i = 0; i < semua.length; i++) {
      if (samaKode_(setQ, semua[i].kode) || samaKode_(setQ, semua[i].isbn)) { exact = semua[i]; break; }
    }
  }
  if (exact || p.exact === true) return { exact: exact, hasil: [], total: exact ? 1 : 0 };
  if (q.length < 3) return { exact: null, hasil: [], total: 0 };
  var kata = q.toLowerCase().split(/\s+/).filter(String), cocok = [];
  for (i = 0; i < semua.length; i++) {
    var nm = semua[i].nama.toLowerCase();
    var gabung = nm + ' ' + semua[i].kode.toLowerCase() + ' ' + semua[i].isbn.toLowerCase();
    if (!kata.every(function (k) { return gabung.indexOf(k) >= 0; })) continue;
    var skor = nm.indexOf(kata[0]) === 0 ? 0 : (nm.indexOf(kata[0]) > 0 ? 1 : 2); // judul diawali kata → paling atas
    cocok.push({ m: semua[i], skor: skor, urut: i });
  }
  cocok.sort(function (a, b) { return a.skor - b.skor || a.urut - b.urut; });
  return { exact: null, total: cocok.length, hasil: cocok.slice(0, 50).map(function (x) { return x.m; }) };
}

/* ---------------- Persiapan → sheet produk_pameran_<tanggal> ---------------- */
var HDR_PP_ = ['event', 'cabang', 'kode', 'isbn', 'nama', 'harga', 'jumlah', 'user', 'diperbarui'];

function namaSheetPP_(tgl) {
  tgl = String(tgl || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tgl)) throw new Error('Tanggal pameran tidak valid (format YYYY-MM-DD)');
  return 'produk_pameran_' + tgl;
}
// Judul pameran dibandingkan tanpa peduli huruf besar/kecil & spasi ganda (HP kedua cukup mengetik judul yang sama)
function normEvent_(s) { return String(s == null ? '' : s).trim().replace(/\s+/g, ' ').toLowerCase(); }
function cocokPP_(r, event, cabang) { return normEvent_(r[0]) === normEvent_(event) && String(r[1]).trim() === String(cabang).trim(); }
function eventPP_(p) {
  var event = String(p.event || '').trim();
  if (!event) throw new Error('Judul pameran kosong');
  return event;
}

// p = {event, tgl} (cabang dari sesi)
function getProdukPameran_(p) {
  var event = eventPP_(p);
  var sh = ss_().getSheetByName(namaSheetPP_(p.tgl));
  if (!sh) return [];
  var v = sh.getDataRange().getValues(), out = [];
  for (var i = 1; i < v.length; i++) {
    if (!cocokPP_(v[i], event, p.cabang)) continue;
    out.push({ kode: String(v[i][2]), isbn: String(v[i][3] || ''), nama: String(v[i][4]),
               harga: Number(v[i][5] || 0), jumlah: Number(v[i][6] || 0) });
  }
  return out;
}

// p = {event, tgl, kode, harga, jumlah}. Nama & ISBN SELALU diambil dari sheet Master (bukan kiriman klien).
// Kode yang sama pada event + cabang yang sama diperbarui (tidak menambah baris ganda).
function simpanProdukPameran_(p) {
  var event = eventPP_(p);
  var harga = Number(p.harga), jumlah = Number(p.jumlah);
  if (!isFinite(harga) || harga < 0 || Math.floor(harga) !== harga) throw new Error('Harga harus bilangan bulat ≥ 0');
  if (!isFinite(jumlah) || jumlah < 1 || jumlah > 100000 || Math.floor(jumlah) !== jumlah) throw new Error('Jumlah harus bilangan bulat ≥ 1');
  var m = cariMaster_({ q: p.kode, exact: true }).exact;
  if (!m) throw new Error('Kode ' + String(p.kode).slice(0, 40) + ' tidak ada di sheet Master');
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var sh = sheetAturan_(namaSheetPP_(p.tgl), HDR_PP_);
    var v = sh.getDataRange().getValues(), baris = -1;
    for (var i = 1; i < v.length; i++) {
      if (cocokPP_(v[i], event, p.cabang) && normKode_(v[i][2]) === normKode_(m.kode)) { baris = i + 1; break; }
    }
    var isi = [event, p.cabang, m.kode, m.isbn, m.nama, harga, jumlah, p.user || '', kini_()];
    var target = baris > 0 ? baris : sh.getLastRow() + 1;
    // Kolom teks dipaksa format teks: kode tidak kehilangan nol di depan & teks berawalan "=" tidak jadi rumus
    sh.getRange(target, 1, 1, 5).setNumberFormat('@');
    sh.getRange(target, 8, 1, 2).setNumberFormat('@');
    sh.getRange(target, 1, 1, isi.length).setValues([isi]);
    return { diperbarui: baris > 0,
             produk: { kode: m.kode, isbn: m.isbn, nama: m.nama, harga: harga, jumlah: jumlah } };
  } finally { lock.releaseLock(); }
}

// p = {event, tgl, kode}
function hapusProdukPameran_(p) {
  var event = eventPP_(p);
  var sh = ss_().getSheetByName(namaSheetPP_(p.tgl));
  if (!sh) throw new Error('Belum ada produk pameran untuk tanggal ini');
  var nk = normKode_(p.kode);
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    // Produk yang masih dipakai transaksi AKTIF (di perangkat mana pun) tidak boleh dihapus
    var st = ss_().getSheetByName(namaSheetTrx_(p.tgl));
    if (st) {
      var tv = st.getDataRange().getValues();
      for (var j = 1; j < tv.length; j++) {
        if (cocokTrx_(tv[j], event, p.cabang) && normKode_(tv[j][6]) === nk && tv[j][17] !== 'BATAL') {
          throw new Error('Produk sudah dipakai di transaksi aktif — batalkan transaksinya dulu');
        }
      }
    }
    var v = sh.getDataRange().getValues();
    for (var i = 1; i < v.length; i++) {
      if (cocokPP_(v[i], event, p.cabang) && normKode_(v[i][2]) === nk) {
        sh.deleteRow(i + 1);
        catatLog_('hapusProdukPameran', event + ' ' + p.cabang + ' ' + v[i][2]);
        return { dihapus: String(v[i][2]) };
      }
    }
  } finally { lock.releaseLock(); }
  throw new Error('Produk tidak ditemukan di daftar pameran');
}

/* ---------------- Persiapan: scan/input barang bawaan ---------------- */
// p = {event, tglRentang, cabang, produk:{kode,nama,kategori}, jumlah, sumber, user}
function savePrepScan_(p) {
  var sh = sheetAturan_(namaSheetData_(p.event, p.tglRentang, p.cabang) + '_Prep',
                        ['waktu', 'kode', 'judul', 'jumlah', 'kategori', 'sumber', 'user']);
  sh.appendRow([kini_(), p.produk.kode, p.produk.nama, Number(p.jumlah || 0),
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

/* ---------------- Transaksi pameran → sheet transaksi_pameran_<tanggal> ---------------- */
var HDR_TRX_ = ['event', 'cabang', 'trxId', 'waktu', 'kasir', 'metode', 'kode', 'nama', 'harga', 'qty',
                'diskonTipe', 'diskonNilai', 'diskonRp', 'subtotalItem', 'netItem', 'bayar', 'kembali',
                'status', 'alasanBatal', 'dibatalkanOleh', 'waktuBatal', 'menggantikan', 'diperbarui'];
var METODE_ = ['TUNAI', 'QRIS', 'DEBIT', 'TRANSFER'];

function namaSheetTrx_(tgl) { return 'transaksi_pameran_' + namaSheetPP_(tgl).slice('produk_pameran_'.length); }
function cocokTrx_(r, event, cabang) { return cocokPP_(r, event, cabang); }
function bolehUbahTrx_(userBaris, p) {
  return p.peranSesi === 'ADMIN' || String(userBaris).toLowerCase() === String(p.user || '').toLowerCase();
}

// Hitungan per item: sub = harga × qty; potongan = % dari sub atau nominal Rp (maks. sub); net = sub − potongan
function hitungItem_(it) {
  var harga = Number(it.harga), qty = Number(it.qty), nilai = Number(it.diskonNilai || 0);
  var tipe = it.diskonTipe === 'RUPIAH' ? 'RUPIAH' : 'PERSEN';
  if (!String(it.kode || '').trim()) throw new Error('Kode item kosong');
  if (!isFinite(harga) || harga < 0 || Math.floor(harga) !== harga) throw new Error('Harga item tidak valid');
  if (!isFinite(qty) || qty < 1 || qty > 100000 || Math.floor(qty) !== qty) throw new Error('Jumlah item tidak valid');
  if (!isFinite(nilai) || nilai < 0) throw new Error('Diskon tidak valid');
  var sub = harga * qty, pot;
  if (tipe === 'PERSEN') {
    if (nilai > 100) throw new Error('Diskon persen maksimum 100%');
    pot = Math.round((sub * nilai) / 100 + 1e-9);
  } else {
    pot = Math.round(nilai);
    if (pot > sub) throw new Error('Potongan melebihi subtotal item');
  }
  return { harga: harga, qty: qty, tipe: tipe, nilai: nilai, sub: sub, pot: pot, net: sub - pot };
}

// Tandai BATAL semua baris transaksi `id` (tidak menghapus). Hanya pembuat atau ADMIN.
function batalBaris_(sh, event, cabang, id, alasan, p) {
  var v = sh.getDataRange().getValues(), n = 0, sudah = true;
  for (var i = 1; i < v.length; i++) {
    if (!cocokTrx_(v[i], event, cabang) || String(v[i][2]) !== id) continue;
    if (!bolehUbahTrx_(v[i][4], p)) throw new Error('Hanya pembuat transaksi atau admin yang boleh membatalkan');
    n++;
    if (v[i][17] !== 'BATAL') {
      sudah = false;
      sh.getRange(i + 1, 18, 1, 4).setNumberFormat('@');
      sh.getRange(i + 1, 18, 1, 4).setValues([['BATAL', alasan, p.user || '', kini_()]]);
    }
  }
  return { ditemukan: n > 0, sudah: n > 0 && sudah };
}

// p = {event, tgl, trx:{id, waktu, metode, items[{kode,nama,harga,qty,diskonTipe,diskonNilai}], bayar, menggantikan?}}
// Idempotent: ID yang sama dikirim ulang (mis. respons terputus) tidak menambah baris.
// `menggantikan` = koreksi: transaksi lama dibatalkan dalam proses yang sama.
function simpanTransaksiPameran_(p) {
  var event = eventPP_(p), t = p.trx || {};
  var id = String(t.id || '');
  if (!/^[A-Za-z0-9_-]{6,40}$/.test(id)) throw new Error('ID transaksi tidak valid');
  var metode = String(t.metode || '');
  if (METODE_.indexOf(metode) < 0) throw new Error('Metode bayar tidak valid');
  var items = t.items;
  if (!items || !items.length || items.length > 100) throw new Error('Item transaksi kosong atau terlalu banyak');
  var hit = items.map(hitungItem_), total = 0;
  hit.forEach(function (h) { total += h.net; });
  var bayar = Number(t.bayar);
  if (metode === 'TUNAI') {
    if (!isFinite(bayar) || bayar < total) throw new Error('Uang diterima kurang dari total');
  } else { bayar = total; }
  var waktu = new Date(t.waktu);
  if (isNaN(waktu.getTime())) waktu = new Date();
  var lama = t.menggantikan ? String(t.menggantikan) : '';

  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var sh = sheetAturan_(namaSheetTrx_(p.tgl), HDR_TRX_);
    var v = sh.getDataRange().getValues(), ada = false, i;
    for (i = 1; i < v.length; i++) {
      if (cocokTrx_(v[i], event, p.cabang) && String(v[i][2]) === id) { ada = true; break; }
    }
    var lamaBatal = null;
    if (lama) lamaBatal = batalBaris_(sh, event, p.cabang, lama, 'Dikoreksi → ' + id, p).ditemukan;
    if (!ada) {
      var isi = hit.map(function (h, n) {
        return [event, p.cabang, id, wib_(waktu), p.user || '', metode,
                String(items[n].kode).trim().slice(0, 40), String(items[n].nama || '').slice(0, 150),
                h.harga, h.qty, h.tipe, h.nilai, h.pot, h.sub, h.net,
                n === 0 ? bayar : '', n === 0 ? bayar - total : '',
                'AKTIF', '', '', '', lama, kini_()];
      });
      var mulai = sh.getLastRow() + 1, n = isi.length;
      // Kolom teks diformat teks: rumus tidak dieksekusi & kode tidak kehilangan nol di depan
      sh.getRange(mulai, 1, n, 8).setNumberFormat('@');
      sh.getRange(mulai, 11, n, 1).setNumberFormat('@');
      sh.getRange(mulai, 18, n, 6).setNumberFormat('@');
      sh.getRange(mulai, 1, n, isi[0].length).setValues(isi);
    }
    return { tersimpan: id, sudah: ada, total: total, menggantikan: lama || null, menggantikanDibatalkan: lamaBatal };
  } finally { lock.releaseLock(); }
}

// p = {event, tgl, id, alasan}
function batalkanTransaksiPameran_(p) {
  var event = eventPP_(p), id = String(p.id || ''), alasan = String(p.alasan || '').trim();
  if (alasan.length < 3 || alasan.length > 200) throw new Error('Alasan pembatalan 3–200 karakter');
  var sh = ss_().getSheetByName(namaSheetTrx_(p.tgl));
  if (!sh) throw new Error('Transaksi tidak ditemukan');
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var r = batalBaris_(sh, event, p.cabang, id, alasan, p);
    if (!r.ditemukan) throw new Error('Transaksi tidak ditemukan');
    if (!r.sudah) catatLog_('batalTransaksi', event + ' ' + p.cabang + ' ' + id + ' — ' + alasan);
    return { dibatalkan: id, sudah: r.sudah };
  } finally { lock.releaseLock(); }
}

// p = {event, tgl} → daftar transaksi (aktif & batal) untuk cabang sesi
function getTransaksiPameran_(p) {
  var event = eventPP_(p);
  var sh = ss_().getSheetByName(namaSheetTrx_(p.tgl));
  if (!sh) return [];
  var v = sh.getDataRange().getValues(), peta = {}, urut = [];
  for (var i = 1; i < v.length; i++) {
    var r = v[i];
    if (!cocokTrx_(r, event, p.cabang)) continue;
    var id = String(r[2]), t = peta[id];
    if (!t) {
      t = peta[id] = { id: id, waktu: isoDariSel_(r[3]), kasirEmail: String(r[4]), metode: String(r[5]), items: [],
                       subtotal: 0, diskon: 0, total: 0, bayar: 0, kembali: 0,
                       deleted: r[17] === 'BATAL',
                       batal: r[17] === 'BATAL' ? { alasan: String(r[18]), oleh: String(r[19]), waktu: isoDariSel_(r[20]) } : null,
                       menggantikan: String(r[21] || '') };
      urut.push(id);
    }
    t.items.push({ kode: String(r[6]), nama: String(r[7]), harga: Number(r[8]), qty: Number(r[9]),
                   diskonTipe: String(r[10]), diskonNilai: Number(r[11] || 0), diskon: Number(r[12] || 0),
                   net: Number(r[14] || 0), kategori: '', catatan: '' });
    t.subtotal += Number(r[13] || 0); t.diskon += Number(r[12] || 0); t.total += Number(r[14] || 0);
    if (r[15] !== '' && r[15] != null) { t.bayar = Number(r[15]); t.kembali = Number(r[16] || 0); }
  }
  return urut.map(function (id) { return peta[id]; });
}

/* ---------------- (lama) Transaksi per event ---------------- */
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
  sh.appendRow(['—SETORAN—', kini_(), '', 'TOTAL TUTUP SETORAN', '', '', '', Number(p.totalHariItu || 0), p.user || '', 'TUTUP']);
  catatLog_('tutupSetoran', p.event + ' ' + p.cabang);
  return { tertutup: true };
}

/* ---------------- Penginputan (finalisasi) ---------------- */
function saveInputan_(p) {
  var sh = sheetAturan_(namaSheetData_(p.event, p.tglRentang, p.cabang) + '_Inputan',
                        ['waktu', 'kode', 'judul', 'jumlah', 'user']);
  p.rows.forEach(function (r) { sh.appendRow([kini_(), r.kode, r.judul, r.jumlah, p.user || '']); });
  return { disimpan: p.rows.length };
}

function saveRekap_(p) {
  var sh = sheetAturan_(namaSheetData_(p.event, p.tglRentang, p.cabang) + '_Rekap', ['key', 'value']);
  [
    ['totalPenjualan', p.totalPenjualan],
    ['potonganDiskon1', p.potongan1 || ''],
    ['potonganDiskon2', p.potongan2 || ''],
    ['nilaiFinal', p.nilaiFinal],
    ['finalPada', kini_()],
    ['user', p.user || ''],
  ].forEach(function (kv) { sh.appendRow(kv); });
  catatLog_('saveRekap', p.event + ' final=' + p.nilaiFinal);
  return { tersimpan: true };
}

/* ---------------- Sheet Tes (untuk Admin) ---------------- */
function runTest_(name) {
  if (name === 'ping') return { pong: kini_(), spreadsheet: ss_().getName() };
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
  sh.appendRow([kini_(), fn, String(hasil)]);
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
