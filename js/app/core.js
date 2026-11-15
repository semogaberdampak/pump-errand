/* ============================================================
   app/core.js — Inti aplikasi: state bersama, utilitas, navigasi
   layar, tema, dan helper yang dipakai semua modul sesi.
   Dimuat paling awal; modul lain berbagi objek App yang sama.
   ============================================================ */
(function (App) {
  'use strict';

  const THEME_KEY = 'pameran.theme';
  // Bila js/sync.js gagal dimuat, aplikasi tetap hidup dan memberi peringatan jelas (tidak diam-diam kehilangan data)
  const Sync = window.Sync || {
    _stub: true, tambah() {}, flush: async () => {}, tarik: async () => false, onUbah() {}, onTick: null, mulaiOtomatis() {},
    ringkas: () => ({ menunggu: 0, gagal: 0, offline: false, sesiHabis: false }), statusTrx: () => 'lokal',
    daftar: () => [], cobaLagi: async () => {}, buang() {}, buangEvent() {},
  };
  // State bersama seluruh sesi. Ditulis sebagai objek supaya modul lain
  // membaca/mengubah nilai yang SAMA (bukan salinan hasil destructuring).
  const S = {
    evtId: null,          // id event aktif
    keranjang: [],        // item transaksi yang belum disimpan
    produkTerpilih: null, // produk yang dipilih pada form tambah ke keranjang
    trxAktif: false,      // panel "Transaksi Baru" sedang terbuka
    koreksiDari: null,    // id transaksi yang sedang dikoreksi (bila ada)
    kandidatScan: [],     // hasil scan yang menunggu dimasukkan; {p, pilih, n}
    user: null,           // {email, nama, cabang, role}
  };

  /* ---------------- Util ---------------- */
  const $ = (id) => document.getElementById(id);
  const isAdmin = () => !!(S.user && S.user.role === 'ADMIN');

  // Sesi, aktivitas, dan halaman terakhir (disimpan di perangkat)
  const K_AKTIF = 'pameran.aktifTerakhir';     // cap waktu aktivitas terakhir
  const K_LAYAR = 'pameran.layar';             // halaman terakhir (dipulihkan saat dimuat ulang)
  const K_PESAN = 'pameran.pesanLogin';        // pesan di layar login setelah keluar otomatis
  const BATAS_IDLE_MS = 60 * 60 * 1000;        // keluar otomatis setelah 1 jam TANPA aktivitas
  const PERINGATAN_MS = 60 * 1000;             // peringatan 60 detik sebelum keluar

  function rupiah(n) {
    return 'Rp ' + Number(n || 0).toLocaleString('id-ID');
  }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  window.toast = function (pesan, jenis) {
    const area = $('toastArea');
    if (!area) return;
    const t = document.createElement('div');
    t.className = 'toast' + (jenis ? ' ' + jenis : '');
    t.textContent = pesan;
    area.appendChild(t);
    setTimeout(() => t.remove(), 2600);
  };

  function showModalBox(judul, isiHtml, tombolHtml) {
    $('modalJudul').textContent = judul;
    $('modalIsi').innerHTML = isiHtml;
    $('modalKaki').innerHTML = tombolHtml ||
      '<button class="btn btn-primary btn-block" onclick="tutupModal()">Tutup</button>';
    $('modalUmum').classList.add('open');
  }
  window.tutupModal = function () {
    $('modalUmum').classList.remove('open');
    if (window.Scanner) Scanner.lanjut(); // modal ditutup → pemindaian boleh lanjut
  };

  /* ---------------- Navigasi layar ---------------- */
  const panggil = (nama, ...arg) => {
    if (typeof App[nama] !== 'function') { console.warn('Modul belum termuat: ' + nama); return undefined; }
    return App[nama](...arg);
  };
  const SCREENS = ['login', 'home', 'persiapan', 'pameran', 'penginputan', 'admin'];
  window.goScreen = function (nama) {
    if (nama === 'admin') {
      const s = DB.getSession();
      if (!s || !s.user || s.user.role !== 'ADMIN') { toast('Khusus Admin', 'error'); return; }
    }
    if (window.Scanner && Scanner.sedangBuka()) Scanner.tutup();
    SCREENS.forEach((sc) => {
      const el = $('scr-' + sc);
      if (el) el.classList.toggle('active', sc === nama);
    });
    document.querySelectorAll('.seg-nav button[data-screen]').forEach((b) => {
      b.classList.toggle('aktif', b.dataset.screen === nama);
    });
    // Modul sesi dimuat setelah core, jadi dipanggil lewat App saat runtime.
    // panggil() menjaga aplikasi tetap hidup bila satu modul gagal dimuat.
    if (nama === 'persiapan') { panggil('renderPersiapan'); panggil('syncProdukPameran', false); }
    if (nama === 'pameran') { panggil('renderPameran'); panggil('syncProdukPameran', true); panggil('sinkronTransaksi', true); }
    if (nama === 'penginputan') panggil('renderPenginputan');
    if (nama === 'admin') panggil('muaiUsers');
    if (S.user && nama !== 'login') Store.tulis(K_LAYAR, nama);   // state halaman
    window.scrollTo({ top: 0 });
  };

  /* ---------------- Tema ---------------- */
  function terapkanTheme(dark, animasi) {
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    try { localStorage.setItem(THEME_KEY, dark ? 'dark' : 'light'); } catch (e) {}
    const tb = document.getElementById('themeToggle');
    if (tb) {
      tb.setAttribute('aria-checked', dark ? 'true' : 'false');
      if (animasi) { tb.classList.remove('tt-spin'); void tb.offsetWidth; tb.classList.add('tt-spin'); }
    }
  }
  window.toggleTheme = function () {
    const dark = document.documentElement.getAttribute('data-theme') !== 'dark';
    terapkanTheme(dark, true);
  };

  // Initialize theme on page load (before DOMContentLoaded to avoid flash)
  (function () {
    try {
      const savedTheme = localStorage.getItem('pameran.theme');
      if (savedTheme === 'dark') {
        document.documentElement.setAttribute('data-theme', 'dark');
      }
    } catch (e) {}
  })();

  function butuhEvent() {
    if (!S.evtId || !Store.getActiveEvent()) {
      window.toast('Buka pameran dulu dari beranda', 'err');
      App.goScreen('home');
      App.renderHome();
      return false;
    }
    return true;
  }

  function produkEvent() { return S.evtId ? Store.getProdukPameran(S.evtId) : []; }
  const kodePendek = (id) => String(id).slice(-6).toUpperCase();
  function updateBadgeNav() {
    const b = $('badgePameran');
    const n = S.keranjang.length;
    b.style.display = n ? '' : 'none';
    b.textContent = n;
  }

  /* ---- Dipakai lintas modul (satu sumber, bukan salinan) ---- */
  Object.assign(App, {
    state: S,
    Sync,
    SCREENS,
    $, esc, rupiah, toast: window.toast,
    showModalBox, tutupModal,
    goScreen, toggleTheme, terapkanTheme,
    butuhEvent, produkEvent, kodePendek, updateBadgeNav, isAdmin,
  });
})(window.App = window.App || {});
