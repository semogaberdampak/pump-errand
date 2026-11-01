/* ============================================================
   scanner.js — Overlay kamera untuk scan barcode / QR produk
   ------------------------------------------------------------
   Memakai html5-qrcode (vendor/html5-qrcode.min.js, tanpa CDN
   agar tetap jalan offline). Kamera hanya jalan di HTTPS atau
   localhost. Selalu ada kolom ketik manual sebagai cadangan.

   Pemakaian:
     Scanner.buka({
       judul, petunjuk,
       onKode: async (teks, sumber) => { ...; return true|false; }
     });                       // sumber: 'kamera' | 'manual'
   Bila onKode mengembalikan true, pemindaian ditahan sampai
   Scanner.lanjut() dipanggil (mis. saat modal ditutup).
   Selain itu pemindaian otomatis lanjut.
   ============================================================ */
(function (global) {
  'use strict';

  const DEBOUNCE_MS = 1500; // kode yang sama dalam jeda ini diabaikan
  let qr = null;
  let aktif = false;
  let sibuk = false;
  let onKode = null;
  let kodeTerakhir = '';
  let waktuTerakhir = 0;

  const $ = (id) => document.getElementById(id);

  function pesan(teks) { const el = $('scanPesan'); if (el) el.textContent = teks || ''; }

  async function terima(teks, sumber) {
    teks = String(teks || '').trim();
    if (!aktif || !teks || sibuk || !onKode) return;
    const kini = Date.now();
    if (teks === kodeTerakhir && kini - waktuTerakhir < DEBOUNCE_MS) return;
    kodeTerakhir = teks;
    waktuTerakhir = kini;
    const info = $('scanTerakhir');
    if (info) info.textContent = 'Terbaca: ' + teks;
    sibuk = true;
    if (sumber === 'kamera') { try { navigator.vibrate && navigator.vibrate(60); } catch (e) { /* abaikan */ } }
    try {
      const tahan = await onKode(teks, sumber);
      if (!tahan) sibuk = false;
    } catch (err) {
      sibuk = false;
      if (global.toast) global.toast((err && err.message) || 'Gagal memproses kode', 'error');
    }
  }

  async function buka(opsi) {
    opsi = opsi || {};
    onKode = opsi.onKode || null;
    sibuk = false;
    kodeTerakhir = '';
    waktuTerakhir = 0;
    aktif = true;
    $('scanJudul').textContent = opsi.judul || 'Scan produk';
    $('scanPetunjuk').textContent = opsi.petunjuk || '';
    $('scanManual').value = '';
    pesan('');
    $('scanTerakhir').textContent = '';
    $('scanOverlay').classList.add('open');
    $('scanOverlay').style.display = 'block';  // inline: tetap benar walau CSS lama masih ter-cache
    document.body.classList.add('scan-open');

    if (typeof Html5Qrcode === 'undefined') {
      pesan('Library scanner belum termuat. Gunakan kolom ketik di bawah.');
      return;
    }
    try {
      const fmt = global.Html5QrcodeSupportedFormats;
      const cfg = { verbose: false, experimentalFeatures: { useBarCodeDetectorIfSupported: true } };
      if (fmt) {
        cfg.formatsToSupport = [fmt.QR_CODE, fmt.EAN_13, fmt.EAN_8, fmt.UPC_A, fmt.UPC_E,
                                fmt.CODE_128, fmt.CODE_39, fmt.ITF];
      }
      qr = new Html5Qrcode('scanReader', cfg);
      await qr.start(
        { facingMode: 'environment' },
        {
          fps: 10,
          // Kotak lebar agar barcode 1D (EAN-13 pada buku) ikut terbaca, bukan hanya QR
          qrbox: (w, h) => ({ width: Math.floor(Math.min(w * 0.9, 420)), height: Math.floor(Math.min(h * 0.5, 220)) }),
        },
        (teks) => { terima(teks, 'kamera'); },
        () => { /* frame tanpa kode: abaikan */ }
      );
    } catch (err) {
      qr = null;
      pesan('Kamera tidak bisa dibuka (' + ((err && err.message) || err) + '). Gunakan kolom ketik di bawah.');
    }
  }

  async function tutup() {
    aktif = false;
    sibuk = false;
    onKode = null;
    const el = $('scanOverlay');
    if (el) { el.classList.remove('open'); el.style.display = 'none'; }
    document.body.classList.remove('scan-open');
    if (qr) {
      const q = qr;
      qr = null;
      try { await q.stop(); } catch (e) { /* belum berjalan */ }
      try { q.clear(); } catch (e) { /* abaikan */ }
    }
  }

  function lanjut() { if (aktif) sibuk = false; }

  function kirimManual() {
    const inp = $('scanManual');
    const teks = (inp.value || '').trim();
    if (!teks) return;
    inp.value = '';
    kodeTerakhir = ''; // ketikan manual selalu diproses
    terima(teks, 'manual');
  }

  global.Scanner = { buka, tutup, lanjut, kirimManual, sedangBuka: () => aktif };
})(window);
