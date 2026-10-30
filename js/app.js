/* ============================================================
   app.js — Logika aplikasi Pencatatan pameran
   3 sesi: Persiapan → pameran → Penginputan
   Pola mengikuti index-scanstock.html (ScanStock): screen switching,
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
  const SCREENS = ['login', 'home', 'persiapan', 'pameran', 'penginputan', 'admin'];
  window.goScreen = function (nama) {
    if (nama === 'admin') {
      const s = GAS.getSession();
      if (!s || !s.user || s.user.role !== 'ADMIN') { toast('Khusus Admin', 'error'); return; }
    }
    // Gate RBAC: layar selain login hanya untuk sesi valid
    if (nama !== 'login' && !GAS.getSession()) {
      $('scr-login').classList.add('active');
      toast('Silakan masuk terlebih dahulu', 'error');
      return;
    }
    SCREENS.forEach((sc) => {
      const el = $('scr-' + sc);
      if (el) el.classList.toggle('active', sc === nama);
    });
    document.querySelectorAll('.seg-nav button[data-screen]').forEach((b) => {
      b.classList.toggle('aktif', b.dataset.screen === nama);
    });
    if (nama === 'home') renderHome();
    if (nama === 'persiapan') renderPersiapan();
    if (nama === 'pameran') renderPameran();
    if (nama === 'penginputan') renderPenginputan();
    if (nama === 'admin') muaiUsers();
    window.scrollTo({ top: 0 });
  };

  /* ---------------- Tema ---------------- */
  function terapkanTheme(dark) {
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    try { localStorage.setItem(THEME_KEY, dark ? 'dark' : 'light'); } catch (e) {}
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#000000' : '#DFDEDC');
  }
  window.toggleTheme = function (btn) {
    const dark = document.documentElement.getAttribute('data-theme') !== 'dark';
    // Animasi kilau singkat saat toggle (efek "wow" kecil, tetap hormati reduced-motion)
    if (btn && btn.classList) {
      btn.classList.add('tt-spin');
      setTimeout(() => btn.classList.remove('tt-spin'), 500);
    }
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
            <button class="btn btn-pill btn-sm ${aktif ? 'btn-secondary' : 'btn-primary'}" onclick="bukaEvent('${e.id}')">${aktif ? 'Lanjut' : 'Buka'}</button>
            <button class="btn btn-pill btn-sm btn-ghost" onclick="selesaiEvent('${e.id}')">${e.selesai ? 'Buka lagi' : 'Selesai'}</button>
            <button class="btn btn-pill btn-sm btn-danger" onclick="hapusEvent('${e.id}')" aria-label="Hapus pameran">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
              Hapus
            </button>
          </div>
        </div>`;
      })
      .join('');
  }

  window.buatEventBaru = function () {
    const hariIni = new Date().toISOString().slice(0, 10);
    showModalBox('Buat Agenda Pameran Baru', `
      <div class="form-group"><label class="form-label" for="evNama">Judul pameran</label>
        <input type="text" id="evNama" placeholder="pameran Buku Oktober 2026"></div>
      <div class="form-group"><label class="form-label" for="evTanggal">Tanggal mulai</label>
        <input type="date" id="evTanggal" value="${hariIni}"></div>
      <div class="form-group"><label class="form-label" for="evTanggalSelesai">Sampai tanggal selesai
        <small>(kosongkan bila hanya satu hari)</small></label>
        <input type="date" id="evTanggalSelesai" min="${hariIni}"></div>
      <div class="form-group"><label class="form-label" for="evCatatan">Catatan (opsional)</label>
        <input type="text" id="evCatatan" placeholder="Lokasi, booth, dll"></div>
    `, `<div class="btn-row">
        <button class="btn btn-secondary" onclick="tutupModal()">Batal</button>
        <button class="btn btn-primary" onclick="simpanEventBaru()">Simpan & Buka</button>
      </div>`);
    setTimeout(() => $('evNama') && $('evNama').focus(), 50);
  };

  window.simpanEventBaru = function () {
    const selesai = $('evTanggalSelesai').value;
    const tglLabel = selesai && selesai !== $('evTanggal').value
      ? $('evTanggal').value + ' s.d. ' + selesai
      : $('evTanggal').value;
    const ev = Store.buatEvent($('evNama').value, tglLabel, $('evCatatan').value);
    // simpan rentang terstruktur untuk gerbang sesi & nama sheet
    Store.updateEvent(ev.id, {
      tglMulai: $('evTanggal').value,
      tglSelesai: selesai || $('evTanggal').value,
    });
    tutupModal();
    bukaEvent(ev.id);
    toast('Agenda "' + ev.nama + '" dibuat', 'ok');
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

  /* ================= SESI 2 — PAMERAN ================= */
  let hasilCariTimer = null;

  function renderPameran() {
    if (!butuhEvent()) return;
    // Gerbang waktu: sesi pameran hanya terbuka pada rentang tanggal agenda
    const ev = Store.getEvents().find((e) => e.id === evtId);
    if (ev && ev.tglMulai) {
      const hariIni = new Date().toISOString().slice(0, 10);
      if (hariIni < ev.tglMulai || hariIni > (ev.tglSelesai || ev.tglMulai)) {
        toast('Sesi pameran baru terbuka saat hari-H (' + ev.tanggal + ')', 'error');
        goScreen('persiapan');
        return;
      }
    }
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
          <strong class="cart-price">${rupiah(k.produk.harga * k.qty)}</strong>
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
        <button class="btn btn-pill btn-sm btn-danger" style="margin-top:8px" onclick="hapusTransaksi('${t.id}')">Hapus</button>
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
        <button class="btn btn-pill btn-sm btn-danger" style="margin-top:8px" onclick="hapusInput('${x.id}')">Hapus</button>
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
    const html = '<div style="overflow-x:auto"><table class="rekap-table">' +
      rows.map((r, i) => '<tr>' + r.map((c, j) =>
        (i === 0 ? '<th' : '<td') + (j > 0 ? ' class="num"' : '') + '>' + esc(c) + '</t' + (i === 0 ? 'h' : 'd') + '>').join('') + '</tr>').join('') +
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

  /* ================= AUTH / RBAC (via Google Apps Script) ================= */
  let sesiUser = null; // {email, nama, cabang, role}

  function tampilkanApp(user) {
    sesiUser = user;
    $('scr-login').classList.remove('active');
    // Tampilkan navigasi bawah & tombol logout setelah login (sesuai role)
    const bar = $('bottomBar');
    if (bar) bar.hidden = false;
    document.body.classList.add('logged-in');
    const btnOut = $('btnLogoutHeader');
    if (btnOut) btnOut.style.display = '';
    const navAdmin = $('navAdminBtn');
    if (navAdmin) navAdmin.hidden = user.role !== 'ADMIN';
    // Grid nav: 5 kolom bila Admin tampil, 4 bila tidak
    const seg = $('segNav');
    if (seg) seg.classList.toggle('with-admin', !!navAdmin && !navAdmin.hidden);
    const chip = $('admRoleChip');
    if (chip) chip.textContent = user.role;
    const urlInput = $('gasUrl');
    if (urlInput) urlInput.value = GAS.getUrl();
    $('homeEventInfo').textContent = user.cabang + ' · ' + user.nama;
    goScreen('home');
    tarikMasterProduk();
  }

  window.aksiLogin = async function (e) {
    e.preventDefault();
    const btn = $('btnLogin');
    // Sinkronkan URL bila user mengetik langsung di field login
    const vL = $('loginGasUrl') && $('loginGasUrl').value.trim();
    if (vL && /^https:\/\/script\.google\.com\//.test(vL)) GAS.setUrl(vL);
    if (!GAS.getUrl()) { toast('Isi URL Web App dulu (Pengaturan koneksi)', 'error'); btn.disabled = false; btn.textContent = 'Masuk'; return false; }
    btn.disabled = true; btn.textContent = 'Memeriksa…';
    try {
      const user = await GAS.login($('loginEmail').value.trim(), $('loginPass').value);
      toast('Halo, ' + (user.nama || user.email));
      tampilkanApp(user);
    } catch (err) {
      toast('Login gagal: ' + err.message, 'error');
    } finally {
      btn.disabled = false; btn.textContent = 'Masuk';
    }
    return false;
  };

  window.keluarLogin = function () {
    GAS.logout();
    location.reload();
  };

  // Konfirmasi logout via modal umum — mobile-friendly, tidak pakai confirm() bawaan
  window.konfirmasiLogout = function () {
    showModalBox('Keluar dari aplikasi?',
      '<p class="rekap-note">Sesi login Anda akan diakhiri. Data yang tersimpan lokal tetap aman dan tersinkron dengan Google Spreadsheet.</p>',
      '<div class="btn-row" style="gap:8px">' +
      '<button class="btn btn-secondary" style="flex:1" onclick="tutupModal()">Batal</button>' +
      '<button class="btn btn-danger" style="flex:1" onclick="keluarLogin()">Ya, Keluar</button></div>');
  };

  /* Tarik master produk dari sheet MasterProduk (tanpa data dummy). */
  async function tarikMasterProduk() {
    try {
      const rows = await GAS.getMasterProduk();
      Store.setProducts(rows.map((r) => ({
        kode: String(r.kode || '').trim(),
        nama: r.nama || '',
        kategori: (r.kategori || 'KANISIUS').toUpperCase(),
        harga: Number(r.harga || 0),
      })));
    } catch (err) {
      console.warn('Master produk belum dapat diambil:', err.message);
    }
  }

  /* ================= HALAMAN ADMIN ================= */
  window.simpanGasUrl = function () {
    GAS.setUrl($('gasUrl').value);
    toast('URL Apps Script disimpan');
  };

  window.simpanGasUrlLogin = function () {
    const v = $('loginGasUrl').value.trim();
    if (!/^https:\/\/script\.google\.com\//.test(v)) { toast('URL harus dari script.google.com', 'error'); return; }
    GAS.setUrl(v);
    const adm = $('gasUrl'); if (adm) adm.value = v;
    toast('URL tersimpan — silakan Masuk');
  };

  function catatLog(txt) {
    const box = $('admLog');
    box.textContent = new Date().toLocaleTimeString('id-ID') + ' ▸ ' + txt + '\n' + box.textContent;
  }

  window.tesKoneksi = async function () {
    catatLog('ping…');
    try { const d = await GAS.runTest('ping'); catatLog('OK: ' + JSON.stringify(d)); toast('Koneksi OK'); }
    catch (e) { catatLog('GAGAL: ' + e.message); toast('Koneksi gagal', 'error'); }
  };

  window.jalanTes = async function (nama) {
    catatLog('test ' + nama + '…');
    try { const d = await GAS.runTest(nama); catatLog(JSON.stringify(d, null, 1)); toast('Tes selesai'); }
    catch (e) { catatLog('GAGAL: ' + e.message); toast('Tes gagal', 'error'); }
  };

  window.bersihkanLog = function () { $('admLog').textContent = '(log dibersihkan)'; };

  window.muaiUsers = async function () {
    const tbody = document.querySelector('#tblUsers tbody');
    tbody.innerHTML = '<tr><td colspan="4" class="hint-text">Memuat…</td></tr>';
    try {
      const users = await GAS.listUsers();
      tbody.innerHTML = users.map((u) => `
        <tr>
          <td>${esc(u.cabang)}</td>
          <td class="cell-truncate">${esc(u.email)}</td>
          <td><span class="chip chip-role">${esc(u.role)}</span></td>
          <td><button class="btn btn-danger btn-sm" onclick="hapusUser('${esc(u.email)}')">Hapus</button></td>
        </tr>`).join('') || '<tr><td colspan="4" class="hint-text">Belum ada user.</td></tr>';
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="4" class="hint-text">Gagal memuat: ${esc(e.message)}</td></tr>`;
    }
  };

  window.tambahUser = async function () {
    const u = {
      cabang: $('admCabang').value.trim(),
      email: $('admEmail').value.trim(),
      pass: $('admPass').value.trim(),
      role: $('admRole').value,
      nama: $('admEmail').value.split('@')[0],
    };
    if (!u.cabang || !u.email || u.pass.length < 6) { toast('Lengkapi data (sandi ≥6)', 'error'); return; }
    try {
      await GAS.addUser(u);
      toast('Akun ' + u.email + ' dibuat — user bisa langsung login');
      $('admCabang').value = ''; $('admEmail').value = ''; $('admPass').value = '';
      muaiUsers();
    } catch (e) { toast('Gagal: ' + e.message, 'error'); }
  };

  window.hapusUser = async function (email) {
    if (!confirm('Hapus akun ' + email + '?')) return;
    try { await GAS.deleteUser(email); toast('User dihapus'); muaiUsers(); }
    catch (e) { toast('Gagal: ' + e.message, 'error'); }
  };

  /* ================= INIT ================= */
  document.addEventListener('DOMContentLoaded', function () {
    // Isi field URL GAS (login & admin) dari nilai tersimpan/DEFAULT/?gas=
    const urlNow = GAS.getUrl();
    ['loginGasUrl', 'gasUrl'].forEach((idEl) => {
      const el = $(idEl);
      if (el && urlNow) el.value = urlNow;
    });

    // Gate RBAC: jika belum ada sesi valid, tahan di layar login.
    const s = GAS.getSession();
    if (s && s.user) tampilkanApp(s.user);
    else $('scr-login').classList.add('active');

    // Restore event aktif (hanya bila sudah login — jangan membocorkan data di layar login)
    const id = Store.getActiveId();
    if (s && s.user && id && Store.getEvents().some((e) => e.id === id)) {
      evtId = id;
      const ev = Store.getActiveEvent();
      $('homeEventInfo').textContent = ev.nama + ' · ' + ev.tanggal;
    }
    if (s && s.user) renderHome();

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
