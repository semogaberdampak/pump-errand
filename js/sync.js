/* ============================================================
   sync.js — Sinkron transaksi pameran ke Google Sheet
   ------------------------------------------------------------
   Offline-first: transaksi & pembatalan SELALU disimpan di
   perangkat lebih dulu, lalu dikirim lewat antrean. Antrean
   dikirim ulang otomatis (tiap 30 dtk, saat koneksi kembali,
   saat login, dan saat tombol Sinkron ditekan).

   Aman dikirim ulang: server memakai ID transaksi sebagai kunci
   (idempotent), jadi respons yang terputus tidak membuat dobel.

   Antrean: pameran.antrean = [{qid, aksi:'simpan'|'batal', evId,
   event, tgl, trxId, payload, gagal:null|"pesan galat"}]
   Status transaksi diturunkan dari antrean:
     lokal     → transaksi lama (sebelum fitur sinkron), tidak dikirim
     tertunda  → masih ada op menunggu
     gagal     → ditolak server (perlu dilihat)
     terkirim  → tidak ada op tersisa
   ============================================================ */
(function (global) {
  'use strict';

  const K_ANTREAN = 'pameran.antrean';
  const INTERVAL_MS = 30000;
  let jalan = false;
  let tarikJalan = false;
  let sesiHabis = false;
  let timer = null;
  let tick = 0;
  const pendengar = [];

  // Antrean hanya dikirim oleh akun pembuatnya: server mencatat user & cabang dari sesi yang mengirim
  const emailSaya = () => {
    const s = (global.GAS && GAS.getSession()) || {};
    return s.user && s.user.email ? String(s.user.email).toLowerCase() : '';
  };
  // Tanpa sesi sama sekali (mis. sesi habis) → tak ada "akun lain": antrean tetap dihitung agar lencana meminta login ulang
  const milikSaya = (o) => !o.pemilik || !emailSaya() || o.pemilik === emailSaya();

  const baca = () => Store.baca(K_ANTREAN, []);
  const tulis = (q) => Store.tulis(K_ANTREAN, q);

  function ringkas(evId) {
    const q = baca().filter((o) => !evId || o.evId === evId);
    return {
      menunggu: q.filter((o) => !o.gagal && milikSaya(o)).length,
      gagal: q.filter((o) => o.gagal && milikSaya(o)).length,
      lain: q.filter((o) => !milikSaya(o)).length,
      offline: typeof navigator !== 'undefined' && navigator.onLine === false,
      sesiHabis,
    };
  }

  function umumkan(perubahan) {
    pendengar.forEach((fn) => { try { fn(perubahan || {}); } catch (e) { console.warn(e); } });
  }
  function onUbah(fn) { pendengar.push(fn); }

  function statusTrx(evId, t) {
    if (!t.sinkron) return 'lokal';
    const ops = baca().filter((o) => o.evId === evId && o.trxId === t.id);
    if (ops.some((o) => o.gagal)) return 'gagal';
    return ops.length ? 'tertunda' : 'terkirim';
  }

  function tambah(op) {
    const q = baca();
    q.push(Object.assign({ qid: Store.uid(), dibuat: new Date().toISOString(), gagal: null, pemilik: emailSaya() }, op));
    tulis(q);
    umumkan();
  }

  function ubahOp(qid, fn) {
    const q = baca();
    const o = q.find((x) => x.qid === qid);
    if (!o) return;
    fn(o);
    tulis(q);
  }
  function buangOp(qid) { tulis(baca().filter((o) => o.qid !== qid)); }

  // Kirim antrean berurutan (FIFO). Berhenti bila koneksi/sesi bermasalah.
  async function flush() {
    if (jalan) return;
    if (!baca().some((o) => !o.gagal && milikSaya(o))) { umumkan(); return; }
    if (!GAS.getSession()) { sesiHabis = true; umumkan(); return; }
    jalan = true;
    sesiHabis = false;
    try {
      const antre = baca().filter((o) => !o.gagal && milikSaya(o));
      for (const op of antre) {
        try {
          if (op.aksi === 'simpan') {
            await GAS.simpanTransaksiPameran({ event: op.event, tgl: op.tgl, trx: op.payload.trx });
          } else {
            await GAS.batalkanTransaksiPameran({ event: op.event, tgl: op.tgl, id: op.payload.id, alasan: op.payload.alasan });
          }
          buangOp(op.qid);
          umumkan();
        } catch (err) {
          if (err.jaringan) break;                    // koneksi bermasalah → coba lagi nanti
          if (err.auth) { sesiHabis = true; break; }  // login ulang dulu
          ubahOp(op.qid, (o) => { o.gagal = err.message || 'Ditolak server'; }); // galat permanen: tandai, lanjut
          umumkan();
        }
      }
    } finally {
      jalan = false;
      umumkan();
    }
  }

  // Ambil transaksi terbaru dari sheet (perangkat lain, status batal) dan gabungkan ke data lokal.
  async function tarik(ev) {
    if (!ev || tarikJalan || !GAS.getSession()) return false;
    tarikJalan = true;
    const mulai = Date.now();
    try {
      const server = await GAS.getTransaksiPameran({ event: ev.nama, tgl: ev.tglMulai });
      const tertunda = new Set(baca().filter((o) => o.evId === ev.id).map((o) => o.trxId));
      const list = Store.getTransaksi(ev.id);
      let berubah = false;
      server.forEach((s) => {
        const l = list.find((x) => x.id === s.id);
        if (!l) {
          list.push(Object.assign({}, s, { kasir: String(s.kasirEmail || '').split('@')[0], sinkron: true }));
          berubah = true;
          return;
        }
        // Data lokal yang masih menunggu kirim / baru diubah di sini menang atas data server
        if (tertunda.has(s.id) || (l.diubahLokal && l.diubahLokal > mulai)) return;
        if (!!l.deleted !== !!s.deleted) { l.deleted = !!s.deleted; l.batal = s.batal; berubah = true; }
        if (!l.sinkron) { l.sinkron = true; berubah = true; }
      });
      if (berubah) { Store.setTransaksi(ev.id, list); umumkan({ data: true }); }
      return true;
    } catch (err) {
      console.warn('Tarik transaksi gagal:', err.message);
      if (err.auth) { sesiHabis = true; umumkan(); }
      return false;
    } finally {
      tarikJalan = false;
    }
  }

  function daftar(evId) { return baca().filter((o) => o.evId === evId); }
  function cobaLagi(qid) { ubahOp(qid, (o) => { o.gagal = null; }); umumkan(); return flush(); }
  function buang(qid) { buangOp(qid); umumkan(); }
  function buangEvent(evId) { tulis(baca().filter((o) => o.evId !== evId)); umumkan(); }

  function mulaiOtomatis() {
    if (timer) return;
    timer = setInterval(async () => {
      tick++;
      await flush();
      if (tick % 2 === 0 && typeof Sync.onTick === 'function') await Sync.onTick();
    }, INTERVAL_MS);
    if (typeof window !== 'undefined') {
      window.addEventListener('online', async () => { umumkan(); await flush(); if (Sync.onTick) await Sync.onTick(); });
      window.addEventListener('offline', () => umumkan());
    }
  }

  const Sync = { tambah, flush, tarik, ringkas, statusTrx, onUbah, daftar, cobaLagi, buang, buangEvent, mulaiOtomatis, onTick: null };
  global.Sync = Sync;
})(window);
