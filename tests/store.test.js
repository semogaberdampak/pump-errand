/* ============================================================
   store.test.js — Menguji lapisan penyimpanan js/store.js:
   migrasi data lama dari localStorage ke IndexedDB, baca-tulis
   lewat cache memori, pembersihan saat event dihapus, dan
   cadangan localStorage bila IndexedDB tidak tersedia.
   IndexedDB diganti objek tiruan lewat kait window.__storeDisk.
   ============================================================ */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const KODE = fs.readFileSync(path.join(__dirname, '..', 'js', 'store.js'), 'utf8');

function buatLokal(awal) {
  const isi = new Map(Object.entries(awal || {}));
  return {
    get length() { return isi.size; },
    key(i) { return Array.from(isi.keys())[i] ?? null; },
    getItem(k) { return isi.has(k) ? isi.get(k) : null; },
    setItem(k, v) { isi.set(k, String(v)); },
    removeItem(k) { isi.delete(k); },
    isi,
  };
}

function buatDisk(awal) {
  const isi = new Map(Object.entries(awal || {}));
  return {
    semua: async () => Array.from(isi.entries()),
    simpan: async (k, s) => { isi.set(k, s); return true; },
    hapus: async (k) => { isi.delete(k); return true; },
    isi,
  };
}

// Muat store.js dengan localStorage & (opsional) disk tiruan di dalam sandbox vm
function muatStore({ lokal, disk }) {
  const sandbox = { localStorage: lokal, console, setTimeout, Intl };
  if (disk) sandbox.__storeDisk = disk;
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(KODE, sandbox, { filename: 'store.js' });
  return sandbox.Store;
}

// Beri kesempatan penulisan latar belakang (Promise) untuk selesai
const tunggu = () => new Promise((r) => setImmediate(r));

test('data lama di localStorage dipindahkan ke IndexedDB, kunci modul lain dibiarkan', async () => {
  const lokal = buatLokal({
    'pameran.events': JSON.stringify([{ id: 'e1', nama: 'Pameran A' }]),
    'pameran.e1.transaksi': JSON.stringify([{ id: 't1', total: 1000, items: [] }]),
    'pameran.theme': 'dark',
    'pameran.session': '{"access":"AT"}',
  });
  const disk = buatDisk();
  const Store = muatStore({ lokal, disk });

  await Store.siap;

  assert.equal(Store.getEvents().length, 1);
  assert.equal(Store.getEvents()[0].nama, 'Pameran A');
  assert.equal(Store.getTransaksi('e1')[0].total, 1000);

  assert.ok(disk.isi.has('pameran.events'), 'events tersimpan di IndexedDB');
  assert.ok(disk.isi.has('pameran.e1.transaksi'), 'transaksi tersimpan di IndexedDB');
  assert.equal(lokal.getItem('pameran.events'), null, 'salinan localStorage dibersihkan');
  assert.equal(lokal.getItem('pameran.e1.transaksi'), null);

  // Kunci milik modul lain tidak boleh ikut dipindah / dihapus
  assert.equal(lokal.getItem('pameran.theme'), 'dark');
  assert.equal(lokal.getItem('pameran.session'), '{"access":"AT"}');
  assert.equal(disk.isi.has('pameran.theme'), false);
});

test('data di IndexedDB menang atas salinan localStorage yang tertinggal', async () => {
  const lokal = buatLokal({ 'pameran.events': JSON.stringify([{ id: 'lama', nama: 'Versi Lokal' }]) });
  const disk = buatDisk({ 'pameran.events': JSON.stringify([{ id: 'baru', nama: 'Versi Disk' }]) });
  const Store = muatStore({ lokal, disk });

  await Store.siap;

  assert.equal(Store.getEvents()[0].nama, 'Versi Disk');
  assert.equal(lokal.getItem('pameran.events'), null, 'salinan lama tidak menumpuk di localStorage');
});

test('tulis-baca tetap sinkron dan tersimpan ke IndexedDB', async () => {
  const lokal = buatLokal();
  const disk = buatDisk();
  const Store = muatStore({ lokal, disk });
  await Store.siap;

  const trx = [{ id: 't1', total: 25000, items: [{ kode: 'BK-1', qty: 1 }] }];
  Store.setTransaksi('e9', trx);

  // Baca langsung (sinkron) tidak menunggu disk
  assert.equal(Store.getTransaksi('e9')[0].total, 25000);
  assert.equal(lokal.getItem('pameran.e9.transaksi'), null, 'tidak menulis localStorage saat IndexedDB siap');

  await tunggu();
  assert.deepEqual(JSON.parse(disk.isi.get('pameran.e9.transaksi')), trx);
});

test('hapus event membersihkan data di memori dan IndexedDB', async () => {
  const lokal = buatLokal();
  const disk = buatDisk({
    'pameran.events': JSON.stringify([{ id: 'e1', nama: 'Hapus Saya' }]),
    'pameran.e1.transaksi': JSON.stringify([{ id: 't1', items: [] }]),
    'pameran.e1.inputan': JSON.stringify([]),
  });
  const Store = muatStore({ lokal, disk });
  await Store.siap;

  Store.hapusEvent('e1');
  await tunggu();

  assert.equal(Store.getEvents().length, 0);
  assert.equal(disk.isi.has('pameran.e1.transaksi'), false);
  assert.equal(disk.isi.has('pameran.e1.inputan'), false);
  assert.equal(Store.getTransaksi('e1').length, 0, 'kunci di memori ikut terhapus');
});

test('tanpa IndexedDB, data tetap jalan di localStorage seperti sebelumnya', async () => {
  const lokal = buatLokal({ 'pameran.events': JSON.stringify([{ id: 'e1', nama: 'Lokal Saja' }]) });
  const Store = muatStore({ lokal, disk: null });
  await Store.siap;

  assert.equal(Store.getEvents()[0].nama, 'Lokal Saja');

  Store.setEvents([{ id: 'e2', nama: 'Baru' }]);
  assert.deepEqual(JSON.parse(lokal.getItem('pameran.events')), [{ id: 'e2', nama: 'Baru' }]);
  assert.equal(Store.getEvents()[0].nama, 'Baru');
});
