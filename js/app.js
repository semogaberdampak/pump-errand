/* ============================================================
   app.js — Bootstrap. Memuat modul sesi lebih dulu, lalu
   menyalakan aplikasi: tunggu penyimpanan siap, pulihkan sesi,
   pasang scan gun, shortcut papan tombol, dan sinkron otomatis.

   Urutan muat (index.html):
     core → audio → auth → home → persiapan → pameran →
     penginputan → admin → app.js
   ============================================================ */
(function (App) {
  'use strict';
  const { $, terapkanTheme, isiDbUrl, pulihSesi, tutupModal, toggleTheme } = App;
  const { Store, Sync } = window;

  document.addEventListener('DOMContentLoaded', async function () {
    // Sinkronkan posisi slider tema tanpa animasi
    terapkanTheme(document.documentElement.getAttribute('data-theme') === 'dark', false);
    isiDbUrl(); // URL proyek Supabase (dikunci di js/supabase.js) pada halaman Admin, hanya-baca

    // Data disimpan di IndexedDB: tunggu termuat ke memori sebelum layar dirender,
    // supaya pameran & transaksi tidak tampak kosong sesaat setelah aplikasi dibuka.
    if (Store.siap) { try { await Store.siap; } catch (e) { console.warn('Muat penyimpanan gagal:', e); } }

    pulihSesi(); // gate RBAC + auto logout + pulihkan pameran aktif & halaman terakhir
    if (App.pasangScanGun) App.pasangScanGun(); // scan gun (keyboard wedge) bekerja tanpa fokus ke kolom cari

    // Shortcut: "/" fokus ke kolom cari, Esc tutup modal, Ctrl+Shift+T tema, Ctrl+Shift+L logout
    document.addEventListener('keydown', function (e) {
      if (e.key === '/' && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) {
        if (document.querySelector('#scr-pameran.active')) { e.preventDefault(); $('pmCari').focus(); }
      }
      if (e.key === 'Escape') {
        $('pmHasilCari').style.display = 'none';
        tutupModal();
      }
      if (e.ctrlKey && e.shiftKey && e.key === 'T') {
        e.preventDefault();
        toggleTheme();
      }
      if (e.ctrlKey && e.shiftKey && e.key === 'L') {
        e.preventDefault();
        window.keluarLogin();
      }
    });

    // Sinkron transaksi: render ulang saat antrean/data berubah; tarik data berkala saat layar Pameran terbuka
    Sync.onUbah(function () {
      if (App.renderSyncBar) App.renderSyncBar();
      if (document.querySelector('#scr-pameran.active') && App.state.evtId && App.renderRiwayatTransaksi) App.renderRiwayatTransaksi();
    });
    Sync.onTick = function () {
      if (document.querySelector('#scr-pameran.active')) return Sync.tarik(Store.getActiveEvent());
    };
    Sync.mulaiOtomatis();

    // Klik luar modal menutup
    $('modalUmum').addEventListener('click', function (e) {
      if (e.target === this) tutupModal();
    });
  });
})(window.App = window.App || {});
