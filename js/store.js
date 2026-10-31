/* ============================================================
   store.js — Lapisan penyimpanan data (localStorage) untuk
   aplikasi Pencatatan pameran.
   Semua data dinormalisasi per EVENT (pameran) agar bisa
   menjalankan beberapa pameran sekaligus tanpa saling menimpa.

   Kunci storage:
     pameran.events        → daftar event
     pameran.active        → id event yang sedang dibuka
     pameran.products      → master produk global
     pameran.<id>.stokawal    → stok awal per produk (sesi Persiapan)
     pameran.<id>.cek         → checklist persiapan
     pameran.<id>.transaksi   → transaksi penjualan (sesi pameran)
     pameran.<id>.inputan     → input manual qty (sesi Penginputan)
   ============================================================ */
(function (global) {
  'use strict';

  const PREFIX = 'pameran.';
  const K_EVENTS = PREFIX + 'events';
  const K_ACTIVE = PREFIX + 'active';
  const K_PRODUCTS = PREFIX + 'products';

  // Checklist standar sesi Persiapan
  const CEK_DEFAULT = [
    'Booth / meja display tertata',
    'Spanduk & banner terpasang',
    'Daftar produk & harga ditempel',
    'Kalkulator, pulpen, kertas nota siap',
    'Uang kembalian / kas kecil siap',
    'QRIS & mesin EDC diuji',
    'Stok awal dihitung & dicatat',
    'HP/laptop scanner siap + baterai penuh',
  ];

  // Master produk TIDAK disimpan sebagai dummy di klien.
  // Sumber kebenaran: sheet "MasterProduk" via GAS (js/gas.js).
  // Cache lokal hanya menampung hasil tarik terakhir dari server.
  const CONTOH_PRODUK = [];

  function baca(kunci, defaultVal) {
    try {
      const raw = localStorage.getItem(kunci);
      if (raw === null) return defaultVal;
      return JSON.parse(raw);
    } catch (e) {
      console.error('store.baca gagal:', kunci, e);
      return defaultVal;
    }
  }

  function tulis(kunci, nilai) {
    try {
      localStorage.setItem(kunci, JSON.stringify(nilai));
      return true;
    } catch (e) {
      console.error('store.tulis gagal:', kunci, e);
      global.toast && global.toast('Gagal menyimpan data (penyimpanan penuh?)', 'err');
      return false;
    }
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  /* ---------------- Event / pameran ---------------- */
  function getEvents() { return baca(K_EVENTS, []); }
  function setEvents(list) { return tulis(K_EVENTS, list); }

  function buatEvent(nama, tanggal, catatan) {
    const list = getEvents();
    const today = new Date().toISOString().slice(0, 10);
    const ev = {
      id: uid(),
      nama: (nama || '').trim() || 'pameran ' + new Date().toLocaleDateString('id-ID'),
      tanggal: tanggal || today,
      tglMulai: today,
      tglSelesai: today,
      catatan: (catatan || '').trim(),
      dibuat: new Date().toISOString(),
      selesai: null,
    };
    list.push(ev);
    setEvents(list);
    // inisialisasi data per-event
    tulis(PREFIX + ev.id + '.stokawal', {});
    tulis(PREFIX + ev.id + '.cek', CEK_DEFAULT.map((t) => ({ teks: t, done: false })));
    tulis(PREFIX + ev.id + '.transaksi', []);
    tulis(PREFIX + ev.id + '.inputan', []);
    return ev;
  }

  function updateEvent(id, patch) {
    const list = getEvents();
    const i = list.findIndex((e) => e.id === id);
    if (i < 0) return null;
    list[i] = Object.assign({}, list[i], patch);
    setEvents(list);
    return list[i];
  }

  function hapusEvent(id) {
    setEvents(getEvents().filter((e) => e.id !== id));
    ['stokawal', 'cek', 'transaksi', 'inputan'].forEach((k) =>
      localStorage.removeItem(PREFIX + id + '.' + k)
    );
    if (getActiveId() === id) setActiveId(null);
  }

  function getActiveId() { return baca(K_ACTIVE, null); }
  function setActiveId(id) { return tulis(K_ACTIVE, id); }
  function getActiveEvent() {
    const id = getActiveId();
    return getEvents().find((e) => e.id === id) || null;
  }

  /* ---------------- Data per-event ---------------- */
  function getKey(id, bagian) { return PREFIX + id + '.' + bagian; }

  function getStokAwal(id) { return baca(getKey(id, 'stokawal'), {}); }
  function setStokAwal(id, map) { return tulis(getKey(id, 'stokawal'), map); }

  function getCek(id) {
    const val = baca(getKey(id, 'cek'), null);
    if (!val) return CEK_DEFAULT.map((t) => ({ teks: t, done: false }));
    return val;
  }
  function setCek(id, list) { return tulis(getKey(id, 'cek'), list); }

  function getTransaksi(id) { return baca(getKey(id, 'transaksi'), []); }
  function setTransaksi(id, list) { return tulis(getKey(id, 'transaksi'), list); }

  function getInputan(id) { return baca(getKey(id, 'inputan'), []); }
  function setInputan(id, list) { return tulis(getKey(id, 'inputan'), list); }

  /* ---------------- Master produk ---------------- */
  function getProducts() {
    const p = baca(K_PRODUCTS, null);
    if (!p) { tulis(K_PRODUCTS, CONTOH_PRODUK); return CONTOH_PRODUK.slice(); }
    return p;
  }
  function setProducts(list) { return tulis(K_PRODUCTS, list); }

  function upsertProduct(prod) {
    const list = getProducts();
    // Normalize kode to uppercase for consistent storage and comparison
    const normKode = String(prod.kode || '').trim().toUpperCase();
    const i = list.findIndex((p) => p.kode.toUpperCase() === normKode);
    const payload = Object.assign({}, prod, { kode: normKode });
    if (i >= 0) list[i] = Object.assign({}, list[i], payload);
    else list.push(payload);
    setProducts(list);
    return list;
  }

  function findProduct(kode) {
    return getProducts().find((p) => p.kode.toUpperCase() === String(kode).toUpperCase()) || null;
  }

  /* ---------------- Ekspor ---------------- */
  function unduhCSV(namaFile, rows) {
    const esc = (v) => {
      const s = String(v == null ? '' : v);
      // Per RFC 4180: bungkus dengan kutip jika mengandung koma, newline, atau kutip
      if (/[",\n\r]/.test(s)) {
        return '"' + s.replace(/"/g, '""') + '"';
      }
      return s;
    };
    // Gunakan koma (standar CSV RFC 4180) agar kompatibel dengan Excel dan tools lain
    const csv = rows.map((r) => r.map(esc).join(',')).join('\r\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = namaFile;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  global.Store = {
    CEK_DEFAULT,
    baca, tulis, uid,
    getEvents, setEvents, buatEvent, updateEvent, hapusEvent,
    getActiveId, setActiveId, getActiveEvent,
    getStokAwal, setStokAwal,
    getCek, setCek,
    getTransaksi, setTransaksi,
    getInputan, setInputan,
    getProducts, setProducts, upsertProduct, findProduct,
    unduhCSV,
  };
})(window);
