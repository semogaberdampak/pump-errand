/* ============================================================
   supabase.js — Klien Supabase proyek POS (login POS + data pameran)
   ------------------------------------------------------------
   Login memakai akun aplikasi POS (Supabase Auth):

     POST /auth/v1/token?grant_type=password  → access_token (JWT)

   Semua data pameran dibaca & ditulis lewat SATU fungsi RPC:

     POST /rest/v1/rpc/pameran_rpc_call  { p_action, p_payload }
     Authorization: Bearer <access_token>

   Server mengenali pengguna dari JWT itu (auth.uid → public.profiles)
   lalu mengambil nama, cabang, dan peran dari tabel POS. Klien tidak
   pernah mengirim identitas sendiri, jadi tidak bisa mengaku akun lain.

   Tabel pameran ditutup RLS; role `anon` (kunci publik) tidak bisa
   membaca/menulis apa pun.

   Konfigurasi dikunci di kode (bukan dari ?db=, kolom input, atau
   localStorage) agar login tidak bisa dibelokkan ke backend palsu.
   Anon key memang terlihat di browser — itu normal untuk Supabase.
   ============================================================ */
(function (global) {
  'use strict';

  // Proyek Supabase aplikasi POS (Dashboard → Project Settings → API).
  const SUPABASE_URL = 'https://koerpzbwkfejfrhervxa.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtvZXJwemJ3a2ZlamZyaGVydnhhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI2Mjk4NTQsImV4cCI6MjEwODIwNTg1NH0.fbSVOSd1h8LGbn6R4guu9YAz9d6_7dLzMP5bDSkrCks';

  const K_SESSION = 'pameran.session';
  const K_URL_LAMA = 'pameran.gasUrl'; // kunci lama; dibersihkan otomatis

  const AUTH_TOKEN = '/auth/v1/token?grant_type=';
  const AUTH_LOGOUT = '/auth/v1/logout';
  const RPC_PATH = '/rest/v1/rpc/pameran_rpc_call';
  const URL_RE = /^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i;
  const REFRESH_LEBIH_AWAL_MS = 60 * 1000; // perbarui token 1 menit sebelum kedaluwarsa

  function getUrl() {
    try { localStorage.removeItem(K_URL_LAMA); } catch (e) { /* abaikan */ }
    return SUPABASE_URL.replace(/\/+$/, '');
  }

  /* Sesi disimpan lokal: { access, refresh, exp, user }
     user = {email, nama, cabang, role} — bentuknya sama seperti dulu. */
  function getSession() {
    try { return JSON.parse(localStorage.getItem(K_SESSION) || 'null'); }
    catch (e) { return null; }
  }
  function setSession(s) {
    if (s) localStorage.setItem(K_SESSION, JSON.stringify(s));
    else localStorage.removeItem(K_SESSION);
  }

  const gagalJaringan = (pesan) => { const e = new Error(pesan); e.jaringan = true; return e; };
  const gagalSesi = () => {
    setSession(null);
    const e = new Error('Sesi kedaluwarsa, silakan login ulang');
    e.auth = true;
    return e;
  };

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
      if (m && m !== 'Invalid login credentials') return m;
      if (json.hint) return json.hint;
    }
    return 'HTTP ' + status + ' dari Supabase';
  }

  async function bacaJson(res) {
    let txt = '';
    try { txt = await res.text(); } catch (e) { throw gagalJaringan('Respons terputus'); }
    if (!txt) return null;
    try { return JSON.parse(txt); }
    catch (e) {
      if (!res.ok) throw new Error('Respons bukan JSON (HTTP ' + res.status + '): ' + txt.slice(0, 120));
      throw gagalJaringan('Respons bukan JSON: ' + txt.slice(0, 120));
    }
  }

  /* ---------------- Supabase Auth (akun POS) ---------------- */
  async function authPost(path, body) {
    const url = getUrl();
    cekKonfigurasi(url);
    let res;
    try {
      res = await fetch(url + path, {
        method: 'POST',
        credentials: 'omit',
        headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw gagalJaringan('Tidak ada koneksi ke server');
    }
    const json = await bacaJson(res);
    if (!res.ok) {
      if (res.status >= 500) throw gagalJaringan(pesanGalat(json, res.status));
      if (res.status === 429) throw new Error('Terlalu banyak percobaan masuk. Coba lagi beberapa saat lagi.');
      if (res.status === 400 || res.status === 401) throw new Error('Email atau kata sandi salah');
      throw new Error(pesanGalat(json, res.status));
    }
    if (!json || !json.access_token) throw gagalJaringan('Respons login tidak dikenali');
    return json;
  }

  function simpanToken(d) {
    const lama = getSession() || {};
    setSession({
      access: d.access_token,
      refresh: d.refresh_token || lama.refresh || '',
      exp: Date.now() + (Number(d.expires_in) || 3600) * 1000,
      user: lama.user || null,
    });
  }

  // Kembalikan access token yang masih berlaku (perbarui bila hampir habis).
  async function pastikanToken(paksa) {
    const s = getSession();
    if (!s || !s.access) return '';
    const hampirHabis = !s.exp || Date.now() > s.exp - REFRESH_LEBIH_AWAL_MS;
    if (paksa || hampirHabis) {
      if (!s.refresh) { setSession(null); return ''; }
      try {
        simpanToken(await authPost(AUTH_TOKEN + 'refresh_token', { refresh_token: s.refresh }));
      } catch (e) {
        if (e.jaringan) throw e;
        setSession(null);
        return '';
      }
    }
    return (getSession() || {}).access || '';
  }

  function kirimRpc(url, token, action, payload) {
    return fetch(url + RPC_PATH, {
      method: 'POST',
      credentials: 'omit',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_ANON_KEY,
        Authorization: 'Bearer ' + token,
      },
      body: JSON.stringify({ p_action: action, p_payload: payload || {} }),
    });
  }

  async function call(action, payload) {
    const url = getUrl();
    cekKonfigurasi(url);
    let token = await pastikanToken(false);
    if (!token) throw gagalSesi();

    let res;
    try {
      res = await kirimRpc(url, token, action, payload);
      // Token kedaluwarsa di tengah jalan (mis. perangkat tidur) → perbarui sekali.
      if (res.status === 401) {
        const baru = await pastikanToken(true);
        if (!baru) throw gagalSesi();
        res = await kirimRpc(url, baru, action, payload);
        if (res.status === 401) throw gagalSesi();
      }
    } catch (e) {
      if (e.auth || e.jaringan) throw e;
      throw gagalJaringan('Tidak ada koneksi ke server');
    }

    const json = await bacaJson(res);
    if (!res.ok) {
      const pesan = pesanGalat(json, res.status);
      if (res.status >= 500) throw gagalJaringan(pesan);
      if (res.status === 404 || /Could not find the function/i.test(pesan)) {
        throw new Error('Fungsi pameran_rpc_call belum ada di Supabase. Jalankan supabase/schema.sql lalu coba lagi.');
      }
      if (res.status === 403 || /permission denied for schema/i.test(pesan)) {
        throw new Error('Akses ditolak. Pastikan schema.sql versi terbaru sudah dijalankan di proyek POS.');
      }
      if (res.status === 401) throw gagalSesi();
      const err = new Error(pesan);
      err.code = json && json.code;
      if (/kedaluwarsa|login ulang|expired|session/i.test(pesan)) Object.assign(err, gagalSesi(), { message: pesan });
      throw err;
    }
    return json;
  }

  /* ---------------- Login / keluar ---------------- */
  async function login(email, pass) {
    const d = await authPost(AUTH_TOKEN + 'password', { email: String(email || '').trim(), password: pass });
    simpanToken(d);
    let profil;
    try {
      profil = await call('profilSaya');
    } catch (e) {
      setSession(null);
      throw e;
    }
    const s = getSession() || {};
    setSession(Object.assign({}, s, {
      user: { email: profil.email, nama: profil.nama, cabang: profil.cabang, role: profil.role },
    }));
    return getSession().user; // {email, nama, cabang, role}
  }

  function logout() {
    const s = getSession() || {};
    setSession(null);
    const url = getUrl();
    if (s.access && URL_RE.test(url) && typeof fetch === 'function') {
      // Cabut refresh token di server (best-effort). keepalive: tetap terkirim walau halaman dimuat ulang.
      try {
        fetch(url + AUTH_LOGOUT, {
          method: 'POST',
          credentials: 'omit',
          keepalive: true,
          headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + s.access },
          body: '{}',
        }).catch(() => {});
      } catch (e) { /* abaikan */ }
    }
  }

  /* ---------------- Admin: daftar pengguna POS (baca saja) ---------------- */
  const listUsers = () => call('listUsers');
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
    listUsers, runTest,
    cariMaster,
    getProdukPameran, simpanProdukPameran, hapusProdukPameran,
    getTransaksiPameran, simpanTransaksiPameran, batalkanTransaksiPameran,
  };
})(window);
