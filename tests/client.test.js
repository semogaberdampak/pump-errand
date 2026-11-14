/* ============================================================
   client.test.js — Menguji js/supabase.js tanpa jaringan:
   login lewat Supabase Auth (akun POS), JWT untuk RPC, perpanjangan
   token, dan pemetaan galat. `fetch` dipalsukan per URL.
   ============================================================ */
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const KODE = fs.readFileSync(path.join(__dirname, '..', 'js', 'supabase.js'), 'utf8');

const URL_UJI = 'https://proyek-uji.supabase.co';
const KEY_UJI = 'anon-key-uji';

let panggilan = [];
let simpanan = {};

global.localStorage = {
  getItem: (k) => (k in simpanan ? simpanan[k] : null),
  setItem: (k, v) => { simpanan[k] = String(v); },
  removeItem: (k) => { delete simpanan[k]; },
};

// Nilai konstanta diganti apa pun isinya, supaya tes tidak bergantung pada
// kredensial sungguhan yang sudah diisi di js/supabase.js.
function muatKlien({ url = URL_UJI, key = KEY_UJI } = {}) {
  const kode = KODE
    .replace(/const SUPABASE_URL = '[^']*';/, `const SUPABASE_URL = '${url}';`)
    .replace(/const SUPABASE_ANON_KEY = '[^']*';/, `const SUPABASE_ANON_KEY = '${key}';`);
  assert.ok(kode.includes(`const SUPABASE_URL = '${url}';`), 'konstanta SUPABASE_URL tidak ditemukan');
  assert.ok(kode.includes(`const SUPABASE_ANON_KEY = '${key}';`), 'konstanta SUPABASE_ANON_KEY tidak ditemukan');
  const win = {};
  new Function('window', kode)(win);
  return win.DB;
}

function jawab(status, isi) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof isi === 'string' ? isi : JSON.stringify(isi)),
  };
}

function pasangFetch(fn) {
  global.fetch = async (url, opt) => {
    panggilan.push({ url, opt: opt || {}, body: opt && opt.body ? JSON.parse(opt.body) : null });
    const r = await fn(url, opt || {}, panggilan.length);
    if (r instanceof Error) throw r;
    return r;
  };
}

const PROFIL = { id: 'u-1', email: 'kasir.a@pos.id', nama: 'Kasir A', cabang: 'Cabang A', role: 'USER' };

beforeEach(() => {
  panggilan = [];
  simpanan = {};
});

test('login memakai Supabase Auth lalu mengambil profil POS', async () => {
  const DB = muatKlien();
  pasangFetch((url) => {
    if (url.includes('/auth/v1/token?grant_type=password')) {
      return jawab(200, { access_token: 'AT1', refresh_token: 'RT1', expires_in: 3600 });
    }
    if (url.includes('/rest/v1/rpc/pameran_rpc_call')) return jawab(200, PROFIL);
    throw new Error('URL tak terduga: ' + url);
  });

  const user = await DB.login(' kasir.a@pos.id ', 'sandi-pos');
  assert.equal(user.email, 'kasir.a@pos.id');
  assert.equal(user.cabang, 'Cabang A');
  assert.equal(user.role, 'USER');

  assert.equal(panggilan[0].url, URL_UJI + '/auth/v1/token?grant_type=password');
  assert.equal(panggilan[0].body.email, 'kasir.a@pos.id', 'email dirapikan');
  assert.equal(panggilan[0].body.password, 'sandi-pos');
  assert.equal(panggilan[0].opt.headers.apikey, KEY_UJI);

  // Identitas TIDAK dikirim klien: server membacanya dari JWT.
  assert.equal(panggilan[1].body.p_action, 'profilSaya');
  assert.deepEqual(panggilan[1].body.p_payload, {});
  assert.equal(panggilan[1].opt.headers.Authorization, 'Bearer AT1');

  const s = DB.getSession();
  assert.equal(s.access, 'AT1');
  assert.equal(s.refresh, 'RT1');
  assert.equal(s.user.nama, 'Kasir A');
  assert.ok(s.exp > Date.now(), 'masa berlaku token disimpan');
});

test('sandi salah memberi pesan Indonesia dan tidak menyimpan sesi', async () => {
  const DB = muatKlien();
  pasangFetch(() => jawab(400, { error: 'invalid_grant', error_description: 'Invalid login credentials' }));
  await assert.rejects(() => DB.login('a@x.id', 'salah'), /Email atau kata sandi salah/);
  assert.equal(DB.getSession(), null);
});

test('akun POS nonaktif menolak login dan membersihkan sesi', async () => {
  const DB = muatKlien();
  pasangFetch((url) => {
    if (url.includes('/auth/v1/token')) return jawab(200, { access_token: 'AT', refresh_token: 'RT', expires_in: 3600 });
    return jawab(400, { message: 'Akun dinonaktifkan', code: 'P0001' });
  });
  await assert.rejects(() => DB.login('nonaktif@pos.id', 'sandi'), /dinonaktifkan/);
  assert.equal(DB.getSession(), null);
});

test('panggilan RPC memakai JWT, bukan anon key', async () => {
  const DB = muatKlien();
  DB.setSession({ access: 'AT-RPC', refresh: 'RT', exp: Date.now() + 3600 * 1000, user: PROFIL });
  pasangFetch(() => jawab(200, { exact: null, hasil: [] }));

  await DB.cariMaster({ q: 'buku' });
  assert.equal(panggilan[0].url, URL_UJI + '/rest/v1/rpc/pameran_rpc_call');
  assert.equal(panggilan[0].opt.headers.Authorization, 'Bearer AT-RPC');
  assert.equal(panggilan[0].opt.headers.apikey, KEY_UJI);
  assert.deepEqual(panggilan[0].body, { p_action: 'cariMaster', p_payload: { q: 'buku' } });
});

test('token yang hampir kedaluwarsa diperpanjang sebelum RPC', async () => {
  const DB = muatKlien();
  DB.setSession({ access: 'LAMA', refresh: 'RT-LAMA', exp: Date.now() - 1000, user: PROFIL });
  pasangFetch((url) => {
    if (url.includes('grant_type=refresh_token')) return jawab(200, { access_token: 'BARU', expires_in: 3600 });
    return jawab(200, []);
  });

  await DB.getTransaksiPameran({ event: 'E', tgl: '2026-11-14' });
  assert.match(panggilan[0].url, /grant_type=refresh_token/);
  assert.equal(panggilan[0].body.refresh_token, 'RT-LAMA');
  assert.equal(panggilan[1].opt.headers.Authorization, 'Bearer BARU');
  assert.equal(DB.getSession().access, 'BARU');
  assert.equal(DB.getSession().refresh, 'RT-LAMA', 'refresh token lama tetap dipakai bila tidak dikirim ulang');
  assert.equal(DB.getSession().user.nama, 'Kasir A', 'profil tidak hilang saat perpanjangan');
});

test('401 dari server: token diperbarui lalu permintaan diulang sekali', async () => {
  const DB = muatKlien();
  DB.setSession({ access: 'BASI', refresh: 'RT', exp: Date.now() + 3600 * 1000, user: PROFIL });
  let rpcKe = 0;
  pasangFetch((url) => {
    if (url.includes('grant_type=refresh_token')) return jawab(200, { access_token: 'SEGAR', expires_in: 3600 });
    rpcKe += 1;
    if (rpcKe === 1) return jawab(401, { message: 'JWT expired', code: 'PGRST301' });
    return jawab(200, { ok: true });
  });

  const hasil = await DB.runTest('ping');
  assert.deepEqual(hasil, { ok: true });
  assert.equal(rpcKe, 2, 'RPC dicoba dua kali');
  const terakhir = panggilan[panggilan.length - 1];
  assert.equal(terakhir.opt.headers.Authorization, 'Bearer SEGAR');
});

test('perpanjangan gagal → sesi dibersihkan dan error auth', async () => {
  const DB = muatKlien();
  DB.setSession({ access: 'LAMA', refresh: 'RT-MATI', exp: Date.now() - 1000, user: PROFIL });
  pasangFetch(() => jawab(400, { error: 'invalid_grant' }));

  await assert.rejects(() => DB.listUsers(), (e) => e.auth === true && /Sesi kedaluwarsa/.test(e.message));
  assert.equal(DB.getSession(), null);
});

test('tanpa sesi, RPC langsung ditolak tanpa memanggil jaringan', async () => {
  const DB = muatKlien();
  pasangFetch(() => jawab(200, []));
  await assert.rejects(() => DB.listUsers(), /Sesi kedaluwarsa/);
  assert.equal(panggilan.length, 0);
});

test('galat aplikasi dari database menjadi Error biasa (bukan jaringan)', async () => {
  const DB = muatKlien();
  DB.setSession({ access: 'AT', refresh: 'RT', exp: Date.now() + 3600 * 1000, user: PROFIL });
  pasangFetch(() => jawab(400, { message: 'Kode BK-404 tidak ada di tabel master_produk', code: 'P0001' }));

  await assert.rejects(() => DB.simpanProdukPameran({ kode: 'BK-404' }), (e) => {
    assert.match(e.message, /tidak ada di tabel master_produk/);
    assert.equal(e.jaringan, undefined);
    return true;
  });
});

test('gangguan koneksi dan HTTP 5xx ditandai jaringan (aman dicoba ulang)', async () => {
  const DB = muatKlien();
  DB.setSession({ access: 'AT', refresh: 'RT', exp: Date.now() + 3600 * 1000, user: PROFIL });

  pasangFetch(() => new Error('ECONNRESET'));
  await assert.rejects(() => DB.cariMaster({ q: 'x' }), (e) => e.jaringan === true && /Tidak ada koneksi/.test(e.message));

  panggilan = [];
  pasangFetch(() => jawab(502, { message: 'Bad gateway' }));
  await assert.rejects(() => DB.cariMaster({ q: 'x' }), (e) => e.jaringan === true);
});

test('respons bukan JSON saat sukses dianggap jaringan', async () => {
  const DB = muatKlien();
  DB.setSession({ access: 'AT', refresh: 'RT', exp: Date.now() + 3600 * 1000, user: PROFIL });
  pasangFetch(() => jawab(200, '<html>gerbang kampus</html>'));
  await assert.rejects(() => DB.cariMaster({ q: 'x' }), (e) => e.jaringan === true && /bukan JSON/.test(e.message));
});

test('fungsi RPC yang belum terpasang memberi pesan jelas', async () => {
  const DB = muatKlien();
  DB.setSession({ access: 'AT', refresh: 'RT', exp: Date.now() + 3600 * 1000, user: PROFIL });
  pasangFetch(() => jawab(404, {
    message: 'Could not find the function public.pameran_rpc_call(p_action, p_payload) in the schema cache',
    code: 'PGRST202',
  }));
  await assert.rejects(() => DB.cariMaster({ q: 'x' }), /belum ada di Supabase.*schema\.sql/);
});

test('konfigurasi placeholder ditolak sebelum memanggil jaringan', async () => {
  const DB = muatKlien({ url: 'https://GANTI-PROYEK.supabase.co', key: 'GANTI_DENGAN_ANON_KEY' });
  pasangFetch(() => jawab(200, {}));
  await assert.rejects(() => DB.cariMaster({ q: 'x' }), /SUPABASE_URL di js\/supabase\.js belum diisi/);
  assert.equal(panggilan.length, 0);

  const DB2 = muatKlien({ key: '' });
  await assert.rejects(() => DB2.cariMaster({ q: 'x' }), /SUPABASE_ANON_KEY di js\/supabase\.js belum diisi/);
});

test('logout menghapus sesi lokal dan mencabut token di server', async () => {
  const DB = muatKlien();
  DB.setSession({ access: 'AT-KELUAR', refresh: 'RT', exp: Date.now() + 3600 * 1000, user: PROFIL });
  pasangFetch(() => jawab(204, ''));

  DB.logout();
  assert.equal(DB.getSession(), null);
  assert.equal(panggilan.length, 1);
  assert.equal(panggilan[0].url, URL_UJI + '/auth/v1/logout');
  assert.equal(panggilan[0].opt.keepalive, true);
  assert.equal(panggilan[0].opt.headers.Authorization, 'Bearer AT-KELUAR');
});
