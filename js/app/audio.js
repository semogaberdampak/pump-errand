/* ============================================================
   app/audio.js — Umpan balik bunyi + getar untuk mesin kasir.
   Bunyi dibuat dengan Web Audio API (tanpa berkas audio, tanpa
   jaringan) supaya tetap berbunyi saat offline.

   Jenis: 'ok' (masuk keranjang), 'stok' (melebihi stok),
          'gagal' (kode tidak ditemukan), 'klik' (tombol ringan).
   Catatan: iOS mematikan bunyi saat sakelar senyap aktif — getar
   tetap berjalan, dan bunyi baru hidup setelah sentuhan pertama.
   ============================================================ */
(function (App) {
  'use strict';

  let ctx = null;

  function ambilKonteks() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try { ctx = new AC(); } catch (e) { ctx = null; }
    return ctx;
  }

  // Browser (iOS, Chrome) hanya mengizinkan suara setelah ada interaksi pengguna.
  function bangunkan() {
    const c = ambilKonteks();
    if (c && c.state === 'suspended' && typeof c.resume === 'function') {
      try { c.resume().catch(function () { /* diabaikan */ }); } catch (e) { /* diabaikan */ }
    }
  }

  function nada(c, freq, tunda, durasi) {
    const t0 = c.currentTime + tunda / 1000;
    const t1 = t0 + durasi / 1000;
    const osc = c.createOscillator();
    const vol = c.createGain();
    osc.type = 'square'; // lebih jelas di speaker HP kecil daripada gelombang sinus
    osc.frequency.setValueAtTime(freq, t0);
    vol.gain.setValueAtTime(0, t0);
    vol.gain.linearRampToValueAtTime(0.12, t0 + 0.01);
    vol.gain.exponentialRampToValueAtTime(0.0001, t1);
    osc.connect(vol);
    vol.connect(c.destination);
    osc.start(t0);
    osc.stop(t1 + 0.02);
  }

  // [frekuensi Hz, tunda ms, durasi ms] + pola getar (ms atau larik pola)
  const POLA = {
    ok: { nada: [[880, 0, 70], [1320, 80, 70]], getar: 45 },
    stok: { nada: [[640, 0, 110], [520, 130, 110]], getar: [40, 60, 40] },
    gagal: { nada: [[300, 0, 110], [220, 130, 150]], getar: [90, 60, 90] },
    klik: { nada: [[1046, 0, 45]], getar: 20 },
  };

  function getar(pola) {
    try { if (navigator.vibrate) navigator.vibrate(pola); } catch (e) { /* perangkat tanpa getar */ }
  }

  function mainkan(jenis) {
    const pola = POLA[jenis] || POLA.ok;
    const c = ambilKonteks();
    if (c && c.state === 'suspended') bangunkan();
    if (c && c.state !== 'closed') {
      try { pola.nada.forEach((n) => nada(c, n[0], n[1], n[2])); } catch (e) { /* bunyi opsional */ }
    }
    getar(pola.getar);
    return !!(c && c.state === 'running');
  }

  App.suara = {
    bangunkan,
    mainkan,
    getar,
    aktif: () => !!(ctx && ctx.state === 'running'),
  };

  // Buka izin audio pada sentuhan/ketukan pertama, bukan menunggu sampai scan.
  ['pointerdown', 'keydown', 'touchstart'].forEach((ev) =>
    window.addEventListener(ev, bangunkan, { passive: true, once: true })
  );
})(window.App = window.App || {});
