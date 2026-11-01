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
    // err.jaringan = true → gangguan koneksi/server (aman dicoba ulang); selain itu galat dari aplikasi
    const gagalJaringan = (pesan) => { const e = new Error(pesan); e.jaringan = true; return e; };
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        credentials: 'omit',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: body.toString(),
      });
    } catch (e) { throw gagalJaringan('Tidak ada koneksi ke server'); }
    if (!res.ok) throw gagalJaringan('HTTP ' + res.status + ' dari Apps Script');
    let txt;
    try { txt = await res.text(); } catch (e) { throw gagalJaringan('Respons terputus'); }
    let json;
    try { json = JSON.parse(txt); }
    catch (e) { throw gagalJaringan('Respons bukan JSON (cek deploy /exec): ' + txt.slice(0, 120)); }
    // Cek kedaluwarsa sesi dengan kata kunci (lebih robust dari regex prefix yang rapuh)
    const sesiHabis = !json.ok && /kedaluwarsa|login ulang|expired|session/i.test(json.error || '');
    if (sesiHabis) setSession(null);
    if (!json.ok) { const err = new Error(json.error || 'Gagal'); err.code = json.code; err.auth = sesiHabis; throw err; }
    return json.data;
  }

  /* ---------------- Auth (RBAC) ---------------- */
  async function login(email, pass) {
    const d = await call('login', { email, pass });
    setSession(d.session);
    return d.user; // {email, nama, cabang, role}
  }
  function logout() {
    const tok = (getSession() || {}).token;
    setSession(null);
    const url = getUrl();
    if (tok && URL_RE.test(url) && typeof fetch === 'function') {
      // Cabut sesi di server (best-effort). keepalive: tetap terkirim walau halaman langsung dimuat ulang.
      try {
        fetch(url, {
          method: 'POST', credentials: 'omit', keepalive: true,
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: new URLSearchParams({ action: 'logout', token: tok, payload: '{}' }).toString(),
        }).catch(() => {});
      } catch (e) { /* abaikan */ }
    }
  }

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

  /* Persiapan & Pameran: sheet Master → sheet produk_pameran_<tanggal> */
  const cariMaster = (p) => call('cariMaster', p);                       // {q, exact?} → {exact, hasil[]}
  const getProdukPameran = (p) => call('getProdukPameran', p);           // {event, tgl} → [{kode,isbn,nama,harga,jumlah}]
  const simpanProdukPameran = (p) => call('simpanProdukPameran', p);     // {event, tgl, kode, harga, jumlah}
  const hapusProdukPameran = (p) => call('hapusProdukPameran', p);       // {event, tgl, kode}

  /* Transaksi pameran → sheet transaksi_pameran_<tanggal> */
  const getTransaksiPameran = (p) => call('getTransaksiPameran', p);               // {event, tgl} → [trx]
  const simpanTransaksiPameran = (p) => call('simpanTransaksiPameran', p);         // {event, tgl, trx} (idempotent per trx.id)
  const batalkanTransaksiPameran = (p) => call('batalkanTransaksiPameran', p);     // {event, tgl, id, alasan}

  global.GAS = {
    getUrl, getSession, setSession, call,
    login, logout,
    listUsers, addUser, deleteUser, runTest, clearLog,
    getMasterProduk, savePrepScan, getPrepScans,
    saveTransaksi, getTransaksiList, tutupSetoran,
    saveInputan, saveRekap,
    cariMaster, getProdukPameran, simpanProdukPameran, hapusProdukPameran,
    getTransaksiPameran, simpanTransaksiPameran, batalkanTransaksiPameran,
  };
})(window);
