/* ============================================================
   db.test.js — Menjalankan supabase/schema.sql di Postgres
   (WASM/PGlite) lalu menguji seluruh RPC: login, RBAC, cabang,
   master produk, produk pameran, transaksi, dan pembatalan.

   pgcrypto tidak tersedia di PGlite, jadi fungsi crypt/gen_salt
   diganti stub yang meniru perilaku bcrypt (hash bisa diverifikasi)
   hanya di dalam tes ini. Skema asli tetap memakai pgcrypto.
   ============================================================ */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA = fs
  .readFileSync(path.join(__dirname, '..', 'supabase', 'schema.sql'), 'utf8')
  // PGlite tidak menyediakan pgcrypto; stub di bawah menggantikannya.
  .replace(/^create extension if not exists pgcrypto.*$/m, '');

const ADMIN = 'admin@pameran.id';
const SANDI_ADMIN = 'rahasia-admin-123';

let db;

async function q(sql, params) {
  return db.query(sql, params || []);
}

async function rpc(action, payload, token) {
  const res = await q(
    'select public.pameran_rpc_call($1::text, $2::text, $3::jsonb) as r',
    [action, token || '', JSON.stringify(payload || {})]
  );
  const hasil = res.rows[0].r;
  // Samakan dengan klien: kegagalan login datang sebagai {ok:false}
  if (hasil && hasil.ok === false) throw new Error(hasil.error || 'Gagal');
  return hasil;
}

async function rpcError(action, payload, token) {
  try {
    await rpc(action, payload, token);
    assert.fail('seharusnya gagal: ' + action);
  } catch (err) {
    return String(err.message || err);
  }
}

async function login(email, pass) {
  return rpc('login', { email, pass });
}

before(async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  db = new PGlite();

  await q(`do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  end $$;`);

  // Simulasikan proyek Supabase yang sudah dipakai aplikasi lain: tabel
  // public.transaksi sudah ada dan WAJIB tidak tersentuh oleh skema kita.
  await db.exec(`
    create table public.transaksi (id text primary key, keterangan text);
    insert into public.transaksi values ('APP-LAIN-1', 'data aplikasi lain');
  `);

  await db.exec(SCHEMA);

  // Stub pgcrypto: hash dapat diverifikasi ulang seperti bcrypt.
  await db.exec(`
    create or replace function extensions.gen_salt(p text, p_cost integer default 6) returns text
    language sql volatile as $$ select md5(random()::text) $$;

    create or replace function extensions.gen_random_bytes(n integer) returns bytea
    language sql volatile as $$
      select substring(decode(repeat(md5(random()::text), n / 16 + 1), 'hex') from 1 for n)
    $$;

    create or replace function extensions.crypt(p_pass text, p_salt text) returns text
    language plpgsql immutable as $$
    declare s text;
    begin
      if left(p_salt, 6) = '$stub$' then
        s := split_part(p_salt, '$', 3);
        if md5(s || ':' || p_pass) = split_part(p_salt, '$', 4) then return p_salt; end if;
        return '$stub$' || s || '$' || md5(s || ':' || p_pass || '!');
      end if;
      return '$stub$' || p_salt || '$' || md5(p_salt || ':' || p_pass);
    end $$;
  `);

  await q(
    `insert into pameran.users (email, nama, cabang, pass_hash, role)
     values ($1, 'Admin', 'Pusat', extensions.crypt($2, extensions.gen_salt('bf')), 'ADMIN')`,
    [ADMIN, SANDI_ADMIN]
  );

  await q(`insert into pameran.master_produk (kode, isbn, nama, harga) values
    ('9780306406157', '0306406152', 'Buku Contoh Satu', 75000),
    ('BK-002', '', 'Buku Contoh Dua', 50000),
    ('000123', '', 'Produk Nol Depan', 10000)`);
});

after(async () => {
  if (db) await db.close();
});

test('skema, RLS, dan hak akses terpasang', async () => {
  const t = await q(`select relname, relrowsecurity from pg_class
                      where relnamespace = 'pameran'::regnamespace
                        and relname in ('users','transaksi','transaksi_item')`);
  assert.equal(t.rows.length, 3);
  t.rows.forEach((r) => assert.equal(r.relrowsecurity, true, r.relname + ' tanpa RLS'));

  const acl = await q(`select has_table_privilege('anon', 'pameran.users', 'select') as bisa`);
  assert.equal(acl.rows[0].bisa, false, 'anon tidak boleh membaca tabel langsung');

  const fn = await q(`select has_function_privilege('anon',
      'public.pameran_rpc_call(text,text,jsonb)', 'execute') as bisa`);
  assert.equal(fn.rows[0].bisa, true, 'anon harus bisa memanggil pintu RPC');

  // Isi schema pameran tertutup: tanpa USAGE, anon tidak bisa menyentuh objeknya
  // meski suatu saat ada fungsi yang lupa dicabut haknya.
  const usage = await q(`select has_schema_privilege('anon', 'pameran', 'usage') as bisa`);
  assert.equal(usage.rows[0].bisa, false, 'anon tidak boleh punya USAGE schema pameran');

  const router = await q(`select has_function_privilege('anon',
      'pameran.rpc_call(text,text,jsonb)', 'execute') as bisa`);
  assert.equal(router.rows[0].bisa, false, 'anon tidak boleh memanggil router internal');
});

test('objek kita tidak menimpa tabel aplikasi lain di schema public', async () => {
  const lain = await q(`select keterangan from public.transaksi where id = 'APP-LAIN-1'`);
  assert.equal(lain.rows.length, 1);
  assert.equal(lain.rows[0].keterangan, 'data aplikasi lain');

  // Tidak ada satu pun tabel pameran yang mendarat di public.
  const bocor = await q(`select table_name from information_schema.tables
                          where table_schema = 'public'
                            and table_name in ('users','sessions','login_rate','master_produk',
                                               'produk_pameran','transaksi_item','log_aktivitas')`);
  assert.deepEqual(bocor.rows, [], 'tabel pameran tidak boleh ada di schema public');
});

test('login menolak sandi salah dan menerima sandi benar', async () => {
  const salah = await rpcError('login', { email: ADMIN, pass: 'salah' });
  assert.match(salah, /Email atau kata sandi salah/);

  const d = await login(ADMIN, SANDI_ADMIN);
  assert.equal(d.user.email, ADMIN);
  assert.equal(d.user.role, 'ADMIN');
  assert.equal(d.user.cabang, 'Pusat');
  assert.ok(d.session.token.length >= 32);

  global.adminToken = d.session.token;
  const sesi = await q('select email, kedaluwarsa > now() as hidup from pameran.sessions where token = $1',
    [d.session.token]);
  assert.equal(sesi.rows.length, 1);
  assert.equal(sesi.rows[0].hidup, true);
});

test('semua aksi selain login butuh sesi', async () => {
  assert.match(await rpcError('cariMaster', { q: 'buku' }), /Sesi kedaluwarsa/);
  assert.match(await rpcError('listUsers', {}, 'token-palsu'), /Sesi kedaluwarsa/);
});

test('admin membuat user cabang; user tidak boleh aksi admin', async () => {
  const d = await rpc('addUser',
    { email: 'kasir.a@x.id', nama: 'Kasir A', cabang: 'Cabang A', pass: 'sandi123', role: 'USER' },
    global.adminToken);
  assert.equal(d.ditambahkan, 'kasir.a@x.id');

  assert.match(
    await rpcError('addUser', { email: 'x@x.id', cabang: 'X', pass: 'abc' }, global.adminToken),
    /Data tidak lengkap/);
  assert.match(
    await rpcError('addUser', { email: 'kasir.a@x.id', cabang: 'A', pass: 'sandi123' }, global.adminToken),
    /Email sudah terdaftar/);

  const a = await login('kasir.a@x.id', 'sandi123');
  assert.equal(a.user.cabang, 'Cabang A');
  global.tokenA = a.session.token;

  await rpc('addUser',
    { email: 'kasir.b@x.id', nama: 'Kasir B', cabang: 'Cabang B', pass: 'sandi123', role: 'USER' },
    global.adminToken);
  const b = await login('kasir.b@x.id', 'sandi123');
  assert.equal(b.user.cabang, 'Cabang B');
  global.tokenB = b.session.token;

  assert.match(await rpcError('listUsers', {}, global.tokenA), /Halaman khusus Admin/);

  const users = await rpc('listUsers', {}, global.adminToken);
  assert.equal(users.length, 3);
  assert.ok(users.every((u) => typeof u.email === 'string' && u.role));
  assert.ok(!('pass_hash' in users[0]), 'hash sandi tidak boleh terkirim ke klien');
});

test('cari master: persis via kode/ISBN-10/ISBN-13 dan pencarian judul', async () => {
  let r = await rpc('cariMaster', { q: '978-0-306-40615-7' }, global.adminToken);
  assert.equal(r.exact.kode, '9780306406157');
  assert.equal(r.exact.harga, 75000);

  r = await rpc('cariMaster', { q: '0306406152' }, global.adminToken);
  assert.equal(r.exact.kode, '9780306406157', 'ISBN-10 harus menemukan ISBN-13');

  r = await rpc('cariMaster', { q: 'bk 002' }, global.adminToken);
  assert.equal(r.exact.kode, 'BK-002', 'tanda hubung & spasi diabaikan');

  r = await rpc('cariMaster', { q: '123' }, global.adminToken);
  assert.equal(r.exact.kode, '000123', 'nol di depan pada data tersimpan tetap cocok');

  r = await rpc('cariMaster', { q: 'buku contoh' }, global.tokenA);
  assert.equal(r.total, 2);
  assert.equal(r.hasil.length, 2);
  assert.equal(r.hasil[0].kode, '9780306406157');

  r = await rpc('cariMaster', { q: 'contoh dua' }, global.tokenA);
  assert.equal(r.hasil.length, 1);
  assert.equal(r.hasil[0].kode, 'BK-002');

  r = await rpc('cariMaster', { q: 'tidakada', exact: true }, global.tokenA);
  assert.equal(r.exact, null);
  assert.deepEqual(r.hasil, []);

  assert.match(await rpcError('cariMaster', { q: '   ' }, global.tokenA), /kosong/);
});

test('produk pameran: simpan, perbarui, isolasi cabang', async () => {
  const baru = await rpc('simpanProdukPameran',
    { event: 'Pameran Buku', tgl: '2026-11-14', kode: '9780306406157', harga: 70000, jumlah: 10 },
    global.tokenA);
  assert.equal(baru.diperbarui, false);
  assert.equal(baru.produk.nama, 'Buku Contoh Satu', 'nama diambil dari master, bukan klien');
  assert.equal(baru.produk.harga, 70000);

  const ulang = await rpc('simpanProdukPameran',
    { event: 'pameran   buku ', tgl: '2026-11-14', kode: '978-0-306-40615-7', harga: 71000, jumlah: 12 },
    global.tokenA);
  assert.equal(ulang.diperbarui, true, 'judul beda spasi/huruf tetap satu baris');

  const daftar = await rpc('getProdukPameran', { event: 'Pameran Buku', tgl: '2026-11-14' }, global.tokenA);
  assert.equal(daftar.length, 1);
  assert.equal(daftar[0].harga, 71000);
  assert.equal(daftar[0].jumlah, 12);

  const cabangLain = await rpc('getProdukPameran', { event: 'Pameran Buku', tgl: '2026-11-14' }, global.tokenB);
  assert.deepEqual(cabangLain, [], 'cabang lain tidak boleh melihat produk ini');

  assert.match(
    await rpcError('simpanProdukPameran',
      { event: 'Pameran Buku', tgl: '2026-11-14', kode: 'TIDAK-ADA', harga: 1000, jumlah: 1 }, global.tokenA),
    /tidak ada di tabel master_produk/);

  assert.match(
    await rpcError('simpanProdukPameran',
      { event: 'Pameran Buku', tgl: '2026-11-14', kode: 'BK-002', harga: 1.5, jumlah: 1 }, global.tokenA),
    /Harga harus bilangan bulat/);

  assert.match(
    await rpcError('simpanProdukPameran',
      { event: 'Pameran Buku', tgl: '14-11-2026', kode: 'BK-002', harga: 1000, jumlah: 1 }, global.tokenA),
    /Tanggal pameran tidak valid/);
});

test('transaksi: validasi, diskon, idempotensi, dan pembacaan', async () => {
  const trx = {
    id: 'TRX-ABC123',
    waktu: '2026-11-14T10:15:00+07:00',
    metode: 'TUNAI',
    bayar: 200000,
    items: [
      { kode: '9780306406157', nama: 'Buku Contoh Satu', harga: 70000, qty: 2, diskonTipe: 'PERSEN', diskonNilai: 10 },
      { kode: 'BK-002', nama: 'Buku Contoh Dua', harga: 50000, qty: 1, diskonTipe: 'RUPIAH', diskonNilai: 5000 },
    ],
  };

  assert.match(
    await rpcError('simpanTransaksiPameran', { event: 'Pameran Buku', tgl: '2026-11-14', trx: Object.assign({}, trx, { id: 'x' }) }, global.tokenA),
    /ID transaksi tidak valid/);

  assert.match(
    await rpcError('simpanTransaksiPameran', { event: 'Pameran Buku', tgl: '2026-11-14', trx: Object.assign({}, trx, { items: [] }) }, global.tokenA),
    /Item transaksi kosong/);

  assert.match(
    await rpcError('simpanTransaksiPameran', { event: 'Pameran Buku', tgl: '2026-11-14', trx: Object.assign({}, trx, { id: 'TRX-KURANG1', bayar: 1000 }) }, global.tokenA),
    /Uang diterima kurang dari total/);

  assert.match(
    await rpcError('simpanTransaksiPameran', {
      event: 'Pameran Buku', tgl: '2026-11-14',
      trx: Object.assign({}, trx, { id: 'TRX-DISKON1', bayar: 999999,
        items: [{ kode: 'BK-002', harga: 1000, qty: 1, diskonTipe: 'RUPIAH', diskonNilai: 5000 }] }),
    }, global.tokenA),
    /Potongan melebihi subtotal/);

  const hasil = await rpc('simpanTransaksiPameran', { event: 'Pameran Buku', tgl: '2026-11-14', trx }, global.tokenA);
  // 140.000 − 10% = 126.000 ; 50.000 − 5.000 = 45.000
  assert.equal(hasil.total, 171000);
  assert.equal(hasil.sudah, false);

  const ulang = await rpc('simpanTransaksiPameran', { event: 'Pameran Buku', tgl: '2026-11-14', trx }, global.tokenA);
  assert.equal(ulang.sudah, true, 'kirim ulang tidak boleh menambah transaksi');

  const daftar = await rpc('getTransaksiPameran', { event: 'pameran buku', tgl: '2026-11-14' }, global.tokenA);
  assert.equal(daftar.length, 1);
  const t = daftar[0];
  assert.equal(t.id, 'TRX-ABC123');
  assert.equal(t.items.length, 2, 'item tersimpan tepat sekali');
  assert.equal(t.subtotal, 190000);
  assert.equal(t.diskon, 19000);
  assert.equal(t.total, 171000);
  assert.equal(t.bayar, 200000);
  assert.equal(t.kembali, 29000);
  assert.equal(t.deleted, false);
  assert.equal(t.batal, null);
  assert.equal(t.kasirEmail, 'kasir.a@x.id');

  // Non-tunai: bayar dipaksa sama dengan total
  const qris = await rpc('simpanTransaksiPameran', {
    event: 'Pameran Buku', tgl: '2026-11-14',
    trx: { id: 'TRX-QRIS01', metode: 'QRIS', bayar: 1,
      items: [{ kode: 'BK-002', harga: 50000, qty: 1, diskonTipe: 'PERSEN', diskonNilai: 0 }] },
  }, global.tokenA);
  assert.equal(qris.total, 50000);
  const qrisRow = await q('select bayar, kembali from pameran.transaksi where id = $1', ['TRX-QRIS01']);
  assert.equal(qrisRow.rows[0].bayar, 50000);
  assert.equal(qrisRow.rows[0].kembali, 0);
});

test('pembatalan: alasan, kepemilikan, cakupan cabang, dan idempotensi', async () => {
  assert.match(
    await rpcError('batalkanTransaksiPameran', { event: 'Pameran Buku', tgl: '2026-11-14', id: 'TRX-ABC123', alasan: 'x' }, global.tokenA),
    /3–200 karakter/);

  assert.match(
    await rpcError('batalkanTransaksiPameran', { event: 'Pameran Buku', tgl: '2026-11-14', id: 'TRX-ABC123', alasan: 'salah input' }, global.tokenB),
    /Transaksi tidak ditemukan/, 'cabang lain tidak boleh menyentuh transaksi ini');

  const kasirC = await rpc('addUser',
    { email: 'kasir.c@x.id', nama: 'Kasir C', cabang: 'Cabang A', pass: 'sandi123', role: 'USER' },
    global.adminToken);
  assert.equal(kasirC.ditambahkan, 'kasir.c@x.id');
  const c = await login('kasir.c@x.id', 'sandi123');
  assert.match(
    await rpcError('batalkanTransaksiPameran', { event: 'Pameran Buku', tgl: '2026-11-14', id: 'TRX-ABC123', alasan: 'salah input' }, c.session.token),
    /Hanya pembuat transaksi atau admin/);

  const ok = await rpc('batalkanTransaksiPameran', { event: 'Pameran Buku', tgl: '2026-11-14', id: 'TRX-ABC123', alasan: 'salah input' }, global.tokenA);
  assert.equal(ok.dibatalkan, 'TRX-ABC123');
  assert.equal(ok.sudah, false);

  const ulang = await rpc('batalkanTransaksiPameran', { event: 'Pameran Buku', tgl: '2026-11-14', id: 'TRX-ABC123', alasan: 'salah input' }, global.tokenA);
  assert.equal(ulang.sudah, true);

  const daftar = await rpc('getTransaksiPameran', { event: 'Pameran Buku', tgl: '2026-11-14' }, global.tokenA);
  const t = daftar.find((x) => x.id === 'TRX-ABC123');
  assert.equal(t.deleted, true);
  assert.equal(t.batal.alasan, 'salah input');
  assert.equal(t.batal.oleh, 'kasir.a@x.id');
  assert.ok(t.batal.waktu);

  assert.match(
    await rpcError('batalkanTransaksiPameran', { event: 'Pameran Buku', tgl: '2026-11-14', id: 'TRX-TIDAKADA', alasan: 'salah input' }, global.tokenA),
    /Transaksi tidak ditemukan/);
});

test('koreksi: transaksi lama otomatis BATAL dan tertaut', async () => {
  const r = await rpc('simpanTransaksiPameran', {
    event: 'Pameran Buku', tgl: '2026-11-14',
    trx: { id: 'TRX-KOREKSI1', metode: 'QRIS', menggantikan: 'TRX-QRIS01',
      items: [{ kode: 'BK-002', harga: 45000, qty: 1, diskonTipe: 'PERSEN', diskonNilai: 0 }] },
  }, global.tokenA);
  assert.equal(r.total, 45000);
  assert.equal(r.menggantikan, 'TRX-QRIS01');
  assert.equal(r.menggantikanDibatalkan, true);

  const lama = await q('select status, alasan_batal from pameran.transaksi where id = $1', ['TRX-QRIS01']);
  assert.equal(lama.rows[0].status, 'BATAL');
  assert.match(lama.rows[0].alasan_batal, /Dikoreksi/);

  const baru = await q('select menggantikan from pameran.transaksi where id = $1', ['TRX-KOREKSI1']);
  assert.equal(baru.rows[0].menggantikan, 'TRX-QRIS01');
});

test('produk yang dipakai transaksi aktif tidak bisa dihapus', async () => {
  assert.match(
    await rpcError('hapusProdukPameran', { event: 'Pameran Buku', tgl: '2026-11-14', kode: 'BK-002' }, global.tokenA),
    /transaksi aktif/);

  // Buku Contoh Satu hanya dipakai transaksi yang sudah BATAL → boleh dihapus
  const hapus = await rpc('hapusProdukPameran', { event: 'Pameran Buku', tgl: '2026-11-14', kode: '9780306406157' }, global.tokenA);
  assert.equal(hapus.dihapus, '9780306406157');
  const daftar = await rpc('getProdukPameran', { event: 'Pameran Buku', tgl: '2026-11-14' }, global.tokenA);
  assert.equal(daftar.length, 0);
});

test('logout mencabut token', async () => {
  const token = global.tokenB;
  const r = await rpc('logout', {}, token);
  assert.equal(r.keluar, true);
  assert.match(await rpcError('listUsers', {}, token), /Sesi kedaluwarsa/);
});

test('ping dan seedTest milik admin', async () => {
  const ping = await rpc('test', { name: 'ping' }, global.adminToken);
  assert.equal(ping.database, 'supabase');
  assert.match(ping.pong, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

  const seed = await rpc('test', { name: 'seedTest' }, global.adminToken);
  assert.ok(seed.barisDitambahkan);
  const cek = await q(`select count(*)::int as n from pameran.master_produk where kode like 'TEST-%'`);
  assert.equal(cek.rows[0].n, 1);

  assert.match(await rpcError('test', { name: 'apa' }, global.adminToken), /Test tidak dikenal/);
});

test('admin terakhir tidak bisa dihapus', async () => {
  assert.match(await rpcError('deleteUser', { email: ADMIN }, global.adminToken), /admin terakhir/);
  const hapus = await rpc('deleteUser', { email: 'kasir.c@x.id' }, global.adminToken);
  assert.equal(hapus.dihapus, 'kasir.c@x.id');
  assert.match(await rpcError('deleteUser', { email: 'tidak@ada.id' }, global.adminToken), /User tidak ditemukan/);
});

test('login dikunci setelah 5 kali gagal', async () => {
  await rpc('addUser', { email: 'kunci@x.id', cabang: 'Cabang A', pass: 'sandi123' }, global.adminToken);
  for (let i = 0; i < 5; i++) {
    assert.match(await rpcError('login', { email: 'kunci@x.id', pass: 'salah' }), /salah/);
  }
  assert.match(await rpcError('login', { email: 'kunci@x.id', pass: 'sandi123' }), /Terlalu banyak percobaan/);
});

test('aksi tidak dikenal ditolak', async () => {
  assert.match(await rpcError('aksiAneh', {}, global.adminToken), /Aksi tidak dikenal/);
});
