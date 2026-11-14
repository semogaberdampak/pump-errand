/* ============================================================
   client.test.js — Menguji js/supabase.js tanpa jaringan:
   bentuk request RPC, penyimpanan sesi, dan pemetaan galat
   (jaringan vs galat aplikasi vs sesi kedaluwarsa).
   ============================================================ */
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const KODE = fs.readFileSync(path.join(__dirname, '..', 'js', 'supabase.js'), 'utf8');
const URL_UJI = 'https://proyek-uji.supabase.co';
const KEY_UJI = 'kunci-anon-uji';

function buatLocalStorage() {
  const isi = new Map();
  return {
    getItem: (k) => (isi.has(k) ? isi.get(k) : null),
    setItem: (k, v) => isi.set(k, String(v)),
    removeItem: (k) => isi.delete(k),
    _isi: isi,
  };
}

function muatKlien({ url = URL_UJI, key = KEY_UJI, ganti = true } = {}) {
  let kode = KODE;
  if (ganti) {
    kode = kode
      .replace("const SUPABASE_URL = 'https://GANTI-PROYEK.supabase.co';",
        `const SUPABASE_URL = '${url}';`)
      .replace("const SUPABASE_ANON_KEY = 'GANTI_DENGAN_ANON_KEY';",
        `const SUPABASE_ANON_KEY = '${key}';`);
  }
  const win = {};
  // eslint-disable-next-line no-new-func
  new Function('window', kode)(win);
  return win.DB;
}

function respons(status, isi) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof isi === 'string' ? isi : JSON.stringify(isi)),
  };
}

let panggilan;
function pasangFetch(hasil) {
  panggilan = [];
  global.fetch = async (url, opt) => {
    panggilan.push({ url, opt, body: JSON.parse(opt.body) });
    if (hasil instanceof Error) throw hasil;
    return hasil;
  };
}

beforeEach(() => {
  global.localStorage = buatLocalStorage();
  pasangFetch(respons(200, { ok: true }));
});

test('panggilan RPC memakai URL, header, dan body yang benar', async () => {
  const DB = muatKlien();
  global.localStorage.setItem('pameran.session', JSON.stringify({ token: 'tok-123' }));
  pasangFetch(respons(200, { exact: null, hasil: [], total: 0 }));

  const hasil = await DB.cariMaster({ q: 'buku', exact: true });
  assert.deepEqual(hasil, { exact: null, hasil: [], total: 0 });

  assert.equal(panggilan.length, 1);
  const p = panggilan[0];
  assert.equal(p.url, URL_UJI + '/rest/v1/rpc/rpc_call');
  assert.equal(p.opt.method, 'POST');
  assert.equal(p.opt.headers.apikey, KEY_UJI);
  assert.equal(p.opt.headers.Authorization, 'Bearer ' + KEY_UJI);
  assert.equal(p.opt.headers['Content-Type'], 'application/json');
  assert.deepEqual(p.body, {
    p_action: 'cariMaster',
    p_token: 'tok-123',
    p_payload: { q: 'buku', exact: true },
  });
});

test('login menyimpan sesi dan mengirim token pada panggilan berikutnya', async () => {
  const DB = muatKlien();
  const user = { email: 'a@b.id', nama: 'A', cabang: 'Cabang A', role: 'USER' };
  pasangFetch(respons(200, { ok: true, user, session: { token: 'tok-baru', user } }));

  const hasil = await DB.login('a@b.id', 'sandi');
  assert.deepEqual(hasil, user);
  assert.deepEqual(DB.getSession(), { token: 'tok-baru', user });
  assert.equal(JSON.parse(localStorage.getItem('pameran.session')).token, 'tok-baru');

  pasangFetch(respons(200, []));
  await DB.getTransaksiPameran({ event: 'X', tgl: '2026-11-14' });
  assert.equal(panggilan[0].body.p_token, 'tok-baru');
});

test('galat aplikasi dari PostgREST menjadi Error biasa (bukan jaringan)', async () => {
  const DB = muatKlien();
  pasangFetch(respons(400, { code: 'P0001', message: 'Email atau kata sandi salah' }));
  await assert.rejects(() => DB.login('a@b.id', 'x'), (err) => {
    assert.equal(err.message, 'Email atau kata sandi salah');
    assert.equal(err.jaringan, undefined);
    assert.equal(err.auth, undefined);
    return true;
  });
});

test('kegagalan login {ok:false} tetap menjadi Error', async () => {
  const DB = muatKlien();
  pasangFetch(respons(200, { ok: false, error: 'Terlalu banyak percobaan. Coba lagi 15 menit lagi' }));
  await assert.rejects(() => DB.login('a@b.id', 'x'), /Terlalu banyak percobaan/);
});

test('gangguan koneksi ditandai jaringan (aman dicoba ulang)', async () => {
  const DB = muatKlien();
  pasangFetch(new TypeError('fetch failed'));
  await assert.rejects(() => DB.getProdukPameran({ event: 'X', tgl: '2026-11-14' }), (err) => {
    assert.equal(err.jaringan, true);
    return true;
  });
});

test('HTTP 5xx dianggap gangguan jaringan', async () => {
  const DB = muatKlien();
  pasangFetch(respons(503, { message: 'Service Unavailable' }));
  await assert.rejects(() => DB.listUsers(), (err) => {
    assert.equal(err.jaringan, true);
    return true;
  });
});

test('sesi kedaluwarsa menghapus sesi lokal dan menandai auth', async () => {
  const DB = muatKlien();
  global.localStorage.setItem('pameran.session', JSON.stringify({ token: 'lama' }));
  pasangFetch(respons(400, { message: 'Sesi kedaluwarsa, silakan login ulang' }));
  await assert.rejects(() => DB.listUsers(), (err) => {
    assert.equal(err.auth, true);
    return true;
  });
  assert.equal(DB.getSession(), null);
});

test('respons bukan JSON saat sukses dianggap jaringan', async () => {
  const DB = muatKlien();
  pasangFetch(respons(200, '<html>bukan json</html>'));
  await assert.rejects(() => DB.listUsers(), (err) => {
    assert.equal(err.jaringan, true);
    return true;
  });
});

test('fungsi rpc_call yang belum terpasang memberi pesan jelas', async () => {
  const DB = muatKlien();
  pasangFetch(respons(404, { message: 'Could not find the function public.rpc_call in the schema cache' }));
  await assert.rejects(() => DB.listUsers(), /Jalankan supabase\/schema\.sql/);
});

test('anon key ditolak memberi pesan konfigurasi', async () => {
  const DB = muatKlien();
  pasangFetch(respons(401, { message: 'Invalid API key' }));
  await assert.rejects(() => DB.listUsers(), /menolak anon key/);
});

test('konfigurasi placeholder ditolak sebelum memanggil jaringan', async () => {
  const DB = muatKlien({ ganti: false });
  pasangFetch(respons(200, {}));
  await assert.rejects(() => DB.listUsers(), /SUPABASE_URL di js\/supabase\.js belum diisi/);
  assert.equal(panggilan.length, 0);

  const DB2 = muatKlien({ key: '' });
  await assert.rejects(() => DB2.listUsers(), /SUPABASE_ANON_KEY di js\/supabase\.js belum diisi/);
});

test('logout menghapus sesi lokal dan mencabut token di server', async () => {
  const DB = muatKlien();
  global.localStorage.setItem('pameran.session', JSON.stringify({ token: 'tok-logout' }));
  pasangFetch(respons(200, { keluar: true }));

  DB.logout();
  assert.equal(DB.getSession(), null);
  assert.equal(panggilan.length, 1);
  assert.equal(panggilan[0].body.p_action, 'logout');
  assert.equal(panggilan[0].body.p_token, 'tok-logout');
  assert.equal(panggilan[0].opt.keepalive, true);
});
