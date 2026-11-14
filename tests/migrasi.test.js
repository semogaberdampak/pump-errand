/* ============================================================
   migrasi.test.js — Menguji supabase/pindah-ke-schema-pameran.sql:
   data dari instalasi lama (schema public) tersalin ke pameran,
   sandi bcrypt tetap bisa dipakai, dan skrip tidak menghapus apa pun.
   ============================================================ */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA = fs
  .readFileSync(path.join(__dirname, '..', 'supabase', 'schema.sql'), 'utf8')
  .replace(/^create extension if not exists pgcrypto.*$/m, '');

const MIGRASI = fs.readFileSync(
  path.join(__dirname, '..', 'supabase', 'pindah-ke-schema-pameran.sql'),
  'utf8'
);

let db;

async function q(sql, params) {
  return db.query(sql, params || []);
}

before(async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  db = new PGlite();

  await q(`do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  end $$;`);

  // Instalasi lama: tabel pameran di schema public + satu akun lama.
  await db.exec(`
    create table public.users (
      email text primary key, nama text not null, cabang text not null,
      pass_hash text not null, role text not null default 'USER',
      aktif boolean not null default true, dibuat timestamptz not null default now());
    create table public.master_produk (
      id bigserial primary key, kode text not null, isbn text not null default '',
      nama text not null, harga bigint not null default 0);
    create table public.keranjang_lain (id serial primary key); -- milik aplikasi lain
    insert into public.users values
      ('admin@pameran.id','Admin','Pusat','$stub$abc$def','ADMIN',true,now()),
      ('kasir@pameran.id','Kasir','Cabang A','$stub$ghi$jkl','USER',false,now());
    insert into public.master_produk (kode, isbn, nama, harga) values
      ('BK-001','9789792123456','Buku Lama',75000),
      ('BK-002','','Buku Kedua',50000);
  `);

  await db.exec(SCHEMA);
  await db.exec(MIGRASI);
});

after(async () => {
  if (db) await db.close();
});

test('akun lama tersalin lengkap dengan peran dan status aktif', async () => {
  const r = await q('select email, nama, cabang, pass_hash, role, aktif from pameran.users order by email');
  assert.equal(r.rows.length, 2);
  assert.deepEqual(r.rows.map((x) => [x.email, x.role, x.aktif]), [
    ['admin@pameran.id', 'ADMIN', true],
    ['kasir@pameran.id', 'USER', false],
  ]);
  assert.equal(r.rows[0].pass_hash, '$stub$abc$def', 'hash lama harus dipakai apa adanya');
});

test('master produk tersalin tanpa duplikat dan normalisasi kode diabaikan', async () => {
  const r = await q('select kode, nama, harga from pameran.master_produk order by kode');
  assert.deepEqual(r.rows.map((x) => x.kode), ['BK-001', 'BK-002']);

  // Jalankan ulang: kode yang sama (beda tanda hubung/spasi) tidak boleh dobel.
  await q(`insert into public.master_produk (kode, isbn, nama, harga)
           values ('bk 001', '', 'Buku Lama Duplikat', 1)`);
  await db.exec(MIGRASI);
  const lagi = await q(`select count(*)::int as n from pameran.master_produk
                          where pameran.f_norm_kode(kode) = 'BK001'`);
  assert.equal(lagi.rows[0].n, 1);
});

test('data dan objek lain milik aplikasi lain tidak tersentuh', async () => {
  const lain = await q(`select count(*)::int as n from public.keranjang_lain`);
  assert.equal(lain.rows[0].n, 0);
  const lama = await q(`select count(*)::int as n from public.users`);
  assert.equal(lama.rows[0].n, 2, 'skrip migrasi tidak boleh menghapus data lama');
  const lamaMaster = await q(`select count(*)::int as n from public.master_produk`);
  assert.equal(lamaMaster.rows[0].n, 3);
});
