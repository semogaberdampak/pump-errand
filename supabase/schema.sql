/* ============================================================
   schema.sql — Database Supabase untuk Pencatatan Pameran
   ------------------------------------------------------------
   Jalankan SELURUH file ini sekali di Supabase:
     Dashboard → SQL Editor → New query → tempel → Run.

   Semua akses data lewat satu fungsi RPC: public.rpc_call(...).
   Tabel ditutup rapat dengan RLS (tanpa policy), sehingga anon key
   tidak bisa membaca/menulis tabel secara langsung — hanya fungsi
   security definer yang boleh, dan fungsi itu memeriksa token sesi
   serta peran (ADMIN / USER) di dalamnya.

   Aksi yang dilayani (sama dengan backend lama, tanpa mengubah klien):
     login, logout, listUsers, addUser, deleteUser, test,
     cariMaster, getProdukPameran, simpanProdukPameran,
     hapusProdukPameran, getTransaksiPameran,
     simpanTransaksiPameran, batalkanTransaksiPameran
   ============================================================ */

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

/* ---------------- Utilitas (harus ada sebelum kolom generated) ---------------- */

-- Samakan format kode: abaikan spasi/tanda hubung & huruf besar-kecil
create or replace function public.f_norm_kode(v text) returns text
language sql immutable as $$
  select upper(regexp_replace(coalesce(v, ''), '[^0-9A-Za-z]', '', 'g'));
$$;

-- Judul pameran dibandingkan tanpa peduli huruf besar/kecil & spasi ganda
create or replace function public.f_norm_event(v text) returns text
language sql immutable as $$
  select lower(btrim(regexp_replace(coalesce(v, ''), '\s+', ' ', 'g')));
$$;

create or replace function public.f_tgl(v text) returns date
language plpgsql immutable as $$
begin
  if coalesce(v, '') !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception 'Tanggal pameran tidak valid (format YYYY-MM-DD)';
  end if;
  return v::date;
exception when others then
  raise exception 'Tanggal pameran tidak valid (format YYYY-MM-DD)';
end $$;

-- Angka bulat dari jsonb (menerima number maupun string)
create or replace function public.f_int(v jsonb, pesan text) returns bigint
language plpgsql immutable as $$
declare n numeric;
begin
  begin
    n := (v #>> '{}')::numeric;
  exception when others then
    raise exception '%', pesan;
  end;
  if n is null or n <> floor(n) then raise exception '%', pesan; end if;
  return n::bigint;
end $$;

-- ISBN-10 → ISBN-13 (awalan 978)
create or replace function public.f_isbn13_dari10(n text) returns text
language plpgsql immutable as $$
declare d text; s integer := 0; i integer; ch integer;
begin
  d := '978' || substr(n, 1, 9);
  for i in 1..12 loop
    ch := ascii(substr(d, i, 1)) - 48;
    s := s + ch * (case when i % 2 = 0 then 3 else 1 end);
  end loop;
  return d || ((10 - (s % 10)) % 10)::text;
end $$;

-- ISBN-13 (978) → ISBN-10
create or replace function public.f_isbn10_dari13(n text) returns text
language plpgsql immutable as $$
declare d text; s integer := 0; i integer; c integer;
begin
  d := substr(n, 4, 9);
  for i in 1..9 loop
    s := s + (ascii(substr(d, i, 1)) - 48) * (11 - i);
  end loop;
  c := (11 - (s % 11)) % 11;
  return d || (case when c = 10 then 'X' else c::text end);
end $$;

-- Semua bentuk setara: apa adanya, tanpa nol di depan (UPC-A ⇄ EAN-13), dan ISBN-10 ⇄ ISBN-13
create or replace function public.f_varian(v text) returns text[]
language plpgsql immutable as $$
declare n text; out_arr text[] := '{}'; t text;
begin
  n := public.f_norm_kode(v);
  if n = '' then return out_arr; end if;
  out_arr := array[n];
  if n ~ '^[0-9]+$' then
    t := regexp_replace(n, '^0+', '');
    if t <> '' and t <> n then out_arr := out_arr || t; end if;
    if length(n) = 13 and left(n, 3) = '978' then
      out_arr := out_arr || public.f_isbn10_dari13(n);
    end if;
  end if;
  if n ~ '^[0-9]{9}[0-9X]$' then
    out_arr := out_arr || public.f_isbn13_dari10(n);
  end if;
  return out_arr;
end $$;

create table if not exists public.users (
  email      text primary key,
  nama       text not null,
  cabang     text not null,
  pass_hash  text not null,
  role       text not null default 'USER' check (role in ('ADMIN', 'USER')),
  aktif      boolean not null default true,
  dibuat     timestamptz not null default now()
);

create table if not exists public.sessions (
  token       text primary key,
  email       text not null references public.users(email) on delete cascade,
  dibuat      timestamptz not null default now(),
  kedaluwarsa timestamptz not null
);
create index if not exists sessions_kedaluwarsa_idx on public.sessions (kedaluwarsa);

-- Pembatas percobaan login (5x gagal → dikunci 15 menit per email)
create table if not exists public.login_rate (
  email        text primary key,
  gagal        integer not null default 0,
  kunci_sampai timestamptz
);

-- Sumber produk (dulu sheet "Master": produk_id | isbn | nama_produk | harga)
create table if not exists public.master_produk (
  id    bigserial primary key,
  kode  text not null,
  isbn  text not null default '',
  nama  text not null,
  harga bigint not null default 0
);

-- Produk yang dibawa ke pameran (dulu sheet produk_pameran_<tanggal>)
create table if not exists public.produk_pameran (
  id          bigserial primary key,
  event       text not null,
  event_norm  text generated always as (public.f_norm_event(event)) stored,
  cabang      text not null,
  tgl         date not null,
  kode        text not null,
  kode_norm   text generated always as (public.f_norm_kode(kode)) stored,
  isbn        text not null default '',
  nama        text not null,
  harga       bigint not null default 0,
  jumlah      integer not null,
  user_email  text not null default '',
  diperbarui  timestamptz not null default now(),
  constraint produk_pameran_unik unique (event_norm, cabang, tgl, kode_norm)
);
create index if not exists produk_pameran_cari_idx on public.produk_pameran (event_norm, cabang, tgl);

-- Header transaksi (dulu satu baris per item; kini dinormalisasi)
create table if not exists public.transaksi (
  id             text primary key,
  event          text not null,
  event_norm     text generated always as (public.f_norm_event(event)) stored,
  cabang         text not null,
  tgl            date not null,
  waktu          timestamptz not null default now(),
  kasir          text not null default '',
  metode         text not null check (metode in ('TUNAI', 'QRIS', 'DEBIT', 'TRANSFER')),
  total          bigint not null default 0,
  bayar          bigint not null default 0,
  kembali        bigint not null default 0,
  status         text not null default 'AKTIF' check (status in ('AKTIF', 'BATAL')),
  alasan_batal   text not null default '',
  dibatalkan_oleh text not null default '',
  waktu_batal    timestamptz,
  menggantikan   text not null default '',
  diperbarui     timestamptz not null default now()
);
create index if not exists transaksi_cari_idx on public.transaksi (event_norm, cabang, tgl);

create table if not exists public.transaksi_item (
  id           bigserial primary key,
  trx_id       text not null references public.transaksi(id) on delete cascade,
  urut         integer not null default 0,
  kode         text not null,
  kode_norm    text generated always as (public.f_norm_kode(kode)) stored,
  nama         text not null default '',
  harga        bigint not null,
  qty          integer not null,
  diskon_tipe  text not null default 'PERSEN',
  diskon_nilai numeric not null default 0,
  diskon_rp    bigint not null default 0,
  subtotal     bigint not null,
  net          bigint not null
);
create index if not exists transaksi_item_trx_idx on public.transaksi_item (trx_id);
create index if not exists transaksi_item_kode_idx on public.transaksi_item (kode_norm);

create table if not exists public.log_aktivitas (
  id     bigserial primary key,
  waktu  timestamptz not null default now(),
  fungsi text not null,
  hasil  text not null default ''
);

create or replace function public.f_catat(fn text, hasil text) returns void
language sql security definer set search_path = public as $$
  insert into public.log_aktivitas (fungsi, hasil) values (fn, coalesce(hasil, ''));
$$;

/* ---------------- Master produk ---------------- */

-- Cari persis (kode/ISBN, toleran ISBN-10/13 & nol di depan) lebih dulu;
-- bila tidak ada, cari kata kunci pada nama/kode/isbn (maks. 50 hasil).
create or replace function public.cari_master(p_q text, p_exact boolean default false)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  q text := btrim(coalesce(p_q, ''));
  vs text[];
  km text;
  kata1 text;
  m record;
  total bigint;
  hasil jsonb;
begin
  if q = '' then raise exception 'Kode atau kata kunci kosong'; end if;
  if length(q) > 100 then raise exception 'Kata kunci terlalu panjang'; end if;

  vs := public.f_varian(q);
  select * into m from public.master_produk
   where public.f_varian(kode) && vs or public.f_varian(isbn) && vs
   order by id limit 1;
  if found then
    return jsonb_build_object(
      'exact', jsonb_build_object('kode', m.kode, 'isbn', m.isbn, 'nama', m.nama, 'harga', m.harga),
      'hasil', '[]'::jsonb, 'total', 1);
  end if;
  if coalesce(p_exact, false) then
    return jsonb_build_object('exact', null, 'hasil', '[]'::jsonb, 'total', 0);
  end if;
  if length(q) < 3 then
    return jsonb_build_object('exact', null, 'hasil', '[]'::jsonb, 'total', 0);
  end if;

  km := lower(regexp_replace(q, '\s+', ' ', 'g'));
  kata1 := split_part(km, ' ', 1);

  select count(*) into total
    from public.master_produk mm
   where not exists (
     select 1 from unnest(regexp_split_to_array(km, ' ')) k
      where k <> '' and position(k in lower(mm.nama || ' ' || mm.kode || ' ' || mm.isbn)) = 0);

  select coalesce(jsonb_agg(jsonb_build_object(
           'kode', x.kode, 'isbn', x.isbn, 'nama', x.nama, 'harga', x.harga) order by x.skor, x.id), '[]'::jsonb)
    into hasil
    from (
      select mm.id, mm.kode, mm.isbn, mm.nama, mm.harga,
             case
               when lower(mm.nama) like kata1 || '%' then 0
               when position(kata1 in lower(mm.nama)) > 0 then 1
               else 2
             end as skor
        from public.master_produk mm
       where not exists (
         select 1 from unnest(regexp_split_to_array(km, ' ')) k
          where k <> '' and position(k in lower(mm.nama || ' ' || mm.kode || ' ' || mm.isbn)) = 0)
       order by skor, mm.id
       limit 50) x;

  return jsonb_build_object('exact', null, 'hasil', hasil, 'total', total);
end $$;

/* ---------------- Produk pameran ---------------- */

create or replace function public.f_get_produk_pameran(p_event text, p_cabang text, p_tgl date)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_event text := btrim(coalesce(p_event, '')); hasil jsonb;
begin
  if v_event = '' then raise exception 'Judul pameran kosong'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'kode', kode, 'isbn', isbn, 'nama', nama, 'harga', harga, 'jumlah', jumlah) order by id), '[]'::jsonb)
    into hasil
    from public.produk_pameran
   where event_norm = public.f_norm_event(v_event) and cabang = btrim(p_cabang) and tgl = p_tgl;
  return hasil;
end $$;

-- Nama & ISBN selalu diambil dari master_produk (bukan kiriman klien).
create or replace function public.f_simpan_produk_pameran(
  p_event text, p_cabang text, p_tgl date, p_kode text, p_harga jsonb, p_jumlah jsonb, p_user text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_event text := btrim(coalesce(p_event, ''));
  v_cabang text := btrim(coalesce(p_cabang, ''));
  v_kode text := btrim(coalesce(p_kode, ''));
  v_harga bigint;
  v_jumlah bigint;
  m record;
  sudah boolean;
begin
  if v_event = '' then raise exception 'Judul pameran kosong'; end if;
  v_harga := public.f_int(p_harga, 'Harga harus bilangan bulat ≥ 0');
  if v_harga < 0 then raise exception 'Harga harus bilangan bulat ≥ 0'; end if;
  v_jumlah := public.f_int(p_jumlah, 'Jumlah harus bilangan bulat ≥ 1');
  if v_jumlah < 1 or v_jumlah > 100000 then raise exception 'Jumlah harus bilangan bulat ≥ 1'; end if;

  select mp.* into m from public.master_produk mp
   where public.f_varian(mp.kode) && public.f_varian(v_kode)
      or public.f_varian(mp.isbn) && public.f_varian(v_kode)
   order by mp.id limit 1;
  if not found then
    raise exception 'Kode % tidak ada di tabel master_produk', left(v_kode, 40);
  end if;

  select exists (
    select 1 from public.produk_pameran pp
     where pp.event_norm = public.f_norm_event(v_event) and pp.cabang = v_cabang and pp.tgl = p_tgl
       and pp.kode_norm = public.f_norm_kode(m.kode)) into sudah;

  insert into public.produk_pameran (event, cabang, tgl, kode, isbn, nama, harga, jumlah, user_email, diperbarui)
  values (v_event, v_cabang, p_tgl, m.kode, m.isbn, m.nama, v_harga, v_jumlah, coalesce(p_user, ''), now())
  on conflict (event_norm, cabang, tgl, kode_norm) do update
     set isbn = excluded.isbn, nama = excluded.nama, harga = excluded.harga,
         jumlah = excluded.jumlah, user_email = excluded.user_email, diperbarui = now();

  return jsonb_build_object('diperbarui', sudah,
    'produk', jsonb_build_object('kode', m.kode, 'isbn', m.isbn, 'nama', m.nama,
                                 'harga', v_harga, 'jumlah', v_jumlah));
end $$;

create or replace function public.f_hapus_produk_pameran(p_event text, p_cabang text, p_tgl date, p_kode text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_event text := btrim(coalesce(p_event, ''));
  v_cabang text := btrim(coalesce(p_cabang, ''));
  nk text := public.f_norm_kode(p_kode);
  kode_hapus text;
begin
  if v_event = '' then raise exception 'Judul pameran kosong'; end if;
  if exists (
    select 1 from public.transaksi t
      join public.transaksi_item i on i.trx_id = t.id
     where t.event_norm = public.f_norm_event(v_event) and t.cabang = v_cabang and t.tgl = p_tgl
       and t.status = 'AKTIF' and i.kode_norm = nk) then
    raise exception 'Produk sudah dipakai di transaksi aktif — batalkan transaksinya dulu';
  end if;

  delete from public.produk_pameran pp
   where pp.event_norm = public.f_norm_event(v_event) and pp.cabang = v_cabang and pp.tgl = p_tgl
     and pp.kode_norm = nk
  returning pp.kode into kode_hapus;

  if kode_hapus is null then raise exception 'Produk tidak ditemukan di daftar pameran'; end if;
  perform public.f_catat('hapusProdukPameran', v_event || ' ' || v_cabang || ' ' || kode_hapus);
  return jsonb_build_object('dihapus', kode_hapus);
end $$;

/* ---------------- Transaksi pameran ---------------- */

-- Hitungan per item: sub = harga × qty; potongan = % dari sub atau nominal Rp (maks. sub); net = sub − potongan
create or replace function public.f_hitung_item(it jsonb) returns jsonb
language plpgsql immutable as $$
declare
  v_kode text := btrim(coalesce(it->>'kode', ''));
  v_harga bigint;
  v_qty bigint;
  v_tipe text;
  v_nilai numeric;
  v_sub bigint;
  v_pot bigint;
begin
  if v_kode = '' then raise exception 'Kode item kosong'; end if;
  v_harga := public.f_int(it->'harga', 'Harga item tidak valid');
  if v_harga < 0 then raise exception 'Harga item tidak valid'; end if;
  v_qty := public.f_int(it->'qty', 'Jumlah item tidak valid');
  if v_qty < 1 or v_qty > 100000 then raise exception 'Jumlah item tidak valid'; end if;
  v_tipe := case when it->>'diskonTipe' = 'RUPIAH' then 'RUPIAH' else 'PERSEN' end;
  begin
    v_nilai := coalesce((it->>'diskonNilai')::numeric, 0);
  exception when others then
    raise exception 'Diskon tidak valid';
  end;
  if v_nilai < 0 then raise exception 'Diskon tidak valid'; end if;
  v_sub := v_harga * v_qty;
  if v_tipe = 'PERSEN' then
    if v_nilai > 100 then raise exception 'Diskon persen maksimum 100%%'; end if;
    v_pot := round(v_sub * v_nilai / 100)::bigint;
  else
    v_pot := round(v_nilai)::bigint;
    if v_pot > v_sub then raise exception 'Potongan melebihi subtotal item'; end if;
  end if;
  return jsonb_build_object(
    'kode', left(v_kode, 40), 'nama', left(coalesce(it->>'nama', ''), 150),
    'harga', v_harga, 'qty', v_qty, 'tipe', v_tipe, 'nilai', v_nilai,
    'sub', v_sub, 'pot', v_pot, 'net', v_sub - v_pot);
end $$;

-- Tandai BATAL satu transaksi (tidak menghapus). Hanya pembuat atau ADMIN.
create or replace function public.f_batal_internal(
  p_event text, p_cabang text, p_tgl date, p_id text, p_alasan text, p_user text, p_role text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare t public.transaksi%rowtype;
begin
  select * into t from public.transaksi
   where id = p_id and event_norm = public.f_norm_event(p_event)
     and cabang = btrim(coalesce(p_cabang, '')) and tgl = p_tgl
   for update;
  if not found then return jsonb_build_object('ditemukan', false, 'sudah', false); end if;
  if not (upper(coalesce(p_role, '')) = 'ADMIN'
          or lower(t.kasir) = lower(coalesce(p_user, ''))) then
    raise exception 'Hanya pembuat transaksi atau admin yang boleh membatalkan';
  end if;
  if t.status = 'BATAL' then
    return jsonb_build_object('ditemukan', true, 'sudah', true);
  end if;
  update public.transaksi
     set status = 'BATAL', alasan_batal = p_alasan, dibatalkan_oleh = coalesce(p_user, ''),
         waktu_batal = now(), diperbarui = now()
   where id = t.id;
  return jsonb_build_object('ditemukan', true, 'sudah', false);
end $$;

-- p = {event, tgl, trx:{id, waktu, metode, items[], bayar, menggantikan?}}
-- Idempotent: ID yang sama dikirim ulang tidak menambah baris.
create or replace function public.f_simpan_transaksi(p jsonb, p_cabang text, p_user text, p_role text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_event text := btrim(coalesce(p->>'event', ''));
  tgl date;
  trx jsonb := coalesce(p->'trx', '{}'::jsonb);
  v_id text := coalesce(trx->>'id', '');
  metode text;
  items jsonb := coalesce(trx->'items', '[]'::jsonb);
  n integer;
  hits jsonb;
  it jsonb;
  i integer := 0;
  total bigint := 0;
  bayar numeric;
  waktu timestamptz := now();
  lama text;
  sudah boolean := false;
  lama_batal boolean := false;
  r jsonb;
begin
  if v_event = '' then raise exception 'Judul pameran kosong'; end if;
  tgl := public.f_tgl(p->>'tgl');
  if v_id !~ '^[A-Za-z0-9_-]{6,40}$' then raise exception 'ID transaksi tidak valid'; end if;
  metode := upper(coalesce(trx->>'metode', ''));
  if metode not in ('TUNAI', 'QRIS', 'DEBIT', 'TRANSFER') then raise exception 'Metode bayar tidak valid'; end if;
  n := jsonb_array_length(items);
  if n < 1 or n > 100 then raise exception 'Item transaksi kosong atau terlalu banyak'; end if;
  begin
    waktu := coalesce((trx->>'waktu')::timestamptz, now());
  exception when others then
    waktu := now();
  end;

  select jsonb_agg(public.f_hitung_item(x)) into hits from jsonb_array_elements(items) x;
  for it in select * from jsonb_array_elements(hits) loop
    total := total + (it->>'net')::bigint;
  end loop;

  begin
    bayar := (trx->>'bayar')::numeric;
  exception when others then
    bayar := null;
  end;
  if metode = 'TUNAI' then
    if bayar is null or bayar < total then raise exception 'Uang diterima kurang dari total'; end if;
  else
    bayar := total;
  end if;

  -- Kunci per ID agar dua perangkat yang mengirim ID sama tidak membuat baris dobel
  perform pg_advisory_xact_lock(hashtext(v_id));

  lama := nullif(btrim(coalesce(trx->>'menggantikan', '')), '');
  if lama is not null then
    r := public.f_batal_internal(v_event, p_cabang, tgl, lama, 'Dikoreksi → ' || v_id, p_user, p_role);
    lama_batal := coalesce((r->>'ditemukan')::boolean, false);
  end if;

  insert into public.transaksi
    (id, event, cabang, tgl, waktu, kasir, metode, total, bayar, kembali, status, menggantikan, diperbarui)
  values
    (v_id, v_event, btrim(coalesce(p_cabang, '')), tgl, waktu, coalesce(p_user, ''), metode,
     total, bayar::bigint, (bayar - total)::bigint, 'AKTIF', coalesce(lama, ''), now())
  on conflict (id) do nothing;

  if found then
    for it in select * from jsonb_array_elements(hits) loop
      insert into public.transaksi_item
        (trx_id, urut, kode, nama, harga, qty, diskon_tipe, diskon_nilai, diskon_rp, subtotal, net)
      values
        (v_id, i, it->>'kode', it->>'nama', (it->>'harga')::bigint, (it->>'qty')::integer,
         it->>'tipe', (it->>'nilai')::numeric, (it->>'pot')::bigint, (it->>'sub')::bigint, (it->>'net')::bigint);
      i := i + 1;
    end loop;
  else
    sudah := true;
  end if;

  return jsonb_build_object('tersimpan', v_id, 'sudah', sudah, 'total', total,
    'menggantikan', lama, 'menggantikanDibatalkan', lama_batal);
end $$;

create or replace function public.f_batalkan_transaksi(p jsonb, p_cabang text, p_user text, p_role text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_event text := btrim(coalesce(p->>'event', ''));
  v_id text := coalesce(p->>'id', '');
  alasan text := btrim(coalesce(p->>'alasan', ''));
  tgl date;
  r jsonb;
begin
  if v_event = '' then raise exception 'Judul pameran kosong'; end if;
  if length(alasan) < 3 or length(alasan) > 200 then raise exception 'Alasan pembatalan 3–200 karakter'; end if;
  tgl := public.f_tgl(p->>'tgl');
  r := public.f_batal_internal(v_event, p_cabang, tgl, v_id, alasan, p_user, p_role);
  if not coalesce((r->>'ditemukan')::boolean, false) then raise exception 'Transaksi tidak ditemukan'; end if;
  if not coalesce((r->>'sudah')::boolean, false) then
    perform public.f_catat('batalTransaksi', v_event || ' ' || btrim(p_cabang) || ' ' || v_id || ' — ' || alasan);
  end if;
  return jsonb_build_object('dibatalkan', v_id, 'sudah', coalesce((r->>'sudah')::boolean, false));
end $$;

-- p = {event, tgl} → daftar transaksi (aktif & batal) untuk cabang sesi
create or replace function public.f_get_transaksi(p_event text, p_cabang text, p_tgl date)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_event text := btrim(coalesce(p_event, '')); hasil jsonb;
begin
  if v_event = '' then raise exception 'Judul pameran kosong'; end if;
  select coalesce(jsonb_agg(x.j order by x.waktu, x.id), '[]'::jsonb) into hasil
    from (
      select t.id, t.waktu,
        jsonb_build_object(
          'id', t.id,
          'waktu', t.waktu,
          'kasirEmail', t.kasir,
          'metode', t.metode,
          'items', coalesce((
            select jsonb_agg(jsonb_build_object(
                     'kode', i.kode, 'nama', i.nama, 'harga', i.harga, 'qty', i.qty,
                     'diskonTipe', i.diskon_tipe, 'diskonNilai', i.diskon_nilai,
                     'diskon', i.diskon_rp, 'net', i.net, 'kategori', '', 'catatan', '')
                   order by i.urut, i.id)
              from public.transaksi_item i where i.trx_id = t.id), '[]'::jsonb),
          'subtotal', coalesce((select sum(i.subtotal) from public.transaksi_item i where i.trx_id = t.id), 0),
          'diskon', coalesce((select sum(i.diskon_rp) from public.transaksi_item i where i.trx_id = t.id), 0),
          'total', t.total,
          'bayar', t.bayar,
          'kembali', t.kembali,
          'deleted', t.status = 'BATAL',
          'batal', case when t.status = 'BATAL' then
                     jsonb_build_object('alasan', t.alasan_batal, 'oleh', t.dibatalkan_oleh, 'waktu', t.waktu_batal)
                   else null end,
          'menggantikan', t.menggantikan
        ) as j
        from public.transaksi t
       where t.event_norm = public.f_norm_event(v_event)
         and t.cabang = btrim(coalesce(p_cabang, '')) and t.tgl = p_tgl
    ) x;
  return hasil;
end $$;

/* ---------------- Auth / RBAC ---------------- */

create or replace function public.f_login(p_email text, p_pass text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_pass text := coalesce(p_pass, '');
  u public.users%rowtype;
  r public.login_rate%rowtype;
  v_token text;
begin
  -- Kegagalan login dikembalikan sebagai {ok:false,error} (bukan RAISE) supaya
  -- penghitung percobaan ikut ter-commit; RAISE akan me-rollback insert itu.
  select * into r from public.login_rate where email = v_email for update;
  if found and r.kunci_sampai is not null and r.kunci_sampai > now() then
    return jsonb_build_object('ok', false,
      'error', 'Terlalu banyak percobaan. Coba lagi 15 menit lagi');
  end if;
  if found and r.kunci_sampai is not null then
    update public.login_rate set gagal = 0, kunci_sampai = null where email = v_email;
  end if;

  select * into u from public.users where email = v_email;
  if not found or u.pass_hash <> extensions.crypt(v_pass, u.pass_hash) then
    insert into public.login_rate (email, gagal, kunci_sampai)
    values (v_email, 1, null)
    on conflict (email) do update
      set gagal = public.login_rate.gagal + 1,
          kunci_sampai = case when public.login_rate.gagal + 1 >= 5
                              then now() + interval '15 minutes'
                              else public.login_rate.kunci_sampai end;
    return jsonb_build_object('ok', false, 'error', 'Email atau kata sandi salah');
  end if;
  if not u.aktif then
    return jsonb_build_object('ok', false, 'error', 'Akun dinonaktifkan');
  end if;

  delete from public.login_rate where email = v_email;
  delete from public.sessions where kedaluwarsa <= now();
  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.sessions (token, email, kedaluwarsa)
  values (v_token, u.email, now() + interval '6 hours');
  perform public.f_catat('login', u.email || ' (' || u.role || ') OK');

  return jsonb_build_object(
    'ok', true,
    'user', jsonb_build_object('email', u.email, 'nama', u.nama, 'cabang', u.cabang, 'role', u.role),
    'session', jsonb_build_object('token', v_token,
      'user', jsonb_build_object('email', u.email, 'nama', u.nama, 'cabang', u.cabang, 'role', u.role)));
end $$;

create or replace function public.f_list_users() returns jsonb
language plpgsql security definer set search_path = public as $$
declare hasil jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
           'email', email, 'nama', nama, 'cabang', cabang, 'role', role, 'aktif', aktif) order by dibuat, email),
         '[]'::jsonb)
    into hasil from public.users;
  return hasil;
end $$;

create or replace function public.f_add_user(p_email text, p_nama text, p_cabang text, p_pass text, p_role text)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_cabang text := btrim(coalesce(p_cabang, ''));
  v_nama text;
begin
  if v_email = '' or v_cabang = '' or length(coalesce(p_pass, '')) < 6 then
    raise exception 'Data tidak lengkap (sandi ≥6)';
  end if;
  v_nama := coalesce(nullif(btrim(p_nama), ''), split_part(v_email, '@', 1));

  insert into public.users (email, nama, cabang, pass_hash, role)
  values (v_email, v_nama, v_cabang,
          extensions.crypt(p_pass, extensions.gen_salt('bf', 10)),
          case when upper(coalesce(p_role, '')) = 'ADMIN' then 'ADMIN' else 'USER' end)
  on conflict (email) do nothing;
  if not found then raise exception 'Email sudah terdaftar'; end if;

  perform public.f_catat('addUser', v_email || ' ' || v_cabang || ' ' || coalesce(p_role, ''));
  return jsonb_build_object('ditambahkan', v_email);
end $$;

create or replace function public.f_delete_user(p_email text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  u public.users%rowtype;
begin
  select * into u from public.users where email = v_email;
  if not found then raise exception 'User tidak ditemukan'; end if;
  if u.role = 'ADMIN' and (select count(*) from public.users where role = 'ADMIN') <= 1 then
    raise exception 'Tidak bisa menghapus admin terakhir';
  end if;
  delete from public.users where email = u.email;
  perform public.f_catat('deleteUser', u.email);
  return jsonb_build_object('dihapus', u.email);
end $$;

create or replace function public.f_test(p_name text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v_id bigint;
begin
  if p_name = 'ping' then
    return jsonb_build_object(
      'pong', to_char(now() at time zone 'Asia/Jakarta', 'YYYY-MM-DD HH24:MI:SS'),
      'database', 'supabase');
  end if;
  if p_name = 'seedTest' then
    insert into public.master_produk (kode, nama, harga)
    values ('TEST-' || floor(extract(epoch from now()) * 1000)::text, 'Produk Tes', 10000)
    returning id into v_id;
    perform public.f_catat('seedTest', 'baris tes ditambahkan ke master_produk');
    return jsonb_build_object('barisDitambahkan', v_id);
  end if;
  raise exception 'Test tidak dikenal: %', coalesce(p_name, '');
end $$;

/* ---------------- Router RPC ---------------- */

create or replace function public.rpc_call(
  p_action text, p_token text default '', p_payload jsonb default '{}'::jsonb)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  a text := coalesce(p_action, '');
  p jsonb := coalesce(p_payload, '{}'::jsonb);
  u public.users%rowtype;
  cabang text;
begin
  if a = 'login' then
    return public.f_login(p->>'email', p->>'pass');
  end if;
  if a = 'logout' then
    if coalesce(p_token, '') <> '' then
      delete from public.sessions where token = p_token;
    end if;
    return jsonb_build_object('keluar', true);
  end if;

  select us.* into u
    from public.sessions s join public.users us on us.email = s.email
   where s.token = coalesce(p_token, '') and s.kedaluwarsa > now();
  if not found then raise exception 'Sesi kedaluwarsa, silakan login ulang'; end if;
  if not u.aktif then raise exception 'Akun dinonaktifkan'; end if;

  if a in ('listUsers', 'addUser', 'deleteUser', 'test') and u.role <> 'ADMIN' then
    raise exception 'Halaman khusus Admin';
  end if;

  -- Cabang & user selalu dari sesi; hanya ADMIN yang boleh menyebut cabang lain
  cabang := btrim(u.cabang);
  if u.role = 'ADMIN' and nullif(btrim(coalesce(p->>'cabang', '')), '') is not null then
    cabang := btrim(p->>'cabang');
  end if;

  case a
    when 'listUsers' then return public.f_list_users();
    when 'addUser' then return public.f_add_user(p->>'email', p->>'nama', cabang, p->>'pass', p->>'role');
    when 'deleteUser' then return public.f_delete_user(p->>'email');
    when 'test' then return public.f_test(p->>'name');
    when 'cariMaster' then return public.cari_master(p->>'q', coalesce((p->>'exact')::boolean, false));
    when 'getProdukPameran' then
      return public.f_get_produk_pameran(p->>'event', cabang, public.f_tgl(p->>'tgl'));
    when 'simpanProdukPameran' then
      return public.f_simpan_produk_pameran(p->>'event', cabang, public.f_tgl(p->>'tgl'),
                                            p->>'kode', p->'harga', p->'jumlah', u.email);
    when 'hapusProdukPameran' then
      return public.f_hapus_produk_pameran(p->>'event', cabang, public.f_tgl(p->>'tgl'), p->>'kode');
    when 'getTransaksiPameran' then
      return public.f_get_transaksi(p->>'event', cabang, public.f_tgl(p->>'tgl'));
    when 'simpanTransaksiPameran' then
      return public.f_simpan_transaksi(p, cabang, u.email, u.role);
    when 'batalkanTransaksiPameran' then
      return public.f_batalkan_transaksi(p, cabang, u.email, u.role);
    else
      raise exception 'Aksi tidak dikenal: %', a;
  end case;
end $$;

/* ---------------- Keamanan akses ---------------- */

alter table public.users            enable row level security;
alter table public.sessions         enable row level security;
alter table public.login_rate       enable row level security;
alter table public.master_produk    enable row level security;
alter table public.produk_pameran   enable row level security;
alter table public.transaksi        enable row level security;
alter table public.transaksi_item   enable row level security;
alter table public.log_aktivitas    enable row level security;

-- Tidak ada policy: anon/authenticated tidak bisa menyentuh tabel langsung.
revoke all on table public.users          from anon, authenticated;
revoke all on table public.sessions       from anon, authenticated;
revoke all on table public.login_rate     from anon, authenticated;
revoke all on table public.master_produk  from anon, authenticated;
revoke all on table public.produk_pameran from anon, authenticated;
revoke all on table public.transaksi      from anon, authenticated;
revoke all on table public.transaksi_item from anon, authenticated;
revoke all on table public.log_aktivitas  from anon, authenticated;
revoke all on sequence public.master_produk_id_seq, public.produk_pameran_id_seq,
  public.transaksi_item_id_seq, public.log_aktivitas_id_seq
  from anon, authenticated;

-- Hanya router yang boleh dipanggil klien
revoke execute on function public.rpc_call(text, text, jsonb) from public;
grant execute on function public.rpc_call(text, text, jsonb) to anon, authenticated;

revoke execute on function public.cari_master(text, boolean) from public, anon, authenticated;
revoke execute on function public.f_norm_kode(text) from public, anon, authenticated;
revoke execute on function public.f_norm_event(text) from public, anon, authenticated;
revoke execute on function public.f_tgl(text) from public, anon, authenticated;
revoke execute on function public.f_int(jsonb, text) from public, anon, authenticated;
revoke execute on function public.f_isbn13_dari10(text) from public, anon, authenticated;
revoke execute on function public.f_isbn10_dari13(text) from public, anon, authenticated;
revoke execute on function public.f_varian(text) from public, anon, authenticated;
revoke execute on function public.f_catat(text, text) from public, anon, authenticated;
revoke execute on function public.f_get_produk_pameran(text, text, date) from public, anon, authenticated;
revoke execute on function public.f_simpan_produk_pameran(text, text, date, text, jsonb, jsonb, text) from public, anon, authenticated;
revoke execute on function public.f_hapus_produk_pameran(text, text, date, text) from public, anon, authenticated;
revoke execute on function public.f_hitung_item(jsonb) from public, anon, authenticated;
revoke execute on function public.f_batal_internal(text, text, date, text, text, text, text) from public, anon, authenticated;
revoke execute on function public.f_simpan_transaksi(jsonb, text, text, text) from public, anon, authenticated;
revoke execute on function public.f_batalkan_transaksi(jsonb, text, text, text) from public, anon, authenticated;
revoke execute on function public.f_get_transaksi(text, text, date) from public, anon, authenticated;
revoke execute on function public.f_login(text, text) from public, anon, authenticated;
revoke execute on function public.f_list_users() from public, anon, authenticated;
revoke execute on function public.f_add_user(text, text, text, text, text) from public, anon, authenticated;
revoke execute on function public.f_delete_user(text) from public, anon, authenticated;
revoke execute on function public.f_test(text) from public, anon, authenticated;

grant usage on schema public to anon, authenticated;

/* ---------------- Admin pertama (jalankan sekali, di SQL Editor) ----------------
   Ganti email & sandi di bawah (sandi ≥ 10 karakter), hapus tanda komentar,
   lalu Run. Jangan pernah menaruh sandi sungguhan di file yang di-commit.

insert into public.users (email, nama, cabang, pass_hash, role)
values ('admin@pameran.id', 'Admin', 'Pusat',
        extensions.crypt('GANTI_DENGAN_SANDI_KUAT', extensions.gen_salt('bf', 10)),
        'ADMIN')
on conflict (email) do nothing;
--------------------------------------------------------------------------------- */
