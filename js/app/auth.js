/* ============================================================
   app/auth.js — Login/logout, RBAC, pemulihan sesi, dan keluar
   otomatis setelah 1 jam tanpa aktivitas.
   ============================================================ */
(function (App) {
  'use strict';
  const S = App.state;
  // renderHome sengaja dipanggil lewat App: modul home dimuat setelah modul ini.
  const { $, toast, showModalBox, goScreen, SCREENS } = App;
  const { Store, DB, Sync } = window;

  /* ================= AUTH / RBAC (via Supabase) ================= */

  function tampilkanApp(user) {
    S.user = user;
    $('scr-login').classList.remove('active');
    // Add logged-in class to show navigation bar
    document.body.classList.add('logged-in');
    const navAdmin = $('navAdminBtn');
    if (navAdmin) navAdmin.style.display = user.role === 'ADMIN' ? '' : 'none';
    const chip = $('admRoleChip');
    if (chip) chip.textContent = user.role;
    App.isiDbUrl();
    $('homeEventInfo').textContent = user.cabang + ' · ' + user.nama;
    goScreen('home');
    catatAktivitas();
    mulaiPemantauIdle();
    Sync.flush(); // kirim antrean yang tertinggal (mis. saat sesi sebelumnya habis / offline)
  }

  window.aksiLogin = async function (e) {
    e.preventDefault();
    const btn = $('btnLogin');
    btn.disabled = true; btn.textContent = 'Memeriksa…';
    try {
      const user = await DB.login($('loginEmail').value.trim(), $('loginPass').value);
      toast('Halo, ' + (user.nama || user.email));
      tampilkanApp(user);
    } catch (err) {
      toast('Login gagal: ' + err.message, 'error');
    } finally {
      btn.disabled = false; btn.textContent = 'Masuk';
    }
    return false;
  };

  window.keluarLogin = function () {
    try { localStorage.removeItem(K_AKTIF); localStorage.removeItem(K_LAYAR); } catch (e) { /* abaikan */ }
    DB.logout();
    location.reload();
  };

  /* ================= SESI: AUTO LOGOUT (idle 1 jam) & PULIH HALAMAN ================= */
  let aktifTerakhir = Date.now();
  let tulisAktifPada = 0;
  let timerIdle = null;
  let peringatanIdle = false;

  function catatAktivitas() {
    const kini = Date.now();
    aktifTerakhir = kini;
    if (kini - tulisAktifPada > 5000) {      // dibagikan antar tab lewat localStorage (maks. 1× per 5 dtk)
      tulisAktifPada = kini;
      try { localStorage.setItem(K_AKTIF, String(kini)); } catch (e) { /* abaikan */ }
    }
    if (peringatanIdle) { peringatanIdle = false; tutupModal(); } // beraktivitas → peringatan ditutup
  }

  function terakhirAktif() {
    let t = aktifTerakhir;
    try { t = Math.max(t, Number(localStorage.getItem(K_AKTIF)) || 0); } catch (e) { /* abaikan */ }
    return t;
  }

  function periksaIdle() {
    if (!S.user) return;
    const idle = Date.now() - terakhirAktif();
    if (idle >= BATAS_IDLE_MS) { akhiriSesiIdle(true); return; }
    const sisa = BATAS_IDLE_MS - idle;
    if (sisa <= PERINGATAN_MS) {
      const detik = Math.ceil(sisa / 1000);
      if (!peringatanIdle) {
        peringatanIdle = true;
        showModalBox('Masih di sini?', `<p>Tidak ada aktivitas. Anda akan <strong>keluar otomatis</strong> dalam <strong id="idleSisa">${detik}</strong> detik.</p>
          <p class="rekap-note">Data yang belum tersinkron tetap aman di perangkat.</p>`,
          '<button class="btn btn-primary btn-block" onclick="tetapMasuk()">Tetap masuk</button>');
      } else {
        const el = $('idleSisa');
        if (el) el.textContent = detik;
      }
    }
  }
  window.periksaIdle = periksaIdle;
  window.tetapMasuk = function () { catatAktivitas(); };

  function mulaiPemantauIdle() {
    if (timerIdle) return;
    ['pointerdown', 'keydown', 'touchstart', 'wheel', 'scroll', 'input'].forEach((ev) =>
      window.addEventListener(ev, catatAktivitas, { passive: true, capture: true }));
    document.addEventListener('visibilitychange', () => { if (!document.hidden) periksaIdle(); }); // HP baru dibuka lagi
    timerIdle = setInterval(periksaIdle, 5000);
  }

  function tampilkanPesanLogin() {
    let pesan = '';
    try { pesan = localStorage.getItem(K_PESAN) || ''; localStorage.removeItem(K_PESAN); } catch (e) { /* abaikan */ }
    const el = $('loginPesan');
    if (!el) return;
    el.textContent = pesan;
    el.style.display = pesan ? '' : 'none';
  }

  // Keluar otomatis: cabut sesi (juga di server). Data & antrean sinkron tetap di perangkat.
  function akhiriSesiIdle(muatUlang) {
    try {
      localStorage.setItem(K_PESAN, 'Anda keluar otomatis karena tidak aktif selama 1 jam. Data yang belum tersinkron tetap aman di perangkat dan terkirim setelah Anda masuk lagi.');
      localStorage.removeItem(K_AKTIF);
    } catch (e) { /* abaikan */ }
    DB.logout();
    if (muatUlang) { location.reload(); return; }
    S.user = null;
    document.body.classList.remove('logged-in');
    SCREENS.forEach((sc) => { const el = $('scr-' + sc); if (el) el.classList.toggle('active', sc === 'login'); });
    tampilkanPesanLogin();
  }

  // Dipanggil saat halaman dimuat: periksa sesi, pulihkan pameran aktif & halaman terakhir
  function pulihSesi() {
    const s = DB.getSession();
    let layarPulih = null;
    if (s && s.user) {
      let t = 0;
      try { t = Number(localStorage.getItem(K_AKTIF)) || 0; } catch (e) { /* abaikan */ }
      if (t && Date.now() - t >= BATAS_IDLE_MS) { akhiriSesiIdle(false); }   // ditinggal >1 jam (mis. HP dimatikan)
      else {
        try { layarPulih = JSON.parse(localStorage.getItem(K_LAYAR) || 'null'); } catch (e) { layarPulih = null; }
        tampilkanApp(s.user);
      }
    } else {
      $('scr-login').classList.add('active');
      tampilkanPesanLogin();
    }

    // Restore event aktif
    const id = Store.getActiveId();
    if (id && Store.getEvents().some((e) => e.id === id)) {
      evtId = id;
      const ev = Store.getActiveEvent();
      $('homeEventInfo').textContent = ev.nama + ' · ' + ev.tanggal;
    }
    App.renderHome();

    // Pulihkan halaman terakhir (hanya bila masih sah: Admin untuk /admin, pameran aktif untuk sesi pameran)
    if (layarPulih && S.user && SCREENS.includes(layarPulih) && layarPulih !== 'login' && layarPulih !== 'home') {
      const perluEvent = ['persiapan', 'pameran', 'penginputan'].includes(layarPulih);
      if ((layarPulih !== 'admin' || App.isAdmin()) && (!perluEvent || S.evtId)) goScreen(layarPulih);
    }
  }
  window.pulihSesi = pulihSesi;

  App.pulihSesi = pulihSesi;
  App.tampilkanApp = tampilkanApp;
  App.catatAktivitas = catatAktivitas;
})(window.App = window.App || {});
