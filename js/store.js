/* ============================================================
   store.js — Lapisan penyimpanan data untuk aplikasi
   Pencatatan pameran. Semua data dinormalisasi per EVENT
   (pameran) agar bisa menjalankan beberapa pameran sekaligus
   tanpa saling menimpa.

   Media simpan: IndexedDB ("pameran-data") dengan cache di
   memori, sehingga Store.* tetap fungsi SINKRON seperti dulu.
   Bila IndexedDB tidak tersedia/gagal, otomatis memakai
   localStorage seperti versi sebelumnya.

   Kunci yang BUKAN milik Store (tema, sesi login, cap waktu
   idle, halaman terakhir) tetap di localStorage dan tidak ikut
   dipindahkan.

   Kunci storage:
     pameran.events        → daftar event
     pameran.active        → id event yang sedang dibuka
     pameran.products      → master produk global
     pameran.<id>.stokawal    → (lama) stok awal per produk
     pameran.<id>.produkpameran → produk yang dibawa {kode,isbn,nama,harga,jumlah} (cache tabel produk_pameran)
     pameran.<id>.cek         → checklist persiapan
     pameran.<id>.cekstatus   → status "Persiapan OK" (disimpan / dikoreksi)
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
  // Sumber kebenaran: tabel master_produk di Supabase (js/supabase.js).
  // Cache lokal hanya menampung hasil tarik terakhir dari server.
  const CONTOH_PRODUK = [];

  /* ---------------- Lapisan penyimpanan ----------------
     Alasan pindah dari localStorage: daftar transaksi tumbuh terus dan
     setiap penyimpanan menulis ulang seluruh daftar secara SINKRON
     (memblokir layar) serta terbatas ±5 MB. IndexedDB menulis di latar
     belakang tanpa batas seketat itu; bacaan dilayani dari cache memori.
     Nilai disimpan sebagai JSON string — bentuk yang sama persis dengan
     isi localStorage lama, sehingga migrasi cukup menyalin apa adanya. */
  const IDB_NAMA = 'pameran-data';
  const IDB_TABEL = 'kv';
  // Kunci milik modul lain (tetap di localStorage)
  const K_SETELAN = ['pameran.theme', 'pameran.session', 'pameran.gasUrl',
                     'pameran.aktifTerakhir', 'pameran.layar', 'pameran.pesanLogin'];
  const milikStore = (k) => typeof k === 'string' && k.indexOf(PREFIX) === 0 && K_SETELAN.indexOf(k) < 0;

  const mem = new Map();   // kunci → JSON string (isi disk terakhir)
  let disk = null;         // { semua, simpan, hapus } atau null (mode localStorage)
  let pernahLapor = false;

  // Sinkron antar-tab: tab lain yang menulis ikut memperbarui cache kita,
  // supaya tab lama tidak menimpa data transaksi yang lebih baru.
  const TAB = Math.random().toString(36).slice(2);
  let kanal = null;
  try { if (typeof global.BroadcastChannel !== 'undefined') kanal = new global.BroadcastChannel('pameran-data'); }
  catch (e) { kanal = null; }
  const kabariTab = (kunci, isi) => {
    if (!kanal) return;
    try { kanal.postMessage({ tab: TAB, k: kunci, s: isi }); } catch (e) { /* abaikan */ }
  };
  if (kanal) {
    kanal.onmessage = (e) => {
      const d = e.data;
      if (!d || d.tab === TAB || !milikStore(d.k)) return;
      if (d.s === null) mem.delete(d.k); else mem.set(d.k, d.s);
    };
  }

  function bukaIndexedDb() {
    if (!global.indexedDB) return Promise.resolve(null);
    return new Promise((selesai) => {
      let tuntas = false;
      const beres = (db) => { if (!tuntas) { tuntas = true; selesai(db); } };
      let req;
      try { req = global.indexedDB.open(IDB_NAMA, 1); } catch (e) { return selesai(null); }
      setTimeout(() => beres(null), 3000);   // jangan menahan aplikasi bila browser lambat
      req.onupgradeneeded = () => { try { req.result.createObjectStore(IDB_TABEL); } catch (e) { /* sudah ada */ } };
      req.onsuccess = () => { if (tuntas) { try { req.result.close(); } catch (e) {} } else beres(req.result); };
      req.onerror = () => beres(null);
      req.onblocked = () => beres(null);
    });
  }

  function buatDisk(db) {
    const tulisTx = (mode) => db.transaction(IDB_TABEL, mode).objectStore(IDB_TABEL);
    return {
      semua: () => new Promise((selesai, gagal) => {
        const hasil = [];
        let req;
        try { req = tulisTx('readonly').openCursor(); } catch (e) { return gagal(e); }
        req.onsuccess = () => {
          const c = req.result;
          if (c) { hasil.push([c.key, c.value]); c.continue(); } else selesai(hasil);
        };
        req.onerror = () => gagal(req.error);
      }),
      simpan: (kunci, isi) => new Promise((selesai, gagal) => {
        let tx;
        try { tx = db.transaction(IDB_TABEL, 'readwrite'); tx.objectStore(IDB_TABEL).put(isi, kunci); }
        catch (e) { return gagal(e); }
        tx.oncomplete = () => selesai(true);
        tx.onerror = () => gagal(tx.error);
        tx.onabort = () => gagal(tx.error || new Error('transaksi dibatalkan'));
      }),
      hapus: (kunci) => new Promise((selesai, gagal) => {
        let tx;
        try { tx = db.transaction(IDB_TABEL, 'readwrite'); tx.objectStore(IDB_TABEL).delete(kunci); }
        catch (e) { return gagal(e); }
        tx.oncomplete = () => selesai(true);
        tx.onerror = () => gagal(tx.error);
      }),
    };
  }

  function tulisLokal(kunci, isi) {
    try { localStorage.setItem(kunci, isi); return true; }
    catch (e) {
      console.error('store.tulis gagal:', kunci, e);
      global.toast && global.toast('Gagal menyimpan data (penyimpanan penuh?)', 'err');
      return false;
    }
  }

  // Muat semua data ke memori dari localStorage (dipakai bila tanpa IndexedDB)
  function hidrasiLokal() {
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && milikStore(k) && !mem.has(k)) {
          const s = localStorage.getItem(k);
          if (s !== null) mem.set(k, s);
        }
      }
    } catch (e) { console.error('store: gagal membaca localStorage', e); }
  }

  // Pindahkan data lama dari localStorage ke IndexedDB (sekali saja).
  // Penghapusan di localStorage hanya dilakukan setelah salinan di disk aman.
  async function pindahkanDariLokal() {
    const kunci = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && milikStore(k)) kunci.push(k);
      }
    } catch (e) { return; }

    const terhapus = [];
    for (const k of kunci) {
      try {
        if (!mem.has(k)) {
          const s = localStorage.getItem(k);
          if (s === null) continue;
          await disk.simpan(k, s);
          mem.set(k, s);
        }
        terhapus.push(k);
      } catch (e) { console.warn('store: gagal memindahkan', k, e); }
    }
    terhapus.forEach((k) => { try { localStorage.removeItem(k); } catch (e) { /* abaikan */ } });
    if (terhapus.length) console.info('store: ' + terhapus.length + ' kunci dipindahkan dari localStorage ke IndexedDB');
  }

  // Selesai = semua data sudah ada di memori; app.js menunggu ini sebelum render.
  const siap = (async () => {
    if (global.__storeDisk) disk = global.__storeDisk;            // dipakai tes
    else {
      const db = await bukaIndexedDb();
      if (db) disk = buatDisk(db);
    }
    if (!disk) { hidrasiLokal(); return; }
    try {
      (await disk.semua()).forEach(([k, s]) => { if (milikStore(k)) mem.set(k, s); });
      await pindahkanDariLokal();
    } catch (e) {
      console.warn('store: IndexedDB tidak bisa dipakai, memakai localStorage', e);
      disk = null;
      hidrasiLokal();
    }
  })();

  function baca(kunci, defaultVal) {
    const isi = mem.get(kunci);
    if (isi === undefined) return defaultVal;
    try { return JSON.parse(isi); }
    catch (e) { console.error('store.baca gagal:', kunci, e); return defaultVal; }
  }

  function tulis(kunci, nilai) {
    let isi;
    try { isi = JSON.stringify(nilai); }
    catch (e) { console.error('store.tulis gagal:', kunci, e); return false; }
    mem.set(kunci, isi);
    kabariTab(kunci, isi);
    if (!disk) return tulisLokal(kunci, isi);
    disk.simpan(kunci, isi).catch((e) => {
      console.warn('store: IndexedDB gagal menyimpan, beralih ke localStorage', e);
      disk = null;
      if (!pernahLapor) {
        pernahLapor = true;
        global.toast && global.toast('Penyimpanan cepat tidak tersedia — memakai penyimpanan lama', 'err');
      }
      tulisLokal(kunci, isi);
    });
    return true;
  }

  // Hapus satu kunci dari semua tempat (dipakai saat event dihapus)
  function hapus(kunci) {
    mem.delete(kunci);
    kabariTab(kunci, null);
    try { localStorage.removeItem(kunci); } catch (e) { /* abaikan */ }
    if (disk) disk.hapus(kunci).catch((e) => console.warn('store: gagal menghapus', kunci, e));
    return true;
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
    ['stokawal', 'produkpameran', 'cek', 'cekstatus', 'transaksi', 'inputan'].forEach((k) =>
      hapus(PREFIX + id + '.' + k)
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
  // Status "Persiapan OK": {tersimpan, waktu, oleh, dicentang, total, belum, revisi}; null = belum pernah disimpan
  function getCekStatus(id) { return baca(getKey(id, 'cekstatus'), null); }
  function setCekStatus(id, v) { return tulis(getKey(id, 'cekstatus'), v); }

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
    siap, hapus,
    baca, tulis, uid, tglWIB, jamWIB, waktuWIB,
    getEvents, setEvents, buatEvent, updateEvent, hapusEvent,
    getActiveId, setActiveId, getActiveEvent,
    getStokAwal, setStokAwal,
    getCek, setCek, getCekStatus, setCekStatus,
    getTransaksi, setTransaksi, ubahTransaksi,
    getInputan, setInputan,
    getProducts, setProducts, upsertProduct, findProduct,
    getProdukPameran, setProdukPameran, upsertProdukPameran, hapusProdukPameranLokal, findProdukPameran, normKode,
    unduhCSV,
  };
})(window);
