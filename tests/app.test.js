'use strict';
/* Tes smoke aplikasi nyata: memuat index.html + semua skrip (core, audio,
   auth, home, persiapan, pameran, penginputan, admin, bootstrap) di jsdom,
   lalu menjalankan alur utama kasir: buat pameran → produk → transaksi.

   Tujuan: pemecahan js/app.js menjadi beberapa modul tidak memutus
   pemanggilan lintas modul, bukan sekadar lolos `node --check`.
   jsdom tidak punya IndexedDB/AudioContext/jaringan — Store memakai
   localStorage dan modul audio harus tetap jalan tanpa Web Audio. */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

function daftarSkrip(html) {
  const hasil = [];
  const re = /<script[^>]*\ssrc="([^"]+)"[^>]*><\/script>/g;
  let m;
  while ((m = re.exec(html))) hasil.push(m[1]);
  return hasil;
}

const jendelaTerbuka = [];

async function boot(opsi = {}) {
  // Skrip dijalankan manual (bukan oleh jsdom) supaya urutannya persis index.html
  const dom = new JSDOM(HTML.replace(/<script[\s\S]*?<\/script>/g, ''), {
    url: 'https://pameran.test/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const w = dom.window;
  w.scrollTo = () => {};
  w.confirm = () => true;
  w.alert = () => {};
  // Tanpa jaringan: setiap permintaan ke Supabase dianggap gagal (offline)
  w.fetch = () => Promise.reject(new Error('offline (tes)'));
  if (opsi.AudioContext) w.AudioContext = opsi.AudioContext;
  if (opsi.vibrate) {
    try { w.navigator.vibrate = opsi.vibrate; } catch (e) { /* jsdom mengunci navigator */ }
  }

  for (const src of daftarSkrip(HTML)) {
    const berkas = path.join(ROOT, src);
    w.eval(fs.readFileSync(berkas, 'utf8') + '\n//# sourceURL=' + src);
  }

  // Tunggu DOMContentLoaded (bootstrap menunggu Store.siap sebelum render)
  await new Promise((r) => setTimeout(r, 150));
  if (!w.document.getElementById('scr-login').classList.contains('active')) {
    w.document.dispatchEvent(new w.Event('DOMContentLoaded'));
    await new Promise((r) => setTimeout(r, 150));
  }
  jendelaTerbuka.push(w);
  return w;
}

// Tutup jendela jsdom: menghentikan setInterval (idle timer, sinkron otomatis)
// agar proses tes tidak menggantung.
test.afterEach(() => {
  for (const w of jendelaTerbuka.splice(0)) {
    try { w.close(); } catch (e) { /* abaikan */ }
  }
});

test('modul app termuat dan aplikasi siap di layar login', async () => {
  const w = await boot();
  assert.ok(w.App, 'objek App ada');
  for (const nama of ['Store', 'Sync', 'DB', 'Scanner']) assert.ok(w[nama], nama + ' termuat');
  // Semua modul sudah menempelkan fungsinya ke App
  for (const fn of ['renderHome', 'renderPersiapan', 'renderPameran', 'renderPenginputan',
    'syncProdukPameran', 'pulihSesi', 'tampilkanApp', 'isiDbUrl', 'pasangScanGun',
    'renderSyncBar', 'renderRiwayatTransaksi', 'muaiUsers']) {
    assert.strictEqual(typeof w.App[fn], 'function', 'App.' + fn + ' ada');
  }
  assert.strictEqual(w.App.state.evtId, null);
  assert.ok(w.document.getElementById('scr-login').classList.contains('active'), 'layar login aktif');
  // pulihSesi() merender beranda lewat App.renderHome (modul home dimuat setelah auth).
  // Daftar pameran berisi contoh bawaan Store, jadi tidak boleh kosong setelah boot.
  assert.ok(w.document.getElementById('homeEventList').innerHTML.trim().length > 0, 'beranda terender setelah boot');

  // Setiap handler onclick di index.html harus tetap tersedia di window setelah
  // app.js dipecah — inilah yang paling mudah rusak saat memindahkan fungsi.
  const handler = new Set();
  const reOnclick = /on(?:click|change|input|keydown)="([a-zA-Z_$][\w$]*)\s*\(/g;
  let m;
  while ((m = reOnclick.exec(HTML))) handler.add(m[1]);
  assert.ok(handler.size > 10, 'ada handler inline yang terbaca');
  const kataKunci = new Set(['if', 'for', 'while', 'switch', 'return', 'event']);
  const hilang = [...handler].filter((nama) => !kataKunci.has(nama) && typeof w[nama] !== 'function');
  assert.deepStrictEqual(hilang, [], 'handler onclick tanpa fungsi global');
});

test('buat pameran → persiapan → transaksi tersimpan', async () => {
  const w = await boot();
  const { Store, App } = w;

  // 1. Buat agenda pameran hari ini
  w.buatEventBaru();
  w.document.getElementById('evNama').value = 'Pameran Uji';
  w.document.getElementById('evTanggal').value = Store.tglWIB();
  w.simpanEventBaru();
  const ev = Store.getActiveEvent();
  assert.ok(ev, 'pameran aktif dibuat');
  assert.strictEqual(App.state.evtId, ev.id);
  assert.strictEqual(ev.tglMulai, Store.tglWIB());
  assert.ok(w.document.getElementById('scr-persiapan').classList.contains('active'), 'masuk sesi Persiapan');

  // 2. Produk yang dibawa
  Store.setProdukPameran(ev.id, [
    { kode: 'LB0001', nama: 'Buku Uji', harga: 5000, jumlah: 10, kategori: 'KANISIUS' },
  ]);
  w.goScreen('pameran');
  assert.ok(w.document.getElementById('scr-pameran').classList.contains('active'), 'masuk sesi Pameran');

  // 3. Transaksi baru + scan kode
  await w.mulaiTransaksiBaru();
  assert.strictEqual(App.state.trxAktif, true, 'panel transaksi terbuka');
  assert.strictEqual(App.tambahDariKode('lb-0001'), true, 'kode produk dikenali');
  assert.strictEqual(App.state.keranjang.length, 1);
  assert.strictEqual(App.state.keranjang[0].qty, 1);
  App.tambahDariKode('LB0001');
  assert.strictEqual(App.state.keranjang[0].qty, 2, 'scan kode sama menambah qty');
  // Bilah total lengket muncul selama transaksi berjalan
  assert.notStrictEqual(w.document.getElementById('pmDock').style.display, 'none', 'bilah total tampil');

  // 4. Bayar non-tunai
  w.document.getElementById('pmMetode').value = 'QRIS';
  w.ubahMetode();
  w.simpanTransaksi();
  const trx = Store.getTransaksi(ev.id);
  assert.strictEqual(trx.length, 1);
  assert.strictEqual(trx[0].total, 10000);
  assert.strictEqual(trx[0].items[0].kode, 'LB0001');
  assert.strictEqual(App.state.keranjang.length, 0, 'keranjang dikosongkan setelah simpan'); // .length: larik lintas-realm jsdom
  assert.strictEqual(App.state.trxAktif, false);

  // 5. Sesi Penginputan memakai modul produk yang sama (produkEvent lintas modul)
  w.goScreen('penginputan');
  assert.ok(w.document.getElementById('scr-penginputan').classList.contains('active'), 'masuk sesi Penginputan');
  w.tampilkanRekapTable();
  const rekap = w.document.getElementById('modalIsi').innerHTML;
  assert.ok(rekap.includes('LB0001'), 'rekap memuat produk yang dibawa');
  assert.ok(rekap.includes('Terjual'), 'rekap punya kolom penjualan');
});

test('scan kode tak dikenal ditolak tanpa mengubah keranjang', async () => {
  const w = await boot();
  const { Store, App } = w;
  w.buatEventBaru();
  w.document.getElementById('evNama').value = 'Pameran Gagal Scan';
  w.document.getElementById('evTanggal').value = Store.tglWIB();
  w.simpanEventBaru();
  const id = Store.getActiveEvent().id;
  Store.setProdukPameran(id, [{ kode: 'A1', nama: 'Produk A', harga: 1000, jumlah: 3 }]);
  await w.mulaiTransaksiBaru();
  assert.strictEqual(App.tambahDariKode('TIDAK-ADA'), false);
  assert.strictEqual(App.state.keranjang.length, 0);
});

test('scan sukses memicu nada + getar, kode asing memicu nada gagal', async () => {
  const nada = [];
  const getaran = [];

  class Gain {
    constructor() { this.gain = { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }; }
    connect() {}
  }
  class Osc {
    constructor() { this.frequency = { setValueAtTime() {} }; }
    connect() {}
    start() { nada.push(this); }
    stop() {}
  }
  class AudioContextTiruan {
    constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {}; }
    createOscillator() { return new Osc(); }
    createGain() { return new Gain(); }
    resume() { this.state = 'running'; return Promise.resolve(); }
  }

  const w = await boot({ AudioContext: AudioContextTiruan, vibrate: (pola) => getaran.push(pola) });
  const { Store, App } = w;

  w.buatEventBaru();
  w.document.getElementById('evNama').value = 'Pameran Bunyi';
  w.document.getElementById('evTanggal').value = Store.tglWIB();
  w.simpanEventBaru();
  Store.setProdukPameran(Store.getActiveEvent().id, [{ kode: 'A1', nama: 'Produk A', harga: 1000, jumlah: 5 }]);
  await w.mulaiTransaksiBaru();

  App.tambahDariKode('A1');
  assert.ok(nada.length > 0, 'nada diputar saat produk masuk keranjang');
  assert.strictEqual(App.suara.aktif(), true, 'AudioContext tiruan dibuat dan berjalan');
  assert.ok(getaran.length > 0, 'getar dipanggil');

  const sebelum = nada.length;
  assert.strictEqual(App.tambahDariKode('TIDAK-ADA'), false);
  assert.ok(nada.length > sebelum, 'nada gagal diputar untuk kode tak dikenal');
});

test('modul audio tetap aman tanpa Web Audio (fungsi tidak melempar galat)', async () => {
  const w = await boot();
  assert.ok(w.App.suara, 'App.suara tersedia');
  for (const jenis of ['ok', 'stok', 'gagal', 'klik']) {
    assert.doesNotThrow(() => w.App.suara.mainkan(jenis));
  }
  assert.doesNotThrow(() => w.App.suara.bangunkan());
  assert.strictEqual(w.App.suara.aktif(), false, 'tanpa AudioContext dianggap tidak aktif');
});
