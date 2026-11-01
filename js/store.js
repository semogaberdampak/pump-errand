/* ============================================================
   store.js — Lapisan penyimpanan data (localStorage) untuk
   aplikasi Pencatatan pameran.
   Semua data dinormalisasi per EVENT (pameran) agar bisa
   menjalankan beberapa pameran sekaligus tanpa saling menimpa.

   Kunci storage:
     pameran.events        → daftar event
     pameran.active        → id event yang sedang dibuka
     pameran.products      → master produk global
     pameran.<id>.stokawal    → (lama) stok awal per produk
     pameran.<id>.produkpameran → produk yang dibawa {kode,isbn,nama,harga,jumlah} (cache sheet produk_pameran_<tgl>)
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

  /* ---------------- Waktu WIB (Asia/Jakarta, UTC+7) ----------------
     Seluruh tampilan & penentuan "hari ini" memakai WIB, apa pun zona waktu perangkat. */
  const ZONA = 'Asia/Jakarta';
  const bagianWIB = (d) => {
    const dt = new Date(d == null ? Date.now() : d);
    if (isNaN(dt.getTime())) return null;
    const o = {};
    new Intl.DateTimeFormat('en-GB', { timeZone: ZONA, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
      .formatToParts(dt).forEach((p) => { o[p.type] = p.value; });
    return o;
  };
  function tglWIB(d) { const o = bagianWIB(d); return o ? o.year + '-' + o.month + '-' + o.day : ''; }          // YYYY-MM-DD
  function jamWIB(d) { const o = bagianWIB(d); return o ? o.hour + ':' + o.minute + ' WIB' : '—'; }              // 14:05 WIB
  function waktuWIB(d, detik) {                                                                                  // 31/10/2026 14:05 WIB
    const o = bagianWIB(d);
    return o ? o.day + '/' + o.month + '/' + o.year + ' ' + o.hour + ':' + o.minute + (detik ? ':' + o.second : '') + ' WIB' : '—';
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  /* ---------------- Event / pameran ---------------- */
  function getEvents() { return baca(K_EVENTS, []); }
  function setEvents(list) { return tulis(K_EVENTS, list); }

  function buatEvent(nama, tanggal, catatan) {
    const list = getEvents();
    const today = tglWIB();
    const ev = {
      id: uid(),
      nama: (nama || '').trim() || 'pameran ' + tglWIB(),
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
    tulis(PREFIX + ev.id + '.produkpameran', []);
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
    ['stokawal', 'produkpameran', 'cek', 'transaksi', 'inputan'].forEach((k) =>
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

  // Ubah satu transaksi secara atomik (baca-ubah-tulis sinkron)
  function ubahTransaksi(id, trxId, fn) {
    const list = getTransaksi(id);
    const t = list.find((x) => x.id === trxId);
    if (!t) return null;
    fn(t);
    setTransaksi(id, list);
    return t;
  }

  function getInputan(id) { return baca(getKey(id, 'inputan'), []); }
  function setInputan(id, list) { return tulis(getKey(id, 'inputan'), list); }

  /* ---------------- Produk yang dibawa ke pameran (hasil sesi Persiapan) ---------------- */
  const normKode = (s) => String(s == null ? '' : s).replace(/[^0-9A-Za-z]/g, '').toUpperCase();

  function getProdukPameran(id) { return baca(getKey(id, 'produkpameran'), []); }
  function setProdukPameran(id, list) { return tulis(getKey(id, 'produkpameran'), list); }
  function upsertProdukPameran(id, prod) {
    const list = getProdukPameran(id);
    const i = list.findIndex((p) => normKode(p.kode) === normKode(prod.kode));
    if (i >= 0) list[i] = Object.assign({}, list[i], prod);
    else list.push(prod);
    setProdukPameran(id, list);
    return list;
  }
  function hapusProdukPameranLokal(id, kode) {
    const list = getProdukPameran(id).filter((p) => normKode(p.kode) !== normKode(kode));
    setProdukPameran(id, list);
    return list;
  }
  // Cocokkan hasil scan / ketikan dengan kode ATAU ISBN (abaikan tanda hubung & huruf besar-kecil)
  function findProdukPameran(id, teks) {
    const n = normKode(teks);
    if (!n) return null;
    return getProdukPameran(id).find((p) => normKode(p.kode) === n || (p.isbn && normKode(p.isbn) === n)) || null;
  }

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
    baca, tulis, uid, tglWIB, jamWIB, waktuWIB,
    getEvents, setEvents, buatEvent, updateEvent, hapusEvent,
    getActiveId, setActiveId, getActiveEvent,
    getStokAwal, setStokAwal,
    getCek, setCek,
    getTransaksi, setTransaksi, ubahTransaksi,
    getInputan, setInputan,
    getProducts, setProducts, upsertProduct, findProduct,
    getProdukPameran, setProdukPameran, upsertProdukPameran, hapusProdukPameranLokal, findProdukPameran, normKode,
    unduhCSV,
  };
})(window);
