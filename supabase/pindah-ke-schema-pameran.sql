/* ============================================================
   pindah-ke-schema-pameran.sql — opsional, jalankan SETELAH schema.sql
   ------------------------------------------------------------
   Dipakai hanya bila proyek Supabase ini pernah menjalankan versi
   pertama skrip (yang menaruh tabel di schema public).

   Skrip ini TIDAK menghapus apa pun. Ia hanya menyalin:
     public.users          → pameran.users
     public.master_produk  → pameran.master_produk

   Sandi ikut pindah karena keduanya memakai bcrypt (extensions.crypt),
   jadi pengguna lama bisa login dengan sandi yang sama.

   Bila tabel public tidak ada / bentuknya bukan milik aplikasi pameran,
   blok terkait dilewati dengan pesan NOTICE, bukan error.
   ============================================================ */

do $$
begin
  if to_regclass('public.users') is null then
    raise notice 'public.users tidak ada — dilewati';
  elsif (select count(*) from information_schema.columns
          where table_schema = 'public' and table_name = 'users'
            and column_name in ('email','nama','cabang','pass_hash','role','aktif','dibuat')) < 6 then
    raise notice 'public.users bentuknya bukan milik aplikasi pameran — dilewati';
  else
    insert into pameran.users (email, nama, cabang, pass_hash, role, aktif, dibuat)
    select email, nama, cabang, pass_hash,
           case when upper(coalesce(role, '')) = 'ADMIN' then 'ADMIN' else 'USER' end,
           coalesce(aktif, true), coalesce(dibuat, now())
      from public.users
    on conflict (email) do nothing;
    raise notice 'users disalin. total di pameran.users: %', (select count(*) from pameran.users);
  end if;
end $$;

do $$
begin
  if to_regclass('public.master_produk') is null then
    raise notice 'public.master_produk tidak ada — dilewati';
  elsif (select count(*) from information_schema.columns
          where table_schema = 'public' and table_name = 'master_produk'
            and column_name in ('kode','isbn','nama','harga')) < 4 then
    raise notice 'public.master_produk bentuknya bukan milik aplikasi pameran — dilewati';
  else
    insert into pameran.master_produk (kode, isbn, nama, harga)
    select kode, coalesce(isbn, ''), nama, coalesce(harga, 0)
      from public.master_produk pm
     where not exists (
       select 1 from pameran.master_produk nk
        where pameran.f_norm_kode(nk.kode) = pameran.f_norm_kode(pm.kode));
    raise notice 'master_produk disalin. total di pameran.master_produk: %',
      (select count(*) from pameran.master_produk);
  end if;
end $$;

/* ---------------- Setelah yakin aplikasi baru sudah berjalan ----------------
   Frontend versi baru memanggil public.pameran_rpc_call. Setelah itu di-deploy
   dan login berhasil, objek lama di public boleh dibersihkan. Cek dulu isinya,
   lalu hapus HANYA yang memang milik aplikasi pameran:

drop function if exists public.rpc_call(text, text, jsonb);
drop function if exists public.cari_master(text, boolean);
drop table if exists public.transaksi_item, public.transaksi, public.produk_pameran,
  public.master_produk, public.log_aktivitas, public.sessions, public.login_rate, public.users;
-- Fungsi bantu public.f_* (norm_kode, tgl, isbn, varian, dsb.) juga bisa dihapus
-- bila tidak dipakai objek lain milik aplikasi Anda.
------------------------------------------------------------------------------ */
