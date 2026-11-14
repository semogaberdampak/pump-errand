/* ============================================================
   supabase.js — Klien Supabase (RBAC + database pameran)
   ------------------------------------------------------------
   Semua data (login/user/cabang, master produk, produk yang
   dibawa, transaksi pameran) dibaca & ditulis lewat SATU fungsi
   RPC: public.rpc_call(action, token, payload).

   Transport: POST JSON ke /rest/v1/rpc/rpc_call memakai anon key.
   Tabel ditutup RLS; otorisasi (sesi, peran, cabang) diperiksa
   di dalam fungsi SQL, jadi anon key tidak bisa dipakai untuk
   membaca data cabang lain secara langsung.

   Konfigurasi dikunci di kode (bukan dari ?db=, kolom input, atau
   localStorage) agar login tidak bisa dibelokkan ke backend palsu.
   Anon key memang terlihat di browser — itu normal untuk Supabase.
   ============================================================ */
(function (global) {
  'use strict';

  // Ganti dua nilai ini dengan milik proyek Supabase Anda
  // (Dashboard → Project Settings → API).
  const SUPABASE_URL = 'https://qgfzznvcrpcypujeimwl.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFnZnp6bnZjcnBjeXB1amVpbXdsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQ2NTIyMDcsImV4cCI6MjExMDIyODIwN30.zdfXzbiDkugEDVprcfXb9hM8jgR4kVueA5I7du-LmWQ';

  const K_SESSION = 'pameran.session';
  const K_URL_LAMA = 'pameran.gasUrl'; // kunci lama; dibersihkan otomatis
  const RPC_PATH = '/rest/v1/rpc/rpc_call';
  const URL_RE = /^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i;

  function getUrl() {
    try { localStorage.removeItem(K_URL_LAMA); } catch (e) { /* abaikan */ }
    return SUPABASE_URL.replace(/\/+$/, '');
  }

  function getSession() {
    try { return JSON.parse(localStorage.getItem(K_SESSION) || 'null'); }
    catch (e) { return null; }
  }
  function setSession(s) {
    if (s) localStorage.setItem(K_SESSION, JSON.stringify(s));
    else localStorage.removeItem(K_SESSION);
  }

  const gagalJaringan = (pesan) => { const e = new Error(pesan); e.jaringan = true; return e; };

  function cekKonfigurasi(url) {
    if (!URL_RE.test(url) || /GANTI-PROYEK/i.test(url)) {
      throw new Error('SUPABASE_URL di js/supabase.js belum diisi / tidak valid (contoh: https://xxxx.supabase.co).');
    }
    if (!SUPABASE_ANON_KEY || SUPABASE_ANON_KEY === 'GANTI_DENGAN_ANON_KEY') {
      throw new Error('SUPABASE_ANON_KEY di js/supabase.js belum diisi.');
    }
  }

  // Pesan galat dari PostgREST: {code, details, hint, message}
  function pesanGalat(json, status) {
    if (json && typeof json === 'object') {
      const m = json.message || json.error_description || (typeof json.error === 'string' ? json.error : '');
      if (m) return m;
      if (json.hint) return json.hint;
    }
    return 'HTTP ' + status + ' dari Supabase';
  }

  async function call(action, payload) {
    const url = getUrl();
    cekKonfigurasi(url);
    const token = (getSession() || {}).token || '';

    let res;
    try {
      res = await fetch(url + RPC_PATH, {
        method: 'POST',
        credentials: 'omit',
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_ANON_KEY,
          Authorization: 'Bearer ' + SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({ p_action: action, p_token: token, p_payload: payload || {} }),
      });
    } catch (e) {
      throw gagalJaringan('Tidak ada koneksi ke server');
    }

    let txt = '';
    try { txt = await res.text(); } catch (e) { throw gagalJaringan('Respons terputus'); }

    let json = null;
    if (txt) {
      try { json = JSON.parse(txt); }
      catch (e) {
        if (!res.ok) throw new Error('Respons bukan JSON (HTTP ' + res.status + '): ' + txt.slice(0, 120));
        throw gagalJaringan('Respons bukan JSON: ' + txt.slice(0, 120));
      }
    }

    if (!res.ok) {
      const pesan = pesanGalat(json, res.status);
      // 5xx = gangguan server sementara → aman dicoba ulang
      if (res.status >= 500) throw gagalJaringan(pesan);
      if (res.status === 401 || res.status === 403) {
        throw new Error('Supabase menolak anon key. Periksa SUPABASE_ANON_KEY di js/supabase.js.');
      }
      if (res.status === 404 || /Could not find the function/i.test(pesan)) {
        throw new Error('Fungsi rpc_call belum ada di Supabase. Jalankan supabase/schema.sql lalu coba lagi.');
      }
      const err = new Error(pesan);
      err.code = json && json.code;
      // Sesi kedaluwarsa: kata kunci sama dengan backend lama
      if (/kedaluwarsa|login ulang|expired|session/i.test(pesan)) {
        setSession(null);
        err.auth = true;
      }
      throw err;
    }

    // Kegagalan login dikirim sebagai {ok:false} agar penghitung percobaan di
    // server sempat ter-commit (RAISE akan me-rollback penghitung itu).
    if (json && json.ok === false) {
      const err = new Error(json.error || 'Gagal');
      if (/kedaluwarsa|login ulang|expired|session/i.test(err.message)) {
        setSession(null);
        err.auth = true;
      }
      throw err;
    }
    return json;
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
      // Cabut sesi di server (best-effort). keepalive: tetap terkirim walau halaman dimuat ulang.
      try {
        fetch(url + RPC_PATH, {
          method: 'POST',
          credentials: 'omit',
          keepalive: true,
          headers: {
            'Content-Type': 'application/json',
            apikey: SUPABASE_ANON_KEY,
            Authorization: 'Bearer ' + SUPABASE_ANON_KEY,
          },
          body: JSON.stringify({ p_action: 'logout', p_token: tok, p_payload: {} }),
        }).catch(() => {});
      } catch (e) { /* abaikan */ }
    }
  }

  /* ---------------- Admin: Cabang/User dinamis ---------------- */
  const listUsers = () => call('listUsers');
  const addUser = (u) => call('addUser', u);          // {email,nama,cabang,pass,role}
  const deleteUser = (email) => call('deleteUser', { email });
  const runTest = (name) => call('test', { name });   // ping | seedTest

  /* ---------------- Master produk ---------------- */
  const cariMaster = (p) => call('cariMaster', p);    // {q, exact?} → {exact, hasil[]}

  /* Persiapan & Pameran: master_produk → produk_pameran */
  const getProdukPameran = (p) => call('getProdukPameran', p);           // {event, tgl} → [{kode,isbn,nama,harga,jumlah}]
  const simpanProdukPameran = (p) => call('simpanProdukPameran', p);     // {event, tgl, kode, harga, jumlah}
  const hapusProdukPameran = (p) => call('hapusProdukPameran', p);       // {event, tgl, kode}

  /* Transaksi pameran */
  const getTransaksiPameran = (p) => call('getTransaksiPameran', p);               // {event, tgl} → [trx]
  const simpanTransaksiPameran = (p) => call('simpanTransaksiPameran', p);         // {event, tgl, trx} (idempotent per trx.id)
  const batalkanTransaksiPameran = (p) => call('batalkanTransaksiPameran', p);     // {event, tgl, id, alasan}

  global.DB = {
    getUrl, getSession, setSession, call,
    login, logout,
    listUsers, addUser, deleteUser, runTest,
    cariMaster,
    getProdukPameran, simpanProdukPameran, hapusProdukPameran,
    getTransaksiPameran, simpanTransaksiPameran, batalkanTransaksiPameran,
  };
})(window);
