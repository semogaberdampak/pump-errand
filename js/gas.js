/* ============================================================
   gas.js — Klien Google Apps Script (RBAC + database sheet)
   ------------------------------------------------------------
   Semua data (login/user/cabang, master produk, hasil scan
   persiapan, transaksi pameran) dikirim ke SATU spreadsheet
   melalui Web App Apps Script. Nama sheet data mengikuti pola:
     <JudulEvent>_<YYYY-MM-DD>_<Cabang>
   Tidak ada data dummy di sisi klien.

   Transport: POST body-encoded (text/plain) agar tidak kena
   CORS preflight; respons dibaca sebagai text lalu JSON.parse.
   ============================================================ */
(function (global) {
  'use strict';

  const K_URL = 'pameran.gasUrl'; // kunci lama; dibersihkan otomatis
  // URL Web App dikunci di kode (bukan dari ?gas=, kolom input, atau localStorage)
  // agar login tidak bisa dibelokkan ke backend palsu. Ganti nilai ini hanya bila
  // Anda membuat deployment baru, lalu naikkan versi cache di sw.js.
  const PINNED_URL = 'https://script.google.com/macros/s/AKfycbxHG3JWApQ0nkC_4m45hnO8gM-k8EwqOtqWrYJLP9Ag-YpXj-6gs8XRDBCtO0zCfmOG/exec';
  const K_SESSION = 'pameran.session';

  const URL_RE = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/;

  function getUrl() {
    try { localStorage.removeItem(K_URL); } catch (e) { /* abaikan */ }
    return PINNED_URL;
  }

  function getSession() {
    try { return JSON.parse(localStorage.getItem(K_SESSION) || 'null'); }
    catch (e) { return null; }
  }
  function setSession(s) {
    if (s) localStorage.setItem(K_SESSION, JSON.stringify(s));
    else localStorage.removeItem(K_SESSION);
  }

  let seq = 0;
  async function call(action, payload) {
    const url = getUrl();
    if (!URL_RE.test(url)) throw new Error('PINNED_URL di js/gas.js belum diisi / tidak valid.');
    const token = (getSession() || {}).token || '';
    const body = new URLSearchParams({
      action,
      token,
      reqId: 'r' + Date.now().toString(36) + (++seq),
      payload: JSON.stringify(payload || {}),
    });
    const res = await fetch(url, {
      method: 'POST',
      credentials: 'omit',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: body.toString(),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' dari Apps Script');
    const txt = await res.text();
    let json;
    try { json = JSON.parse(txt); }
    catch (e) { throw new Error('Respons bukan JSON (cek deploy /exec): ' + txt.slice(0, 120)); }
    if (!json.ok && /^Sesi kedaluwarsa/.test(json.error || '')) setSession(null);
    if (!json.ok) { const err = new Error(json.error || 'Gagal'); err.code = json.code; throw err; }
    return json.data;
  }

  /* ---------------- Auth (RBAC) ---------------- */
  async function login(email, pass) {
    const d = await call('login', { email, pass });
    setSession(d.session);
    return d.user; // {email, nama, cabang, role}
  }
  function logout() { setSession(null); }

  /* ---------------- Admin: Cabang/User dinamis ---------------- */
  const listUsers = () => call('listUsers');
  const addUser = (u) => call('addUser', u);          // {email,nama,cabang,pass,role}
  const deleteUser = (email) => call('deleteUser', { email });
  const runTest = (name) => call('test', { name });   // ping | seedTest
  const clearLog = () => call('clearLog');

  /* ---------------- Data pameran ---------------- */
  const getMasterProduk = () => call('getMasterProduk');       // sheet MasterProduk
  const savePrepScan = (p) => call('savePrepScan', p);         // → sheet <Event>_<Tgl>_<Cabang>
  const getPrepScans = (p) => call('getPrepScans', p);
  const saveTransaksi = (p) => call('saveTransaksi', p);       // + baris Transaksi global
  const getTransaksiList = (p) => call('getTransaksiList', p);
  const tutupSetoran = (p) => call('tutupSetoran', p);
  const saveInputan = (p) => call('saveInputan', p);           // finalisasi penginputan
  const saveRekap = (p) => call('saveRekap', p);               // rekap akhir

  global.GAS = {
    getUrl, getSession, setSession, call,
    login, logout,
    listUsers, addUser, deleteUser, runTest, clearLog,
    getMasterProduk, savePrepScan, getPrepScans,
    saveTransaksi, getTransaksiList, tutupSetoran,
    saveInputan, saveRekap,
  };
})(window);
