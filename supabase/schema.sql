/* ============================================================
   schema.sql — Database Supabase untuk Pencatatan Pameran
   ------------------------------------------------------------
   Jalankan SELURUH file ini sekali di Supabase:
     Dashboard → SQL Editor → New query → tempel → Run.

   Dijalankan di proyek Supabase aplikasi POS (yang sudah berjalan), dan
   AMAN untuk aplikasi POS tersebut:
     • semua tabel & fungsi pameran ada di schema sendiri: pameran
     • tabel POS (public.products, public.sales, dst.) tidak disentuh
     • satu-satunya objek kita di public adalah pintu RPC:
       public.pameran_rpc_call(...) → pameran.rpc_call(...)

   Akun & sandi TIDAK disimpan di sini. Login memakai Supabase Auth milik
   POS; identitas (nama, cabang, peran) dibaca dari public.profiles →
   public.roles / public.branches berdasarkan JWT yang dikirim klien.

   Tabel ditutup rapat dengan RLS (tanpa policy). Role `anon` tidak punya
   hak apa pun; hanya `authenticated` yang boleh memanggil pintu RPC.

   Aksi yang dilayani:
     profilSaya, listUsers, test, cariMaster, getProdukPameran,
     simpanProdukPameran, hapusProdukPameran, getTransaksiPameran,
     simpanTransaksiPameran, batalkanTransaksiPameran
   ============================================================ */

create schema if not exists extensions;
create schema if not exists pameran;
create extension if not exists pgcrypto with schema extensions;

-- Pengaman: file ini hanya masuk akal di proyek yang punya tabel POS.
do $$
begin
  if to_regclass('public.profiles') is null
     or to_regclass('public.roles') is null
     or to_regclass('public.branches') is null then
    raise exception 'Tabel POS (public.profiles / public.roles / public.branches) tidak ada. Jalankan file ini di proyek Supabase aplikasi POS, bukan proyek lain.';
  end if;
end $$;

/* ---------------- Utilitas (harus ada sebelum kolom generated) ---------------- */

-- Samakan format kode: abaikan spasi/tanda hubung & huruf besar-kecil
create or replace function pameran.f_norm_kode(v text) returns text
language sql immutable as $$
  select upper(regexp_replace(coalesce(v, ''), '[^0-9A-Za-z]', '', 'g'));
$$;

-- Judul pameran dibandingkan tanpa peduli huruf besar/kecil & spasi ganda
create or replace function pameran.f_norm_event(v text) returns text
language sql immutable as $$
  select lower(btrim(regexp_replace(coalesce(v, ''), '\s+', ' ', 'g')));
$$;

create or replace function pameran.f_tgl(v text) returns date
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
create or replace function pameran.f_int(v jsonb, pesan text) returns bigint
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
create or replace function pameran.f_isbn13_dari10(n text) returns text
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
create or replace function pameran.f_isbn10_dari13(n text) returns text
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
create or replace function pameran.f_varian(v text) returns text[]
language plpgsql immutable as $$
declare n text; out_arr text[] := '{}'; t text;
begin
  n := pameran.f_norm_kode(v);
  if n = '' then return out_arr; end if;
  out_arr := array[n];
  if n ~ '^[0-9]+$' then
    t := regexp_replace(n, '^0+', '');
    if t <> '' and t <> n then out_arr := out_arr || t; end if;
    if length(n) = 13 and left(n, 3) = '978' then
      out_arr := out_arr || pameran.f_isbn10_dari13(n);
    end if;
  end if;
  if n ~ '^[0-9]{9}[0-9X]$' then
    out_arr := out_arr || pameran.f_isbn13_dari10(n);
  end if;
  return out_arr;
end $$;

-- Sumber produk (dulu sheet "Master": produk_id | isbn | nama_produk | harga)
create table if not exists pameran.master_produk (
  id    bigserial primary key,
  kode  text not null,
  isbn  text not null default '',
  nama  text not null,
  harga bigint not null default 0
);

-- Produk yang dibawa ke pameran (dulu sheet produk_pameran_<tanggal>)
create table if not exists pameran.produk_pameran (
  id          bigserial primary key,
  event       text not null,
  event_norm  text generated always as (pameran.f_norm_event(event)) stored,
  cabang      text not null,
  tgl         date not null,
  kode        text not null,
  kode_norm   text generated always as (pameran.f_norm_kode(kode)) stored,
  isbn        text not null default '',
  nama        text not null,
  harga       bigint not null default 0,
  jumlah      integer not null,
  user_email  text not null default '',
  diperbarui  timestamptz not null default now(),
  constraint produk_pameran_unik unique (event_norm, cabang, tgl, kode_norm)
);
create index if not exists produk_pameran_cari_idx on pameran.produk_pameran (event_norm, cabang, tgl);

-- Header transaksi (dulu satu baris per item; kini dinormalisasi)
create table if not exists pameran.transaksi (
  id             text primary key,
  event          text not null,
  event_norm     text generated always as (pameran.f_norm_event(event)) stored,
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
create index if not exists transaksi_cari_idx on pameran.transaksi (event_norm, cabang, tgl);

create table if not exists pameran.transaksi_item (
  id           bigserial primary key,
  trx_id       text not null references pameran.transaksi(id) on delete cascade,
  urut         integer not null default 0,
  kode         text not null,
  kode_norm    text generated always as (pameran.f_norm_kode(kode)) stored,
  nama         text not null default '',
  harga        bigint not null,
  qty          integer not null,
  diskon_tipe  text not null default 'PERSEN',
  diskon_nilai numeric not null default 0,
  diskon_rp    bigint not null default 0,
  subtotal     bigint not null,
  net          bigint not null
);
create index if not exists transaksi_item_trx_idx on pameran.transaksi_item (trx_id);
create index if not exists transaksi_item_kode_idx on pameran.transaksi_item (kode_norm);

create table if not exists pameran.log_aktivitas (
  id     bigserial primary key,
  waktu  timestamptz not null default now(),
  fungsi text not null,
  hasil  text not null default ''
);

create or replace function pameran.f_catat(fn text, hasil text) returns void
language sql security definer set search_path = pameran, extensions as $$
  insert into pameran.log_aktivitas (fungsi, hasil) values (fn, coalesce(hasil, ''));
$$;

/* ---------------- Master produk ---------------- */

-- Cari persis (kode/ISBN, toleran ISBN-10/13 & nol di depan) lebih dulu;
-- bila tidak ada, cari kata kunci pada nama/kode/isbn (maks. 50 hasil).
create or replace function pameran.cari_master(p_q text, p_exact boolean default false)
returns jsonb
language plpgsql security definer set search_path = pameran, extensions as $$
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

  vs := pameran.f_varian(q);
  select * into m from pameran.master_produk
   where pameran.f_varian(kode) && vs or pameran.f_varian(isbn) && vs
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
    from pameran.master_produk mm
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
        from pameran.master_produk mm
       where not exists (
         select 1 from unnest(regexp_split_to_array(km, ' ')) k
          where k <> '' and position(k in lower(mm.nama || ' ' || mm.kode || ' ' || mm.isbn)) = 0)
       order by skor, mm.id
       limit 50) x;

  return jsonb_build_object('exact', null, 'hasil', hasil, 'total', total);
end $$;

/* ---------------- Produk pameran ---------------- */

create or replace function pameran.f_get_produk_pameran(p_event text, p_cabang text, p_tgl date)
returns jsonb
language plpgsql security definer set search_path = pameran, extensions as $$
declare v_event text := btrim(coalesce(p_event, '')); hasil jsonb;
begin
  if v_event = '' then raise exception 'Judul pameran kosong'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'kode', kode, 'isbn', isbn, 'nama', nama, 'harga', harga, 'jumlah', jumlah) order by id), '[]'::jsonb)
    into hasil
    from pameran.produk_pameran
   where event_norm = pameran.f_norm_event(v_event) and cabang = btrim(p_cabang) and tgl = p_tgl;
  return hasil;
end $$;

-- Nama & ISBN selalu diambil dari master_produk (bukan kiriman klien).
create or replace function pameran.f_simpan_produk_pameran(
  p_event text, p_cabang text, p_tgl date, p_kode text, p_harga jsonb, p_jumlah jsonb, p_user text)
returns jsonb
language plpgsql security definer set search_path = pameran, extensions as $$
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
  v_harga := pameran.f_int(p_harga, 'Harga harus bilangan bulat ≥ 0');
  if v_harga < 0 then raise exception 'Harga harus bilangan bulat ≥ 0'; end if;
  v_jumlah := pameran.f_int(p_jumlah, 'Jumlah harus bilangan bulat ≥ 1');
  if v_jumlah < 1 or v_jumlah > 100000 then raise exception 'Jumlah harus bilangan bulat ≥ 1'; end if;

  select mp.* into m from pameran.master_produk mp
   where pameran.f_varian(mp.kode) && pameran.f_varian(v_kode)
      or pameran.f_varian(mp.isbn) && pameran.f_varian(v_kode)
   order by mp.id limit 1;
  if not found then
    raise exception 'Kode % tidak ada di tabel master_produk', left(v_kode, 40);
  end if;

  select exists (
    select 1 from pameran.produk_pameran pp
     where pp.event_norm = pameran.f_norm_event(v_event) and pp.cabang = v_cabang and pp.tgl = p_tgl
       and pp.kode_norm = pameran.f_norm_kode(m.kode)) into sudah;

  insert into pameran.produk_pameran (event, cabang, tgl, kode, isbn, nama, harga, jumlah, user_email, diperbarui)
  values (v_event, v_cabang, p_tgl, m.kode, m.isbn, m.nama, v_harga, v_jumlah, coalesce(p_user, ''), now())
  on conflict (event_norm, cabang, tgl, kode_norm) do update
     set isbn = excluded.isbn, nama = excluded.nama, harga = excluded.harga,
         jumlah = excluded.jumlah, user_email = excluded.user_email, diperbarui = now();

  return jsonb_build_object('diperbarui', sudah,
    'produk', jsonb_build_object('kode', m.kode, 'isbn', m.isbn, 'nama', m.nama,
                                 'harga', v_harga, 'jumlah', v_jumlah));
end $$;

create or replace function pameran.f_hapus_produk_pameran(p_event text, p_cabang text, p_tgl date, p_kode text)
returns jsonb
language plpgsql security definer set search_path = pameran, extensions as $$
declare
  v_event text := btrim(coalesce(p_event, ''));
  v_cabang text := btrim(coalesce(p_cabang, ''));
  nk text := pameran.f_norm_kode(p_kode);
  kode_hapus text;
begin
  if v_event = '' then raise exception 'Judul pameran kosong'; end if;
  if exists (
    select 1 from pameran.transaksi t
      join pameran.transaksi_item i on i.trx_id = t.id
     where t.event_norm = pameran.f_norm_event(v_event) and t.cabang = v_cabang and t.tgl = p_tgl
       and t.status = 'AKTIF' and i.kode_norm = nk) then
    raise exception 'Produk sudah dipakai di transaksi aktif — batalkan transaksinya dulu';
  end if;

  delete from pameran.produk_pameran pp
   where pp.event_norm = pameran.f_norm_event(v_event) and pp.cabang = v_cabang and pp.tgl = p_tgl
     and pp.kode_norm = nk
  returning pp.kode into kode_hapus;

  if kode_hapus is null then raise exception 'Produk tidak ditemukan di daftar pameran'; end if;
  perform pameran.f_catat('hapusProdukPameran', v_event || ' ' || v_cabang || ' ' || kode_hapus);
  return jsonb_build_object('dihapus', kode_hapus);
end $$;

/* ---------------- Transaksi pameran ---------------- */

-- Hitungan per item: sub = harga × qty; potongan = % dari sub atau nominal Rp (maks. sub); net = sub − potongan
create or replace function pameran.f_hitung_item(it jsonb) returns jsonb
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
  v_harga := pameran.f_int(it->'harga', 'Harga item tidak valid');
  if v_harga < 0 then raise exception 'Harga item tidak valid'; end if;
  v_qty := pameran.f_int(it->'qty', 'Jumlah item tidak valid');
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
create or replace function pameran.f_batal_internal(
  p_event text, p_cabang text, p_tgl date, p_id text, p_alasan text, p_user text, p_role text)
returns jsonb
language plpgsql security definer set search_path = pameran, extensions as $$
declare t pameran.transaksi%rowtype;
begin
  select * into t from pameran.transaksi
   where id = p_id and event_norm = pameran.f_norm_event(p_event)
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
  update pameran.transaksi
     set status = 'BATAL', alasan_batal = p_alasan, dibatalkan_oleh = coalesce(p_user, ''),
         waktu_batal = now(), diperbarui = now()
   where id = t.id;
  return jsonb_build_object('ditemukan', true, 'sudah', false);
end $$;

-- p = {event, tgl, trx:{id, waktu, metode, items[], bayar, menggantikan?}}
-- Idempotent: ID yang sama dikirim ulang tidak menambah baris.
create or replace function pameran.f_simpan_transaksi(p jsonb, p_cabang text, p_user text, p_role text)
returns jsonb
language plpgsql security definer set search_path = pameran, extensions as $$
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
  tgl := pameran.f_tgl(p->>'tgl');
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

  select jsonb_agg(pameran.f_hitung_item(x)) into hits from jsonb_array_elements(items) x;
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
    r := pameran.f_batal_internal(v_event, p_cabang, tgl, lama, 'Dikoreksi → ' || v_id, p_user, p_role);
    lama_batal := coalesce((r->>'ditemukan')::boolean, false);
  end if;

  insert into pameran.transaksi
    (id, event, cabang, tgl, waktu, kasir, metode, total, bayar, kembali, status, menggantikan, diperbarui)
  values
    (v_id, v_event, btrim(coalesce(p_cabang, '')), tgl, waktu, coalesce(p_user, ''), metode,
     total, bayar::bigint, (bayar - total)::bigint, 'AKTIF', coalesce(lama, ''), now())
  on conflict (id) do nothing;

  if found then
    for it in select * from jsonb_array_elements(hits) loop
      insert into pameran.transaksi_item
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

create or replace function pameran.f_batalkan_transaksi(p jsonb, p_cabang text, p_user text, p_role text)
returns jsonb
language plpgsql security definer set search_path = pameran, extensions as $$
declare
  v_event text := btrim(coalesce(p->>'event', ''));
  v_id text := coalesce(p->>'id', '');
  alasan text := btrim(coalesce(p->>'alasan', ''));
  tgl date;
  r jsonb;
begin
  if v_event = '' then raise exception 'Judul pameran kosong'; end if;
  if length(alasan) < 3 or length(alasan) > 200 then raise exception 'Alasan pembatalan 3–200 karakter'; end if;
  tgl := pameran.f_tgl(p->>'tgl');
  r := pameran.f_batal_internal(v_event, p_cabang, tgl, v_id, alasan, p_user, p_role);
  if not coalesce((r->>'ditemukan')::boolean, false) then raise exception 'Transaksi tidak ditemukan'; end if;
  if not coalesce((r->>'sudah')::boolean, false) then
    perform pameran.f_catat('batalTransaksi', v_event || ' ' || btrim(p_cabang) || ' ' || v_id || ' — ' || alasan);
  end if;
  return jsonb_build_object('dibatalkan', v_id, 'sudah', coalesce((r->>'sudah')::boolean, false));
end $$;

-- p = {event, tgl} → daftar transaksi (aktif & batal) untuk cabang sesi
create or replace function pameran.f_get_transaksi(p_event text, p_cabang text, p_tgl date)
returns jsonb
language plpgsql security definer set search_path = pameran, extensions as $$
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
              from pameran.transaksi_item i where i.trx_id = t.id), '[]'::jsonb),
          'subtotal', coalesce((select sum(i.subtotal) from pameran.transaksi_item i where i.trx_id = t.id), 0),
          'diskon', coalesce((select sum(i.diskon_rp) from pameran.transaksi_item i where i.trx_id = t.id), 0),
          'total', t.total,
          'bayar', t.bayar,
          'kembali', t.kembali,
          'deleted', t.status = 'BATAL',
          'batal', case when t.status = 'BATAL' then
                     jsonb_build_object('alasan', t.alasan_batal, 'oleh', t.dibatalkan_oleh, 'waktu', t.waktu_batal)
                   else null end,
          'menggantikan', t.menggantikan
        ) as j
        from pameran.transaksi t
       where t.event_norm = pameran.f_norm_event(v_event)
         and t.cabang = btrim(coalesce(p_cabang, '')) and t.tgl = p_tgl
    ) x;
  return hasil;
end $$;

/* ---------------- Identitas: akun POS (Supabase Auth + profiles) ----------------
   Aplikasi pameran TIDAK menyimpan sandi sendiri. Pengguna login lewat
   Supabase Auth milik aplikasi POS, lalu setiap panggilan RPC membawa JWT.
   Identitas dibaca dari tabel POS:
     auth.users.id → public.profiles → public.roles, public.branches
   ------------------------------------------------------------------ */

-- Peran POS mana yang boleh membuka halaman Admin pameran?
-- Bila nama peran POS Anda lain (mis. "Pemilik Toko"), ubah pola di bawah.
create or replace function pameran.f_peran_admin(p_role text) returns boolean
language sql immutable as $$
  select coalesce(p_role, '') ~* '(admin|owner|manajer|manager|supervisor)'
$$;

-- Identitas pemanggil, dari klaim JWT yang disetel PostgREST.
create or replace function pameran.f_akun() returns jsonb
language plpgsql security definer set search_path = pameran, public, extensions as $$
declare
  v_klaim jsonb;
  v_sub text;
  v_admin boolean;
  r record;
begin
  begin
    v_klaim := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
  exception when others then
    v_klaim := null;
  end;
  v_sub := coalesce(
    nullif(v_klaim->>'sub', ''),
    nullif(current_setting('request.jwt.claim.sub', true), ''));
  if v_sub is null then
    raise exception 'Sesi kedaluwarsa, silakan login ulang';
  end if;

  select p.id, u.email,
         coalesce(nullif(btrim(p.full_name), ''), split_part(coalesce(u.email, ''), '@', 1)) as nama,
         b.id as cabang_id,
         coalesce(b.name, 'Semua cabang') as cabang,
         coalesce(rn.name, '') as role_pos,
         p.is_active
    into r
    from public.profiles p
    left join auth.users u on u.id = p.id
    left join public.roles rn on rn.id = p.role_id
    left join public.branches b on b.id = p.branch_id
   where p.id::text = v_sub;

  if not found then
    raise exception 'Akun ini tidak memiliki profil di aplikasi POS';
  end if;
  if r.is_active is not true then
    raise exception 'Akun dinonaktifkan';
  end if;

  v_admin := pameran.f_peran_admin(r.role_pos);
  if not v_admin and r.cabang_id is null then
    raise exception 'Akun belum ditetapkan ke cabang mana pun di POS';
  end if;

  return jsonb_build_object(
    'id', r.id, 'email', coalesce(r.email, ''), 'nama', r.nama,
    'cabang', r.cabang, 'cabang_id', r.cabang_id,
    'role', case when v_admin then 'ADMIN' else 'USER' end);
end $$;

-- Daftar pengguna POS (baca saja; akun dibuat di aplikasi POS).
create or replace function pameran.f_list_users() returns jsonb
language plpgsql security definer set search_path = pameran, public, extensions as $$
declare hasil jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
           'email', coalesce(u.email, ''),
           'nama', coalesce(p.full_name, ''),
           'cabang', coalesce(b.name, 'Semua cabang'),
           'role', case when pameran.f_peran_admin(rn.name) then 'ADMIN' else 'USER' end,
           'role_pos', coalesce(rn.name, ''),
           'aktif', p.is_active) order by p.full_name, u.email),
         '[]'::jsonb)
    into hasil
    from public.profiles p
    left join auth.users u on u.id = p.id
    left join public.roles rn on rn.id = p.role_id
    left join public.branches b on b.id = p.branch_id;
  return hasil;
end $$;

create or replace function pameran.f_test(p_name text) returns jsonb
language plpgsql security definer set search_path = pameran, extensions as $$
declare v_id bigint;
begin
  if p_name = 'ping' then
    return jsonb_build_object(
      'pong', to_char(now() at time zone 'Asia/Jakarta', 'YYYY-MM-DD HH24:MI:SS'),
      'database', 'supabase');
  end if;
  if p_name = 'seedTest' then
    insert into pameran.master_produk (kode, nama, harga)
    values ('TEST-' || floor(extract(epoch from now()) * 1000)::text, 'Produk Tes', 10000)
    returning id into v_id;
    perform pameran.f_catat('seedTest', 'baris tes ditambahkan ke master_produk');
    return jsonb_build_object('barisDitambahkan', v_id);
  end if;
  raise exception 'Test tidak dikenal: %', coalesce(p_name, '');
end $$;

/* ---------------- Router RPC ----------------
   Satu pintu untuk semua aksi. Identitas selalu diambil dari JWT
   (tidak pernah dari payload), jadi pengguna tidak bisa mengaku
   sebagai akun/cabang lain.                                         */

create or replace function pameran.rpc_call(
  p_action text, p_payload jsonb default '{}'::jsonb)
returns jsonb
language plpgsql security definer set search_path = pameran, public, extensions as $$
declare
  a text := coalesce(p_action, '');
  p jsonb := coalesce(p_payload, '{}'::jsonb);
  akun jsonb;
  email text;
  peran text;
  cabang text;
begin
  akun := pameran.f_akun();
  email := akun->>'email';
  peran := akun->>'role';

  if a = 'profilSaya' then
    return akun;
  end if;
  if a in ('listUsers', 'test') and peran <> 'ADMIN' then
    raise exception 'Halaman khusus Admin';
  end if;

  -- Cabang selalu dari profil POS; hanya ADMIN yang boleh menyebut cabang lain
  cabang := btrim(akun->>'cabang');
  if peran = 'ADMIN' and nullif(btrim(coalesce(p->>'cabang', '')), '') is not null then
    cabang := btrim(p->>'cabang');
  end if;

  case a
    when 'listUsers' then return pameran.f_list_users();
    when 'test' then return pameran.f_test(p->>'name');
    when 'cariMaster' then return pameran.cari_master(p->>'q', coalesce((p->>'exact')::boolean, false));
    when 'getProdukPameran' then
      return pameran.f_get_produk_pameran(p->>'event', cabang, pameran.f_tgl(p->>'tgl'));
    when 'simpanProdukPameran' then
      return pameran.f_simpan_produk_pameran(p->>'event', cabang, pameran.f_tgl(p->>'tgl'),
                                            p->>'kode', p->'harga', p->'jumlah', email);
    when 'hapusProdukPameran' then
      return pameran.f_hapus_produk_pameran(p->>'event', cabang, pameran.f_tgl(p->>'tgl'), p->>'kode');
    when 'getTransaksiPameran' then
      return pameran.f_get_transaksi(p->>'event', cabang, pameran.f_tgl(p->>'tgl'));
    when 'simpanTransaksiPameran' then
      return pameran.f_simpan_transaksi(p, cabang, email, peran);
    when 'batalkanTransaksiPameran' then
      return pameran.f_batalkan_transaksi(p, cabang, email, peran);
    else
      raise exception 'Aksi tidak dikenal: %', a;
  end case;
end $$;

/* ---------------- Pintu masuk publik (dipanggil klien) ----------------
   PostgREST hanya mengekspos schema public secara default, jadi cukup
   satu pembungkus tipis di public. Isi schema pameran tetap tertutup.
   Tidak perlu mengubah "Exposed schemas" di dashboard — penting agar
   aplikasi POS yang memakai proyek ini tidak ikut berubah.            */

drop function if exists public.pameran_rpc_call(text, text, jsonb);

create or replace function public.pameran_rpc_call(
  p_action text, p_payload jsonb default '{}'::jsonb)
returns jsonb
language sql
security definer
set search_path = pameran, extensions
as $$ select pameran.rpc_call(p_action, p_payload) $$;

/* ---------------- Keamanan akses ----------------
   Semua tabel pameran tertutup: hanya fungsi SECURITY DEFINER di atas
   yang membacanya. Pengguna yang login (role `authenticated` Supabase)
   hanya boleh memanggil public.pameran_rpc_call; `anon` tidak boleh
   memanggil apa pun karena login memakai Supabase Auth.                  */

alter table pameran.master_produk    enable row level security;
alter table pameran.produk_pameran   enable row level security;
alter table pameran.transaksi        enable row level security;
alter table pameran.transaksi_item   enable row level security;
alter table pameran.log_aktivitas    enable row level security;

revoke all on table pameran.master_produk    from anon, authenticated;
revoke all on table pameran.produk_pameran   from anon, authenticated;
revoke all on table pameran.transaksi        from anon, authenticated;
revoke all on table pameran.transaksi_item   from anon, authenticated;
revoke all on table pameran.log_aktivitas    from anon, authenticated;
revoke all on sequence pameran.master_produk_id_seq, pameran.produk_pameran_id_seq,
  pameran.transaksi_item_id_seq, pameran.log_aktivitas_id_seq from anon, authenticated;

revoke execute on function pameran.rpc_call(text, jsonb) from public, anon, authenticated;
revoke execute on function pameran.f_akun() from public, anon, authenticated;
revoke execute on function pameran.f_peran_admin(text) from public, anon, authenticated;
revoke execute on function pameran.f_list_users() from public, anon, authenticated;
revoke execute on function pameran.f_test(text) from public, anon, authenticated;
revoke execute on function pameran.cari_master(text, boolean) from public, anon, authenticated;
revoke execute on function pameran.f_norm_kode(text) from public, anon, authenticated;
revoke execute on function pameran.f_norm_event(text) from public, anon, authenticated;
revoke execute on function pameran.f_tgl(text) from public, anon, authenticated;
revoke execute on function pameran.f_int(jsonb, text) from public, anon, authenticated;
revoke execute on function pameran.f_isbn13_dari10(text) from public, anon, authenticated;
revoke execute on function pameran.f_isbn10_dari13(text) from public, anon, authenticated;
revoke execute on function pameran.f_varian(text) from public, anon, authenticated;
revoke execute on function pameran.f_catat(text, text) from public, anon, authenticated;
revoke execute on function pameran.f_get_produk_pameran(text, text, date) from public, anon, authenticated;
revoke execute on function pameran.f_simpan_produk_pameran(text, text, date, text, jsonb, jsonb, text) from public, anon, authenticated;
revoke execute on function pameran.f_hapus_produk_pameran(text, text, date, text) from public, anon, authenticated;
revoke execute on function pameran.f_hitung_item(jsonb) from public, anon, authenticated;
revoke execute on function pameran.f_batal_internal(text, text, date, text, text, text, text) from public, anon, authenticated;
revoke execute on function pameran.f_simpan_transaksi(jsonb, text, text, text) from public, anon, authenticated;
revoke execute on function pameran.f_batalkan_transaksi(jsonb, text, text, text) from public, anon, authenticated;
revoke execute on function pameran.f_get_transaksi(text, text, date) from public, anon, authenticated;

-- Objek internal tidak boleh dijangkau lewat nama schema, bahkan bila
-- suatu saat ada fungsi yang lupa dicabut haknya.
revoke all on schema pameran from public, anon, authenticated;

-- Satu-satunya pintu untuk pengguna yang sudah login.
revoke execute on function public.pameran_rpc_call(text, jsonb) from public, anon;
grant execute on function public.pameran_rpc_call(text, jsonb) to authenticated;

/* ---------------- Berbagi tabel dengan aplikasi lain (opsional) ----------------
   Aplikasi POS tidak perlu ini: ia tidak menyentuh schema pameran.
   Bila nanti ada aplikasi lain yang harus MEMBACA data pameran:

     grant usage on schema pameran to app_lain;
     grant select on all tables in schema pameran to app_lain;

   Hanya baca — RLS tetap aktif dan tidak ada policy tulis untuk role itu.
   Jangan memberi `anon` akses apa pun ke schema ini.
   ------------------------------------------------------------------------------ */
