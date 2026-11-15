/* ============================================================
   app/admin.js — Halaman Admin: status koneksi, uji database,
   URL proyek, dan daftar pengguna POS (hanya-baca).
   ============================================================ */
(function (App) {
  'use strict';
  const { $, esc, toast } = App;
  const { Store, DB } = window;

  /* ================= HALAMAN ADMIN ================= */
  function catatLog(txt) {
    const box = $('admLog');
    if (box.textContent === '(belum ada aktivitas)' || box.textContent === '(log dibersihkan)') box.textContent = '';
    box.textContent = Store.waktuWIB(Date.now(), true) + ' ▸ ' + txt + '\n' + box.textContent;
  }

  function isiDbUrl() {
    const el = $('dbUrl');
    if (!el) return;
    const u = DB.getUrl() || '';
    const ringkas = u.replace(/^https:\/\//, '');
    el.textContent = ringkas.length > 46 ? ringkas.slice(0, 30) + '…' + ringkas.slice(-12) : ringkas;
    el.title = u;
  }

  window.salinDbUrl = async function () {
    try { await navigator.clipboard.writeText(DB.getUrl()); toast('URL disalin', 'ok'); }
    catch (e) { toast('Tidak bisa menyalin — salin manual dari js/supabase.js', 'error'); }
  };

  // Status koneksi: idle | loading | ok | bad
  function setStatusKoneksi(state, teks) {
    const el = $('admStatus');
    if (!el) return;
    el.setAttribute('data-state', state);
    $('admStatusTeks').textContent = teks;
  }

  window.tesKoneksi = async function () {
    const btn = $('btnTesKoneksi');
    btn.disabled = true;
    setStatusKoneksi('loading', 'Menguji…');
    catatLog('ping…');
    const t0 = Date.now();
    try {
      const d = await DB.runTest('ping');
      const ms = Date.now() - t0;
      setStatusKoneksi('ok', 'Terhubung · ' + ms + ' ms');
      catatLog('OK (' + ms + ' ms): ' + JSON.stringify(d));
      toast('Koneksi OK', 'ok');
    } catch (e) {
      setStatusKoneksi('bad', e.jaringan ? 'Tidak ada koneksi' : 'Gagal');
      catatLog('GAGAL: ' + e.message);
      toast('Koneksi gagal: ' + e.message, 'error');
    } finally { btn.disabled = false; }
  };

  window.jalanTes = async function (nama) {
    catatLog('test ' + nama + '…');
    try { const d = await DB.runTest(nama); catatLog(JSON.stringify(d, null, 1)); toast('Tes selesai', 'ok'); }
    catch (e) { catatLog('GAGAL: ' + e.message); toast('Tes gagal', 'error'); }
  };

  window.bersihkanLog = function () { $('admLog').textContent = '(log dibersihkan)'; };

  window.muaiUsers = async function () {
    const ul = $('admUserList');
    ul.innerHTML = '<li class="hint-text">Memuat…</li>';
    try {
      const users = await DB.listUsers();
      $('admJumlah').textContent = users.length;
      if (admStatusIdle()) setStatusKoneksi('ok', 'Terhubung');
      // Akun & cabang dikelola di aplikasi POS — di sini hanya ditampilkan.
      ul.innerHTML = users.map((u) => `
        <li class="user-row">
          <div style="min-width:0"><span class="user-cabang">${esc(u.cabang)}</span><span class="user-email">${esc(u.nama ? u.nama + ' · ' : '')}${esc(u.email)}</span></div>
          <span class="chip chip-role">${esc(u.role)}${u.aktif === false ? ' · nonaktif' : ''}</span>
        </li>`).join('') || '<li class="hint-text">Belum ada pengguna POS.</li>';
    } catch (e) {
      $('admJumlah').textContent = '0';
      setStatusKoneksi('bad', e.jaringan ? 'Tidak ada koneksi' : 'Gagal');
      ul.innerHTML = '<li class="hint-text">Gagal memuat: ' + esc(e.message) + '</li>';
    }
  };
  const admStatusIdle = () => $('admStatus').getAttribute('data-state') !== 'loading';


  App.isiDbUrl = isiDbUrl;
  App.muaiUsers = window.muaiUsers;
  App.catatLog = catatLog;
})(window.App = window.App || {});
