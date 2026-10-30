/* ============================================================
   app.js — Logika aplikasi Pencatatan Pemeran
   3 sesi: Persiapan → Pemeran → Penginputan
   Pola mengikuti index.html (ScanStock): screen switching,
   modal overlay, toast, tema tersimpan di localStorage.
   ============================================================ */
(function () {
  'use strict';

  const THEME_KEY = 'pameran.theme';
  let evtId = null;          // id event aktif
  let keranjang = [];        // item transaksi yang belum disimpan
  let produkTerpilih = null; // produk pada form tambah produk

  /* ---------------- Util ---------------- */
  const $ = (id) => document.getElementById(id);

  function rupiah(n) {
    return 'Rp ' + Number(n || 0).toLocaleString('id-ID');
  }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  window.toast = function (pesan, jenis) {
    const area = $('toastArea');
    if (!area) return;
    const t = document.createElement('div');
    t.className = 'toast' + (jenis ? ' ' + jenis : '');
    t.textContent = pesan;
    area.appendChild(t);
    setTimeout(() => t.remove(), 2600);
  };

  function showModalBox(judul, isiHtml, tombolHtml) {
    $('modalJudul').textContent = judul;
    $('modalIsi').innerHTML = isiHtml;
    $('modalKaki').innerHTML = tombolHtml ||
      '<button class="btn btn-primary btn-block" onclick="tutupModal()">Tutup</button>';
    $('modalUmum').classList.add('open');
  }
  window.tutupModal = function () { $('modalUmum').classList.remove('open'); };

  /* ---------------- Navigasi layar ---------------- */
  const SCREENS = ['home', 'persiapan', 'pameran', 'penginputan'];
  window.goScreen = function (nama) {
    SCREENS.forEach((s) => {
      const el = $('scr-' + s);
      if (el) el.classList.toggle('active', s === nama);
    });
    document.querySelectorAll('.seg-nav button[data-screen]').forEach((b) => {
      b.classList.toggle('aktif', b.dataset.screen === nama);
    });
    if (nama === 'persiapan') renderPersiapan();
    if (nama === 'pameran') renderPameran();
    if (nama === 'penginputan') renderPenginputan();
    window.scrollTo({ top: 0 });
  };

  /* ---------------- Tema ---------------- */
  function terapkanTheme(dark) {
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    try { localStorage.setItem(THEME_KEY, dark ? 'dark' : 'light'); } catch (e) {}
  }
  window.toggleTheme = function () {
    const dark = document.documentElement.getAttribute('data-theme') !== 'dark';
    terapkanTheme(dark);
  };

  /* ================= HOME / EVENT ================= */
  function renderHome() {
    const list = Store.getEvents();
    const box = $('homeEventList');
    if (!list.length) {
      box.innerHTML = '<div class="empty-state">Belum ada pameran.<br>Buat pameran baru untuk mulai mencatat.</div>';
      return;
    }
    box.innerHTML = list
      .slice()
      .sort((a, b) => (b.tanggal || '').localeCompare(a.tanggal || ''))
      .map((e) => {
        const aktif = e.id === Store.getActiveId();
        const nTrans = Store.getTransaksi(e.id).filter((t) => !t.deleted).length;
        const chip = e.selesai
          ? '<span class="chip chip-ok">Selesai</span>'
          : aktif ? '<span class="chip chip-teal">Aktif</span>' : '';
        return `
        <div class="data-item ${aktif ? 'head' : ''}">
          <div class="data-top">
            <span class="data-nama">${esc(e.nama)}</span>
            <span class="data-time">${esc(e.tanggal)}</span>
          </div>
          <div class="data-meta">
            ${chip}<span>${nTrans} transaksi</span>
            ${e.catatan ? '<span>· ' + esc(e.catatan) + '</span>' : ''}
          </div>
          <div class="btn-row" style="margin-top:8px">
            <button class="btn btn-sm ${aktif ? 'btn-secondary' : 'btn-primary'}" onclick="bukaEvent('${e.id}')">${aktif ? 'Lanjut' : 'Buka'}</button>
            <button class="btn btn-sm btn-ghost" onclick="selesaiEvent('${e.id}')">${e.selesai ? 'Buka lagi' : 'Tandai selesai'}</button>
            <button class="btn btn-sm btn-danger" onclick="hapusEvent('${e.id}')">Hapus</button>
          </div>
        </div>`;
      })
      .join('');
  }

  window.buatEventBaru = function () {
    showModalBox('Buat Pameran Baru', `
      <div class="form-group"><label class="form-label" for="evNama">Nama pameran</label>
        <input type="text" id="evNama" placeholder="Pemeran Buku Oktober 2026"></div>
      <div class="form-group"><label class="form-label" for="evTanggal">Tanggal</label>
        <input type="date" id="evTanggal" value="${new Date().toISOString().slice(0, 10)}"></div>
      <div class="form-group"><label class="form-label" for="evCatatan">Catatan (opsional)</label>
        <input type="text" id="evCatatan" placeholder="Lokasi, booth, dll"></div>
    `, `<div class="btn-row">
        <button class="btn btn-secondary" onclick="tutupModal()">Batal</button>
        <button class="btn btn-primary" onclick="simpanEventBaru()">Simpan & Buka</button>
      </div>`);
    setTimeout(() => $('evNama') && $('evNama').focus(), 50);
  };

  window.simpanEventBaru = function () {
    const ev = Store.buatEvent($('evNama').value, $('evTanggal').value, $('evCatatan').value);
    tutupModal();
    bukaEvent(ev.id);
    toast('Pameran "' + ev.nama + '" dibuat', 'ok');
  };

  window.bukaEvent = function (id) {
    Store.setActiveId(id);
    evtId = id;
    const ev = Store.getActiveEvent();
    $('homeEventInfo').textContent = ev ? ev.nama + ' · ' + ev.tanggal : '';
    renderHome();
    goScreen('persiapan');
  };

  window.hapusEvent = function (id) {
    const ev = Store.getEvents().find((e) => e.id === id);
    if (!ev) return;
    showModalBox('Hapus pameran?', `<p>“${esc(ev.nama)}” beserta seluruh datanya akan dihapus permanen.</p>`,
      `<div class="btn-row">
        <button class="btn btn-secondary" onclick="tutupModal()">Batal</button>
        <button class="btn btn-danger" onclick="Store.hapusEvent('${id}');renderHome();tutupModal();toast('Pameran dihapus')">Hapus</button>
      </div>`);
  };

  window.selesaiEvent = function (id) {
    const ev = Store.getEvents().find((e) => e.id === id);
    if (!ev) return;
    Store.updateEvent(id, { selesai: ev.selesai ? null : new Date().toISOString() });
    renderHome();
    toast(ev.selesai ? 'Dibuka kembali' : 'Ditandai selesai', 'ok');
  };

  function butuhEvent() {
    if (!evtId || !Store.getActiveEvent()) {
      toast('Buka pameran dulu dari beranda', 'err');
      goScreen('home');
      renderHome();
      return false;
    }
    return true;
  }

  /* ================= SESI 1 — PERSIAPAN ================= */
  function renderPersiapan() {
    if (!butuhEvent()) return;
    const ev = Store.getActiveEvent();
    $('pspJudul').textContent = ev.nama;
    $('pspSub').textContent = ev.tanggal + (ev.catatan ? ' · ' + ev.catatan : '');

    // Checklist
    const cek = Store.getCek(evtId);
    const done = cek.filter((c) => c.done).length;
    $('pspCekProgress').textContent = done + '/' + cek.length;
    $('pspCekBar').style.width = cek.length ? Math.round((done / cek.length) * 100) + '%' : '0%';
    $('psnCekList').innerHTML = cek.map((c, i) => `
      <li class="${c.done ? 'done' : ''}">
        <span class="check-box" role="checkbox" aria-checked="${!!c.done}" tabindex="0"
              onclick="toggleCek(${i})" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();toggleCek(${i})}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
        </span>
        <span class="cek-label" style="flex:1">${esc(c.teks)}</span>
        <button class="cart-remove" title="Hapus item" onclick="hapusCek(${i})">×</button>
      </li>`).join('');

    // Stok awal per produk
    renderStokAwal();
  }
  window.renderPersiapan = renderPersiapan;

  window.tambahCek = function () {
    const inp = $('psnCekBaru');
    const teks = (inp.value || '').trim();
    if (!teks) return;
    const cek = Store.getCek(evtId);
    cek.push({ teks, done: false });
    Store.setCek(evtId, cek);
    inp.value = '';
    renderPersiapan();
  };

  window.toggleCek = function (i) {
    const cek = Store.getCek(evtId);
    cek[i].done = !cek[i].done;
    Store.setCek(evtId, cek);
    renderPersiapan();
  };

  window.hapusCek = function (i) {
    const cek = Store.getCek(evtId);
    cek.splice(i, 1);
    Store.setCek(evtId, cek);
    renderPersiapan();
  };

  function renderStokAwal() {
    const stok = Store.getStokAwal(evtId);
    const produk = Store.getProducts();
    $('pspStokList').innerHTML = produk.map((p) => `
      <div class="input-row">
        <div style="min-width:0">
          <strong style="font-size:var(--text-sm);display:block">${esc(p.nama)}</strong>
          <span class="card-subtitle">${esc(p.kode)} · ${rupiah(p.harga)}</span>
        </div>
        <input class="inp-qty" type="number" min="0" inputmode="numeric" placeholder="0"
               value="${stok[p.kode] != null ? stok[p.kode] : ''}"
               onchange="setStokProduk('${esc(p.kode)}', this.value)" aria-label="Stok awal ${esc(p.nama)}">
        <span class="chip">${esc(p.kategori)}</span>
        <span></span>
      </div>`).join('');
    const totalStok = Object.values(stok).reduce((a, b) => a + Number(b || 0), 0);
    $('pspStat').innerHTML = `
      <div class="stat"><span class="stat-value">${produk.length}</span><span class="stat-label">Produk</span></div>
      <div class="stat"><span class="stat-value">${totalStok}</span><span class="stat-label">Total stok</span></div>`;
  }

  window.setStokProduk = function (kode, val) {
    const stok = Store.getStokAwal(evtId);
    const n = parseInt(val, 10);
    if (isNaN(n) || n < 0) delete stok[kode];
    else stok[kode] = n;
    Store.setStokAwal(evtId, stok);
    renderStokAwal();
    toast('Stok ' + kode + ' disimpan', 'ok');
  };

  /* ================= SESI 2 — PEMERAN ================= */
  let hasilCariTimer = null;

  function renderPameran() {
    if (!butuhEvent()) return;
    renderKeranjang();
    renderRiwayatTransaksi();
  }
  window.renderPameran = renderPameran;

  window.cariProduk = function (q) {
    clearTimeout(hasilCariTimer);
    hasilCariTimer = setTimeout(() => {
      const panel = $('pmHasilCari');
      const kata = (q || '').trim().toLowerCase();
      if (!kata) { panel.style.display = 'none'; panel.innerHTML = ''; return; }
      const hasil = Store.getProducts().filter(
        (p) => p.nama.toLowerCase().includes(kata) || p.kode.toLowerCase().includes(kata)
      ).slice(0, 20);
      if (!hasil.length) {
        panel.innerHTML = '<div class="result-item"><span class="result-sub">Tidak ditemukan — tambahkan lewat "Produk Baru"</span></div>';
      } else {
        panel.innerHTML = hasil.map((p) => `
          <div class="result-item" data-kode="${esc(p.kode)}" onclick="pilihKode(this.dataset.kode)">
            <span class="result-nama">${esc(p.nama)}</span>
            <span class="result-sub"><span>${esc(p.kode)}</span><span>${rupiah(p.harga)}</span><span>${esc(p.kategori)}</span></span>
          </div>`).join('');
      }
      panel.style.display = '';
    }, 120);
  };

  window.beriFokusCari = function () {
    const inp = $('pmCari');
    inp.focus();
    inp.select();
  };

  window.pilihKode = function (kode) {
    const p = Store.findProduct(kode);
    if (p) pilihProduk(p);
  };

  window.pilihProduk = function (p) {
    $('pmHasilCari').style.display = 'none';
    $('pmCari').value = '';
    produkTerpilih = p;
    $('pmProdukInfo').style.display = '';
    $('pmProdukNama').textContent = p.nama;
    $('pmProdukSub').textContent = p.kode + ' · ' + rupiah(p.harga);
    $('pmQty').value = 1;
    $('pmQty').focus();
  };

  window.stepQty = function (d) {
    const inp = $('pmQty');
    const v = Math.max(1, (parseInt(inp.value, 10) || 0) + d);
    inp.value = v;
  };

  window.tambahKeKeranjang = function () {
    if (!produkTerpilih) { toast('Pilih produk dulu', 'err'); return; }
    const qty = parseInt($('pmQty').value, 10);
    if (!qty || qty < 1) { toast('Jumlah tidak valid', 'err'); return; }
    const ket = ($('pmCatatanItem').value || '').trim();
    const idx = keranjang.findIndex((k) => k.produk.kode === produkTerpilih.kode && k.catatan === ket);
    if (idx >= 0) keranjang[idx].qty += qty;
    else keranjang.push({ produk: produkTerpilih, qty, catatan: ket });
    $('pmCatatanItem').value = '';
    produkTerpilih = null;
    $('pmProdukInfo').style.display = 'none';
    renderKeranjang();
    toast('Ditambah ke keranjang', 'ok');
  };

  window.hapusKeranjang = function (i) {
    keranjang.splice(i, 1);
    renderKeranjang();
  };

  function renderKeranjang() {
    const list = $('pmKeranjang');
    if (!keranjang.length) {
      list.innerHTML = '<div class="empty-state">Keranjang kosong. Cari produk lalu tekan “Tambah ke Keranjang”.</div>';
    } else {
      list.innerHTML = '<ul class="cart-list">' + keranjang.map((k, i) => `
        <li class="cart-item">
          <div class="cart-info">
            <span class="cart-nama">${esc(k.produk.nama)} × ${k.qty}</span>
            <span class="cart-sub">${esc(k.produk.kode)}${k.catatan ? ' · ' + esc(k.catatan) : ''}</span>
          </div>
          <strong>${rupiah(k.produk.harga * k.qty)}</strong>
          <button class="cart-remove" onclick="hapusKeranjang(${i})" aria-label="Hapus">×</button>
        </li>`).join('') + '</ul>';
    }
    const totalItem = keranjang.reduce((a, k) => a + k.qty, 0);
    const totalRp = keranjang.reduce((a, k) => a + k.qty * k.produk.harga, 0);
    $('pmTotItem').textContent = totalItem;
    $('pmTotRp').textContent = rupiah(totalRp);
    $('pmBayarRow').style.display = keranjang.length ? '' : 'none';
    updateBadgeNav();
  }

  window.simpanTransaksi = function () {
    if (!butuhEvent()) return;
    if (!keranjang.length) { toast('Keranjang kosong', 'err'); return; }
    const metode = ($('pmMetode') || {}).value || 'TUNAI';
    const bayar = parseFloat($('pmTunai') ? $('pmTunai').value : '') || 0;
    const total = keranjang.reduce((a, k) => a + k.qty * k.produk.harga, 0);
    const trx = {
      id: Store.uid(),
      waktu: new Date().toISOString(),
      metode,
      bayar: metode === 'TUNAI' ? bayar : total,
      total,
      items: keranjang.map((k) => ({ kode: k.produk.kode, nama: k.produk.nama, harga: k.produk.harga, qty: k.qty, kategori: k.produk.kategori, catatan: k.catatan })),
      kasir: '',
      deleted: false,
    };
    const semua = Store.getTransaksi(evtId);
    semua.push(trx);
    Store.setTransaksi(evtId, semua);
    keranjang = [];
    if ($('pmTunai')) $('pmTunai').value = '';
    renderKeranjang();
    renderRiwayatTransaksi();
    toast('Transaksi disimpan (' + rupiah(total) + ')', 'ok');
  };

  function renderRiwayatTransaksi() {
    const semua = Store.getTransaksi(evtId).filter((t) => !t.deleted);
    const box = $('pmRiwayat');
    const hariIni = new Date().toISOString().slice(0, 10);
    const hariIniTrx = semua.filter((t) => t.waktu.slice(0, 10) === hariIni);
    $('pmStat').innerHTML = `
      <div class="stat"><span class="stat-value">${hariIniTrx.length}</span><span class="stat-label">Transaksi</span></div>
      <div class="stat"><span class="stat-value">${hariIniTrx.reduce((a, t) => a + t.items.reduce((x, i) => x + i.qty, 0), 0)}</span><span class="stat-label">Pcs terjual</span></div>
      <div class="stat"><span class="stat-value">${rupiah(hariIniTrx.reduce((a, t) => a + t.total, 0))}</span><span class="stat-label">Omzet</span></div>`;
    if (!semua.length) {
      box.innerHTML = '<div class="empty-state">Belum ada transaksi hari ini.</div>';
      return;
    }
    box.innerHTML = '<div class="data-list">' + semua.slice().reverse().slice(0, 30).map((t) => `
      <div class="data-item">
        <div class="data-top">
          <span class="data-nama">${rupiah(t.total)}</span>
          <span class="data-time">${new Date(t.waktu).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}</span>
        </div>
        <div class="data-meta">
          <span class="chip ${t.metode === 'TUNAI' ? 'chip-ok' : 'chip-warn'}">${esc(t.metode)}</span>
          <span>${t.items.map((i) => esc(i.nama) + '×' + i.qty).join(', ')}</span>
        </div>
        <button class="btn btn-sm btn-danger" style="margin-top:6px" onclick="hapusTransaksi('${t.id}')">Hapus</button>
      </div>`).join('') + '</div>';
  }

  window.hapusTransaksi = function (id) {
    const semua = Store.getTransaksi(evtId);
    const t = semua.find((x) => x.id === id);
    if (!t) return;
    t.deleted = true;
    Store.setTransaksi(evtId, semua);
    renderRiwayatTransaksi();
    toast('Transaksi dihapus (soft-delete)', 'ok');
  };

  /* ================= SESI 3 — PENGINPUTAN ================= */
  function renderPenginputan() {
    if (!butuhEvent()) return;
    renderFormInput();
    renderDaftarInput();
    renderRekap();
  }
  window.renderPenginputan = renderPenginputan;

  function renderFormInput() {
    const sel = $('piProduk');
    const produk = Store.getProducts();
    sel.innerHTML = '<option value="">— pilih produk —</option>' +
      produk.map((p) => `<option value="${esc(p.kode)}">${esc(p.kode)} — ${esc(p.nama)}</option>`).join('');
  }

  window.simpanInputManual = function () {
    const kode = $('piProduk').value;
    const qty = parseInt($('piQty'), 10);
    const kat = $('piKategori').value;
    const ket = $('piCatatan').value.trim();
    if (!kode) { toast('Pilih produk', 'err'); return; }
    if (!qty || qty < 1) { toast('Jumlah tidak valid', 'err'); return; }
    const p = Store.findProduct(kode);
    const semua = Store.getInputan(evtId);
    semua.push({
      id: Store.uid(),
      waktu: new Date().toISOString(),
      kode, nama: p ? p.nama : kode, qty, kategori: kat, catatan: ket, deleted: false,
    });
    Store.setInputan(evtId, semua);
    $('piQty').value = '';
    $('piCatatan').value = '';
    renderDaftarInput();
    renderRekap();
    toast('Input tercatat +' + qty + ' pcs', 'ok');
  };

  function renderDaftarInput() {
    const semua = Store.getInputan(evtId);
    const box = $('piDaftar');
    const hidup = semua.filter((x) => !x.deleted);
    if (!hidup.length) {
      box.innerHTML = '<div class="empty-state">Belum ada input manual.</div>';
      return;
    }
    box.innerHTML = '<div class="data-list">' + hidup.slice().reverse().map((x) => `
      <div class="data-item">
        <div class="data-top">
          <span class="data-nama">+${x.qty} pcs — ${esc(x.nama)}</span>
          <span class="data-time">${new Date(x.waktu).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}</span>
        </div>
        <div class="data-meta"><span class="chip">${esc(x.kategori)}</span>${x.catatan ? '<span>' + esc(x.catatan) + '</span>' : ''}</div>
        <button class="btn btn-sm btn-danger" style="margin-top:6px" onclick="hapusInput('${x.id}')">Hapus</button>
      </div>`).join('') + '</div>';
  }

  window.hapusInput = function (id) {
    const semua = Store.getInputan(evtId);
    const x = semua.find((y) => y.id === id);
    if (!x) return;
    x.deleted = true;
    Store.setInputan(evtId, semua);
    renderDaftarInput();
    renderRekap();
  };

  function renderRekap() {
    const stok = Store.getStokAwal(evtId);
    const trx = Store.getTransaksi(evtId).filter((t) => !t.deleted);
    const inputs = Store.getInputan(evtId).filter((x) => !x.deleted);
    const keluar = {};
    trx.forEach((t) => t.items.forEach((i) => { keluar[i.kode] = (keluar[i.kode] || 0) + i.qty; }));
    const masuk = {};
    inputs.forEach((x) => { masuk[x.kode] = (masuk[x.kode] || 0) + x.qty; });

    const rows = [['Kode', 'Produk', 'Kategori', 'Stok Awal', 'Terjual', 'Input Manual', 'Sisa Estimasi']];
    Store.getProducts().forEach((p) => {
      const aw = stok[p.kode] || 0, klr = keluar[p.kode] || 0, msk = masuk[p.kode] || 0;
      rows.push([p.kode, p.nama, p.kategori, aw, klr, msk, aw - klr + msk]);
    });
    $('piRekapNote').textContent =
      'Sisa estimasi = stok awal − terjual + input manual. Transaksi: ' + trx.length + ', input: ' + inputs.length + '.';
    window._rekapRows = rows;
  }

  window.unduhRekap = function () {
    if (!butuhEvent()) return;
    renderRekap();
    const ev = Store.getActiveEvent();
    Store.unduhCSV('rekap-' + ev.nama.replace(/\s+/g, '-').toLowerCase() + '.csv', window._rekapRows);
    toast('CSV rekap diunduh', 'ok');
  };

  window.unduhTransaksiCsv = function () {
    if (!butuhEvent()) return;
    const trx = Store.getTransaksi(evtId).filter((t) => !t.deleted);
    const rows = [['Waktu', 'Metode', 'Kode', 'Produk', 'Kategori', 'Qty', 'Harga', 'Subtotal', 'Catatan']];
    trx.forEach((t) =>
      t.items.forEach((i) =>
        rows.push([new Date(t.waktu).toLocaleString('id-ID'), t.metode, i.kode, i.nama, i.kategori, i.qty, i.harga, i.qty * i.harga, i.catatan || ''])
      )
    );
    Store.unduhCSV('transaksi-' + new Date().toISOString().slice(0, 10) + '.csv', rows);
    toast('CSV transaksi diunduh', 'ok');
  };

  /* ================= PRODUK BARU ================= */
  window.bukaModalProduk = function () {
    showModalBox('Tambah / Perbarui Produk', `
      <div class="form-group"><label class="form-label" for="pbKode">Kode</label>
        <input type="text" id="pbKode" placeholder="B004"></div>
      <div class="form-group"><label class="form-label" for="pbNama">Nama produk</label>
        <input type="text" id="pbNama" placeholder="Nama produk"></div>
      <div class="form-group"><label class="form-label" for="pbHarga">Harga (Rp)</label>
        <input type="number" id="pbHarga" min="0" inputmode="numeric" placeholder="45000"></div>
      <div class="form-group"><label class="form-label" for="pbKat">Kategori</label>
        <select id="pbKat"><option>KANISIUS</option><option>NON_KANISIUS</option><option>EKSTERNAL</option></select></div>
    `, `<div class="btn-row">
        <button class="btn btn-secondary" onclick="tutupModal()">Batal</button>
        <button class="btn btn-primary" onclick="simpanProduk()">Simpan</button>
      </div>`);
  };

  window.simpanProduk = function () {
    const kode = $('pbKode').value.trim();
    const nama = $('pbNama').value.trim();
    const harga = parseInt($('pbHarga').value, 10);
    if (!kode || !nama || !(harga >= 0)) { toast('Lengkapi kode, nama, dan harga', 'err'); return; }
    Store.upsertProduct({ kode, nama, harga, kategori: $('pbKat').value });
    tutupModal();
    toast('Produk tersimpan', 'ok');
    if (document.querySelector('#scr-persiapan.active')) renderPersiapan();
    if (document.querySelector('#scr-penginputan.active')) renderPenginputan();
  };


  /* ================= TAMBAHAN: kembalian, tabel rekap, selesai dari sesi ================= */
  window.hitungKembalian = function () {
    const total = keranjang.reduce((a, k) => a + k.qty * k.produk.harga, 0);
    const bayar = parseFloat($('pmTunai').value) || 0;
    const kembali = Math.max(0, bayar - total);
    $('pmKembalian').textContent = rupiah(kembali);
  };

  window.tampilkanRekapTable = function () {
    if (!butuhEvent()) return;
    renderRekap();
    const rows = window._rekapRows || [];
    const html = '<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:var(--text-xs)">' +
      rows.map((r, i) => '<tr>' + r.map((c) =>
        (i === 0 ? '<th style="border-bottom:2px solid var(--border-strong);padding:4px;text-align:left">' : '<td style="border-bottom:1px dashed var(--border-color);padding:4px">') + esc(c) + '</t' + (i === 0 ? 'h' : 'd') + '>').join('') + '</tr>').join('') +
      '</table></div>';
    showModalBox('Tabel Rekap', html);
  };

  window.selesaiEventAktif = function () {
    if (!butuhEvent()) return;
    const ev = Store.getActiveEvent();
    Store.updateEvent(ev.id, { selesai: new Date().toISOString() });
    renderHome();
    showModalBox('Pameran selesai 🎉', '<p>“' + esc(ev.nama) + '” ditandai selesai. Unduh rekap CSV sebelum menutup bila perlu.</p>');
    toast('Pameran ditandai selesai', 'ok');
  };

  /* ================= BADGE NAV ================= */
  function updateBadgeNav() {
    const b = $('badgePameran');
    const n = keranjang.length;
    b.style.display = n ? '' : 'none';
    b.textContent = n;
  }

  /* ================= INIT ================= */
  document.addEventListener('DOMContentLoaded', function () {
    // Restore event aktif
    const id = Store.getActiveId();
    if (id && Store.getEvents().some((e) => e.id === id)) {
      evtId = id;
      const ev = Store.getActiveEvent();
      $('homeEventInfo').textContent = ev.nama + ' · ' + ev.tanggal;
    }
    renderHome();
    goScreen('home');

    // Shortcut pencarian: "/" fokus ke input cari
    document.addEventListener('keydown', function (e) {
      if (e.key === '/' && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) {
        if (document.querySelector('#scr-pameran.active')) { e.preventDefault(); $('pmCari').focus(); }
      }
      if (e.key === 'Escape') {
        $('pmHasilCari').style.display = 'none';
        tutupModal();
      }
    });

    // Klik luar modal menutup
    $('modalUmum').addEventListener('click', function (e) {
      if (e.target === this) tutupModal();
    });
  });
})();
