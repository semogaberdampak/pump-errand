/* ============================================================
   db.test.js — Menjalankan supabase/schema.sql di Postgres (PGlite)
   dengan tiruan tabel aplikasi POS (auth.users, public.profiles,
   public.roles, public.branches), lalu menguji:
     identitas dari JWT, RBAC, isolasi cabang, master produk,
     produk pameran, transaksi, dan pembatalan.
   ============================================================ */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA = fs
  .readFileSync(path.join(__dirname, '..', 'supabase', 'schema.sql'), 'utf8')
  // PGlite tidak menyediakan pgcrypto; tidak dipakai lagi oleh skema.
  .replace(/^create extension if not exists pgcrypto.*$/m, '');

// UUID tetap agar mudah dirujuk
const U_ADMIN = '11111111-1111-4111-8111-111111111111';
const U_A = '22222222-2222-4222-8222-222222222222';
const U_B = '33333333-3333-4333-8333-333333333333';
const U_C = '44444444-4444-4444-8444-444444444444';
const U_NONAKTIF = '55555555-5555-4555-8555-555555555555';
const U_TANPA_CABANG = '66666666-6666-4666-8666-666666666666';

let db;

async function q(sql, params) {
  return db.query(sql, params || []);
}

// Meniru PostgREST: klaim JWT tersedia untuk fungsi SECURITY DEFINER.
async function jadi(uid) {
  if (uid === null) {
    await q(`select set_config('request.jwt.claims', '', false)`);
    return;
  }
  await q(`select set_config('request.jwt.claims', $1, false)`,
    [JSON.stringify({ sub: uid, role: 'authenticated' })]);
}

async function rpc(action, payload, uid) {
  await jadi(uid === undefined ? U_ADMIN : uid);
  const res = await q(
    'select public.pameran_rpc_call($1::text, $2::jsonb) as r',
    [action, JSON.stringify(payload || {})]
  );
  return res.rows[0].r;
}

async function rpcError(action, payload, uid) {
  try {
    await rpc(action, payload, uid);
    assert.fail('seharusnya gagal: ' + action);
  } catch (err) {
    return String(err.message || err);
  }
}

before(async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  db = new PGlite();

  await q(`do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  end $$;`);

  // Tiruan proyek POS: Supabase Auth + profiles/roles/branches.
  await db.exec(`
    create schema auth;
    create table auth.users (id uuid primary key, email text);
    create table public.roles (id bigint primary key, name text not null, description text);
    create table public.branches (id bigint primary key, name text not null, code text, is_active boolean default true);
    create table public.profiles (
      id uuid primary key references auth.users(id) on delete cascade,
      full_name text,
      role_id bigint references public.roles(id),
      branch_id bigint references public.branches(id),
      is_active boolean default true);

    insert into public.roles values (1, 'Admin', 'Administrator'), (2, 'Kasir', 'Kasir cabang');
    insert into public.branches values (1, 'Pusat', 'PST', true), (2, 'Cabang A', 'CBA', true),
                                       (3, 'Cabang B', 'CBB', true);
    insert into auth.users values
      ('${U_ADMIN}', 'admin@pos.id'), ('${U_A}', 'kasir.a@pos.id'), ('${U_B}', 'kasir.b@pos.id'),
      ('${U_C}', 'kasir.c@pos.id'), ('${U_NONAKTIF}', 'nonaktif@pos.id'),
      ('${U_TANPA_CABANG}', 'tanpacabang@pos.id');
    insert into public.profiles values
      ('${U_ADMIN}', 'Admin POS', 1, 1, true),
      ('${U_A}', 'Kasir A', 2, 2, true),
      ('${U_B}', 'Kasir B', 2, 3, true),
      ('${U_C}', 'Kasir C', 2, 2, true),
      ('${U_NONAKTIF}', 'Mantan Kasir', 2, 2, false),
      ('${U_TANPA_CABANG}', 'Kasir Baru', 2, null, true);
  `);

  // Tabel milik aplikasi POS: wajib tidak tersentuh skema kita.
  await db.exec(`
    create table public.products (id uuid primary key default gen_random_uuid(), code text, name text, price numeric);
    create table public.sales (id uuid primary key default gen_random_uuid(), total numeric);
    insert into public.products (code, name, price) values ('POS-1', 'Produk POS', 5000);
  `);

  await db.exec(SCHEMA);

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
                        and relname in ('master_produk','transaksi','transaksi_item','log_aktivitas')`);
  assert.equal(t.rows.length, 4);
  t.rows.forEach((r) => assert.equal(r.relrowsecurity, true, r.relname + ' tanpa RLS'));

  const tbl = await q(`select has_table_privilege('authenticated', 'pameran.transaksi', 'select') as bisa`);
  assert.equal(tbl.rows[0].bisa, false, 'pengguna login tidak boleh membaca tabel langsung');

  const fn = await q(`select has_function_privilege('authenticated',
      'public.pameran_rpc_call(text,jsonb)', 'execute') as bisa`);
  assert.equal(fn.rows[0].bisa, true, 'pengguna login harus bisa memanggil pintu RPC');

  const anonFn = await q(`select has_function_privilege('anon',
      'public.pameran_rpc_call(text,jsonb)', 'execute') as bisa`);
  assert.equal(anonFn.rows[0].bisa, false, 'anon tidak boleh memanggil RPC (login lewat Supabase Auth)');

  const usage = await q(`select has_schema_privilege('authenticated', 'pameran', 'usage') as bisa`);
  assert.equal(usage.rows[0].bisa, false, 'tidak ada USAGE langsung ke schema pameran');

  const router = await q(`select has_function_privilege('authenticated',
      'pameran.rpc_call(text,jsonb)', 'execute') as bisa`);
  assert.equal(router.rows[0].bisa, false, 'router internal tidak boleh dipanggil langsung');
});

test('tabel aplikasi POS tidak tersentuh dan tidak ada tabel pameran di public', async () => {
  const p = await q(`select code, name from public.products`);
  assert.equal(p.rows.length, 1);
  assert.equal(p.rows[0].code, 'POS-1');

  const bocor = await q(`select table_name from information_schema.tables
                          where table_schema = 'public'
                            and table_name in ('users','sessions','login_rate','master_produk',
                                               'produk_pameran','transaksi_item','log_aktivitas')`);
  assert.deepEqual(bocor.rows, [], 'tabel pameran tidak boleh ada di schema public');
});

test('identitas diambil dari JWT → profiles/roles/branches POS', async () => {
  const admin = await rpc('profilSaya');
  assert.equal(admin.email, 'admin@pos.id');
  assert.equal(admin.nama, 'Admin POS');
  assert.equal(admin.role, 'ADMIN', 'peran POS "Admin" harus jadi ADMIN');
  assert.equal(admin.cabang, 'Pusat');
  assert.equal(admin.cabang_id, 1);

  const kasir = await rpc('profilSaya', {}, U_A);
  assert.equal(kasir.role, 'USER');
  assert.equal(kasir.cabang, 'Cabang A');
});

test('identitas ditolak bila tidak login, nonaktif, atau tanpa cabang', async () => {
  assert.match(await rpcError('profilSaya', {}, null), /Sesi kedaluwarsa/);
  assert.match(await rpcError('profilSaya', {}, U_NONAKTIF), /dinonaktifkan/);
  assert.match(await rpcError('profilSaya', {}, U_TANPA_CABANG), /belum ditetapkan ke cabang/);
  assert.match(await rpcError('profilSaya', {}, '99999999-9999-4999-8999-999999999999'), /tidak memiliki profil/);
});

test('aksi admin ditolak untuk peran USER; listUsers hanya membaca profil POS', async () => {
  assert.match(await rpcError('listUsers', {}, U_A), /Halaman khusus Admin/);
  assert.match(await rpcError('test', { name: 'ping' }, U_A), /Halaman khusus Admin/);

  const users = await rpc('listUsers');
  assert.equal(users.length, 6);
  const a = users.find((u) => u.email === 'kasir.a@pos.id');
  assert.equal(a.cabang, 'Cabang A');
  assert.equal(a.role, 'USER');
  assert.equal(a.aktif, true);
  assert.ok(!('pass_hash' in users[0]), 'tidak ada hash sandi yang dikirim');
});

test('cari master: persis via kode/ISBN-10/ISBN-13 dan pencarian judul', async () => {
  let r = await rpc('cariMaster', { q: '978-0-306-40615-7' });
  assert.equal(r.exact.kode, '9780306406157');
  assert.equal(r.exact.harga, 75000);

  r = await rpc('cariMaster', { q: '0306406152' });
  assert.equal(r.exact.kode, '9780306406157', 'ISBN-10 harus menemukan ISBN-13');

  r = await rpc('cariMaster', { q: 'bk 002' });
  assert.equal(r.exact.kode, 'BK-002', 'tanda hubung & spasi diabaikan');

  r = await rpc('cariMaster', { q: '123' });
  assert.equal(r.exact.kode, '000123', 'nol di depan pada data tersimpan tetap cocok');

  r = await rpc('cariMaster', { q: 'buku contoh' }, U_A);
  assert.equal(r.total, 2);
  assert.equal(r.hasil.length, 2);
  assert.equal(r.hasil[0].kode, '9780306406157');

  r = await rpc('cariMaster', { q: 'contoh dua' }, U_A);
  assert.equal(r.hasil.length, 1);
  assert.equal(r.hasil[0].kode, 'BK-002');

  r = await rpc('cariMaster', { q: 'tidakada', exact: true }, U_A);
  assert.equal(r.exact, null);
  assert.deepEqual(r.hasil, []);

  assert.match(await rpcError('cariMaster', { q: '   ' }, U_A), /kosong/);
});

test('produk pameran: simpan, perbarui, isolasi cabang', async () => {
  const baru = await rpc('simpanProdukPameran',
    { event: 'Pameran Buku', tgl: '2026-11-14', kode: '9780306406157', harga: 70000, jumlah: 10 },
    U_A);
  assert.equal(baru.diperbarui, false);
  assert.equal(baru.produk.nama, 'Buku Contoh Satu', 'nama diambil dari master, bukan klien');
  assert.equal(baru.produk.harga, 70000);

  const ulang = await rpc('simpanProdukPameran',
    { event: 'pameran   buku ', tgl: '2026-11-14', kode: '978-0-306-40615-7', harga: 71000, jumlah: 12 },
    U_A);
  assert.equal(ulang.diperbarui, true, 'judul beda spasi/huruf tetap satu baris');

  const daftar = await rpc('getProdukPameran', { event: 'Pameran Buku', tgl: '2026-11-14' }, U_A);
  assert.equal(daftar.length, 1);
  assert.equal(daftar[0].harga, 71000);
  assert.equal(daftar[0].jumlah, 12);

  const cabangLain = await rpc('getProdukPameran', { event: 'Pameran Buku', tgl: '2026-11-14' }, U_B);
  assert.deepEqual(cabangLain, [], 'cabang lain tidak boleh melihat produk ini');

  assert.match(
    await rpcError('simpanProdukPameran',
      { event: 'Pameran Buku', tgl: '2026-11-14', kode: 'TIDAK-ADA', harga: 1000, jumlah: 1 }, U_A),
    /tidak ada di tabel master_produk/);

  assert.match(
    await rpcError('simpanProdukPameran',
      { event: 'Pameran Buku', tgl: '2026-11-14', kode: 'BK-002', harga: 1.5, jumlah: 1 }, U_A),
    /Harga harus bilangan bulat/);

  assert.match(
    await rpcError('simpanProdukPameran',
      { event: 'Pameran Buku', tgl: '14-11-2026', kode: 'BK-002', harga: 1000, jumlah: 1 }, U_A),
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
    await rpcError('simpanTransaksiPameran', { event: 'Pameran Buku', tgl: '2026-11-14', trx: Object.assign({}, trx, { id: 'x' }) }, U_A),
    /ID transaksi tidak valid/);

  assert.match(
    await rpcError('simpanTransaksiPameran', { event: 'Pameran Buku', tgl: '2026-11-14', trx: Object.assign({}, trx, { items: [] }) }, U_A),
    /Item transaksi kosong/);

  assert.match(
    await rpcError('simpanTransaksiPameran', { event: 'Pameran Buku', tgl: '2026-11-14', trx: Object.assign({}, trx, { id: 'TRX-KURANG1', bayar: 1000 }) }, U_A),
    /Uang diterima kurang dari total/);

  assert.match(
    await rpcError('simpanTransaksiPameran', {
      event: 'Pameran Buku', tgl: '2026-11-14',
      trx: Object.assign({}, trx, { id: 'TRX-DISKON1', bayar: 999999,
        items: [{ kode: 'BK-002', harga: 1000, qty: 1, diskonTipe: 'RUPIAH', diskonNilai: 5000 }] }),
    }, U_A),
    /Potongan melebihi subtotal/);

  const hasil = await rpc('simpanTransaksiPameran', { event: 'Pameran Buku', tgl: '2026-11-14', trx }, U_A);
  // 140.000 − 10% = 126.000 ; 50.000 − 5.000 = 45.000
  assert.equal(hasil.total, 171000);
  assert.equal(hasil.sudah, false);

  const ulang = await rpc('simpanTransaksiPameran', { event: 'Pameran Buku', tgl: '2026-11-14', trx }, U_A);
  assert.equal(ulang.sudah, true, 'kirim ulang tidak boleh menambah transaksi');

  const daftar = await rpc('getTransaksiPameran', { event: 'pameran buku', tgl: '2026-11-14' }, U_A);
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
  assert.equal(t.kasirEmail, 'kasir.a@pos.id', 'kasir diambil dari email profil POS');

  // Non-tunai: bayar dipaksa sama dengan total
  const qris = await rpc('simpanTransaksiPameran', {
    event: 'Pameran Buku', tgl: '2026-11-14',
    trx: { id: 'TRX-QRIS01', metode: 'QRIS', bayar: 1,
      items: [{ kode: 'BK-002', harga: 50000, qty: 1, diskonTipe: 'PERSEN', diskonNilai: 0 }] },
  }, U_A);
  assert.equal(qris.total, 50000);
  const qrisRow = await q('select bayar, kembali from pameran.transaksi where id = $1', ['TRX-QRIS01']);
  assert.equal(qrisRow.rows[0].bayar, 50000);
  assert.equal(qrisRow.rows[0].kembali, 0);
});

test('pembatalan: alasan, kepemilikan, cakupan cabang, dan idempotensi', async () => {
  assert.match(
    await rpcError('batalkanTransaksiPameran', { event: 'Pameran Buku', tgl: '2026-11-14', id: 'TRX-ABC123', alasan: 'x' }, U_A),
    /3–200 karakter/);

  assert.match(
    await rpcError('batalkanTransaksiPameran', { event: 'Pameran Buku', tgl: '2026-11-14', id: 'TRX-ABC123', alasan: 'salah input' }, U_B),
    /Transaksi tidak ditemukan/, 'cabang lain tidak boleh menyentuh transaksi ini');

  assert.match(
    await rpcError('batalkanTransaksiPameran', { event: 'Pameran Buku', tgl: '2026-11-14', id: 'TRX-ABC123', alasan: 'salah input' }, U_C),
    /Hanya pembuat transaksi atau admin/);

  const ok = await rpc('batalkanTransaksiPameran', { event: 'Pameran Buku', tgl: '2026-11-14', id: 'TRX-ABC123', alasan: 'salah input' }, U_A);
  assert.equal(ok.dibatalkan, 'TRX-ABC123');
  assert.equal(ok.sudah, false);

  const ulang = await rpc('batalkanTransaksiPameran', { event: 'Pameran Buku', tgl: '2026-11-14', id: 'TRX-ABC123', alasan: 'salah input' }, U_A);
  assert.equal(ulang.sudah, true);

  const daftar = await rpc('getTransaksiPameran', { event: 'Pameran Buku', tgl: '2026-11-14' }, U_A);
  const t = daftar.find((x) => x.id === 'TRX-ABC123');
  assert.equal(t.deleted, true);
  assert.equal(t.batal.alasan, 'salah input');
  assert.equal(t.batal.oleh, 'kasir.a@pos.id');
  assert.ok(t.batal.waktu);

  assert.match(
    await rpcError('batalkanTransaksiPameran', { event: 'Pameran Buku', tgl: '2026-11-14', id: 'TRX-TIDAKADA', alasan: 'salah input' }, U_A),
    /Transaksi tidak ditemukan/);
});

test('koreksi: transaksi lama otomatis BATAL dan tertaut', async () => {
  const r = await rpc('simpanTransaksiPameran', {
    event: 'Pameran Buku', tgl: '2026-11-14',
    trx: { id: 'TRX-KOREKSI1', metode: 'QRIS', menggantikan: 'TRX-QRIS01',
      items: [{ kode: 'BK-002', harga: 45000, qty: 1, diskonTipe: 'PERSEN', diskonNilai: 0 }] },
  }, U_A);
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
    await rpcError('hapusProdukPameran', { event: 'Pameran Buku', tgl: '2026-11-14', kode: 'BK-002' }, U_A),
    /transaksi aktif/);

  // Buku Contoh Satu hanya dipakai transaksi yang sudah BATAL → boleh dihapus
  const hapus = await rpc('hapusProdukPameran', { event: 'Pameran Buku', tgl: '2026-11-14', kode: '9780306406157' }, U_A);
  assert.equal(hapus.dihapus, '9780306406157');
  const daftar = await rpc('getProdukPameran', { event: 'Pameran Buku', tgl: '2026-11-14' }, U_A);
  assert.equal(daftar.length, 0);
});

test('ping dan seedTest milik admin', async () => {
  const ping = await rpc('test', { name: 'ping' });
  assert.equal(ping.database, 'supabase');
  assert.match(ping.pong, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

  const seed = await rpc('test', { name: 'seedTest' });
  assert.ok(seed.barisDitambahkan);
  const cek = await q(`select count(*)::int as n from pameran.master_produk where kode like 'TEST-%'`);
  assert.equal(cek.rows[0].n, 1);

  assert.match(await rpcError('test', { name: 'apa' }), /Test tidak dikenal/);
});

test('admin boleh menyebut cabang lain; user biasa tidak', async () => {
  await rpc('simpanProdukPameran',
    { event: 'Pameran Lain', tgl: '2026-11-15', cabang: 'Cabang A', kode: 'BK-002', harga: 60000, jumlah: 3 },
    U_ADMIN);

  const adminLihat = await rpc('getProdukPameran',
    { event: 'Pameran Lain', tgl: '2026-11-15', cabang: 'Cabang A' }, U_ADMIN);
  assert.equal(adminLihat.length, 1);

  // USER mengirim cabang lain di payload → diabaikan, tetap memakai cabangnya sendiri
  const userLihat = await rpc('getProdukPameran',
    { event: 'Pameran Lain', tgl: '2026-11-15', cabang: 'Cabang A' }, U_B);
  assert.deepEqual(userLihat, [], 'cabang dari payload harus diabaikan untuk USER');
});

test('aksi tidak dikenal ditolak', async () => {
  assert.match(await rpcError('aksiAneh', {}), /Aksi tidak dikenal/);
  assert.match(await rpcError('login', { email: 'x', pass: 'y' }), /Aksi tidak dikenal/,
    'login tidak lagi dilayani RPC (dipakai Supabase Auth)');
});
