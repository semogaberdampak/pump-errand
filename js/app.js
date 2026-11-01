/* ============================================================
   app.js — Logika aplikasi Pencatatan pameran
   3 sesi: Persiapan → pameran → Penginputan
   Pola mengikuti index-scanstock.html (ScanStock): screen switching,
   modal overlay, toast, tema tersimpan di localStorage.
   ============================================================ */
(function () {
  'use strict';

  const THEME_KEY = 'pameran.theme';
  // Bila js/sync.js gagal dimuat, aplikasi tetap hidup dan memberi peringatan jelas (tidak diam-diam kehilangan data)
  const Sync = window.Sync || {
    _stub: true, tambah() {}, flush: async () => {}, tarik: async () => false, onUbah() {}, onTick: null, mulaiOtomatis() {},
    ringkas: () => ({ menunggu: 0, gagal: 0, offline: false, sesiHabis: false }), statusTrx: () => 'lokal',
    daftar: () => [], cobaLagi: async () => {}, buang() {}, buangEvent() {},
  };
  let evtId = null;          // id event aktif
  let keranjang = [];        // item transaksi yang belum disimpan
  let produkTerpilih = null; // produk yang dipilih pada form tambah ke keranjang
  let produkMaster = null;   // produk dari sheet Master yang sedang dibuka di modal Persiapan
  let trxAktif = false;      // panel "Transaksi Baru" sedang terbuka

  /* ---------------- Util ---------------- */
  const $ = (id) => document.getElementById(id);
  const isAdmin = () => !!(sesiUser && sesiUser.role === 'ADMIN');

  // Sesi, aktivitas, dan halaman terakhir (disimpan di perangkat)
  const K_AKTIF = 'pameran.aktifTerakhir';     // cap waktu aktivitas terakhir
  const K_LAYAR = 'pameran.layar';             // halaman terakhir (dipulihkan saat dimuat ulang)
  const K_PESAN = 'pameran.pesanLogin';        // pesan di layar login setelah keluar otomatis
  const BATAS_IDLE_MS = 60 * 60 * 1000;        // keluar otomatis setelah 1 jam TANPA aktivitas
  const PERINGATAN_MS = 60 * 1000;             // peringatan 60 detik sebelum keluar

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
  window.tutupModal = function () {
    $('modalUmum').classList.remove('open');
    if (window.Scanner) Scanner.lanjut(); // modal ditutup → pemindaian boleh lanjut
  };

  /* ---------------- Navigasi layar ---------------- */
  const SCREENS = ['login', 'home', 'persiapan', 'pameran', 'penginputan', 'admin'];
  window.goScreen = function (nama) {
    if (nama === 'admin') {
      const s = GAS.getSession();
      if (!s || !s.user || s.user.role !== 'ADMIN') { toast('Khusus Admin', 'error'); return; }
    }
    if (window.Scanner && Scanner.sedangBuka()) Scanner.tutup();
    SCREENS.forEach((sc) => {
      const el = $('scr-' + sc);
      if (el) el.classList.toggle('active', sc === nama);
    });
    document.querySelectorAll('.seg-nav button[data-screen]').forEach((b) => {
      b.classList.toggle('aktif', b.dataset.screen === nama);
    });
    if (nama === 'persiapan') { renderPersiapan(); syncProdukPameran(false); }
    if (nama === 'pameran') { renderPameran(); syncProdukPameran(true); sinkronTransaksi(true); }
    if (nama === 'penginputan') renderPenginputan();
    if (nama === 'admin') muaiUsers();
    if (sesiUser && nama !== 'login') Store.tulis(K_LAYAR, nama);   // state halaman
    window.scrollTo({ top: 0 });
  };

  /* ---------------- Tema ---------------- */
  function terapkanTheme(dark, animasi) {
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    try { localStorage.setItem(THEME_KEY, dark ? 'dark' : 'light'); } catch (e) {}
    const tb = document.getElementById('themeToggle');
    if (tb) {
      tb.setAttribute('aria-checked', dark ? 'true' : 'false');
      if (animasi) { tb.classList.remove('tt-spin'); void tb.offsetWidth; tb.classList.add('tt-spin'); }
    }
  }
  window.toggleTheme = function () {
    const dark = document.documentElement.getAttribute('data-theme') !== 'dark';
    terapkanTheme(dark, true);
  };

  // Initialize theme on page load (before DOMContentLoaded to avoid flash)
  (function () {
    try {
      const savedTheme = localStorage.getItem('pameran.theme');
      if (savedTheme === 'dark') {
        document.documentElement.setAttribute('data-theme', 'dark');
      }
    } catch (e) {}
  })();

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
            ${isAdmin() ? `<button class="btn btn-pill btn-sm btn-danger" onclick="hapusEvent('${e.id}')" aria-label="Hapus pameran">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
              Hapus
            </button>` : ''}
          </div>
        </div>`;
      })
      .join('');
  }

  window.buatEventBaru = function () {
    const hariIni = Store.tglWIB();
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
    if (!isAdmin()) { toast('Hanya Admin yang dapat menghapus pameran', 'error'); return; }
    const ev = Store.getEvents().find((e) => e.id === id);
    if (!ev) return;
    showModalBox('Hapus pameran?', `<p>“${esc(ev.nama)}” beserta seluruh datanya akan dihapus permanen.</p>`,
      `<div class="btn-row">
        <button class="btn btn-secondary" onclick="tutupModal()">Batal</button>
        <button class="btn btn-danger" onclick="konfirmasiHapusEvent('${id}')">Hapus</button>
      </div>`);
  };

  window.konfirmasiHapusEvent = function (id) {
    if (!isAdmin()) { tutupModal(); toast('Hanya Admin yang dapat menghapus pameran', 'error'); return; }
    Store.hapusEvent(id);
    try { Sync.buangEvent(id); } catch (e) { console.warn(e); }
    if (evtId === id) { evtId = null; $('homeEventInfo').textContent = ''; }
    renderHome();
    tutupModal();
    toast('Pameran dihapus', 'ok');
  };

  window.selesaiEvent = function (id) {
    const ev = Store.getEvents().find((e) => e.id === id);
    if (!ev) return;
    // Gunakan undefined agar properti dihilangkan saat JSON.stringify (lebih bersih dari null)
    Store.updateEvent(id, { selesai: ev.selesai ? undefined : new Date().toISOString() });
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

    renderChecklist();

    // Produk yang dibawa (dari sheet produk_pameran_<tanggal>)
    renderProdukPameran();
  }
  window.renderPersiapan = renderPersiapan;

  /* ---- Checklist: Simpan → status "Persiapan OK"; Tampilkan (modal) & Koreksi ---- */
  function renderChecklist() {
    const cek = Store.getCek(evtId);
    const st = Store.getCekStatus(evtId);
    const ok = !!(st && st.tersimpan);
    const done = cek.filter((c) => c.done).length;
    $('pspCekEdit').style.display = ok ? 'none' : '';
    $('pspCekOk').style.display = ok ? '' : 'none';
    $('pspCekBarWrap').style.display = ok ? 'none' : '';
    $('pspCekProgress').textContent = ok ? 'OK' : done + '/' + cek.length;
    $('pspCekProgress').className = 'chip ' + (ok ? 'chip-ok' : 'chip-teal');
    if (ok) {
      const rinci = [Store.waktuWIB(st.waktu), st.dicentang + '/' + st.total + ' item'];
      if (st.belum) rinci.push(st.belum + ' belum dicentang');
      if (st.revisi) rinci.push('revisi ke-' + st.revisi);
      if (st.oleh) rinci.push(esc(st.oleh));
      $('pspCekOk').innerHTML = `
        <div class="status-ok-head">
          <span class="status-ok-ic" aria-hidden="true">✓</span>
          <div><strong>Persiapan OK</strong><small>Disimpan ${rinci.join(' · ')}</small></div>
        </div>
        <div class="btn-row">
          <button class="btn btn-secondary" onclick="tampilkanChecklist()">Tampilkan</button>
          <button class="btn btn-ghost" onclick="koreksiChecklist()">Koreksi</button>
        </div>`;
      return;
    }
    $('pspCekBar').style.width = cek.length ? Math.round((done / cek.length) * 100) + '%' : '0%';
    $('pspCekInfo').textContent = st && st.waktu ? 'Sedang dikoreksi — terakhir disimpan ' + Store.waktuWIB(st.waktu) + '.' : '';
    $('pspCekInfo').style.display = st && st.waktu ? '' : 'none';
    $('pspCekSimpan').textContent = st && st.waktu ? 'Simpan Koreksi' : 'Simpan Checklist';
    $('psnCekList').innerHTML = cek.map((c, i) => `
      <li class="${c.done ? 'done' : ''}">
        <span class="check-box" role="checkbox" aria-checked="${!!c.done}" tabindex="0"
              onclick="toggleCek(${i})" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();toggleCek(${i})}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
        </span>
        <span class="cek-label" style="flex:1">${esc(c.teks)}</span>
        <button class="cart-remove" title="Hapus item" onclick="hapusCek(${i})">×</button>
      </li>`).join('');
  }

  window.simpanChecklist = function () {
    if (!butuhEvent()) return;
    const cek = Store.getCek(evtId);
    if (!cek.length) { toast('Checklist masih kosong', 'error'); return; }
    const belum = cek.filter((c) => !c.done).length;
    if (belum && !confirm(belum + ' item belum dicentang. Tetap simpan sebagai "Persiapan OK"?')) return;
    const lama = Store.getCekStatus(evtId);
    Store.setCekStatus(evtId, {
      tersimpan: true, waktu: new Date().toISOString(),
      oleh: sesiUser ? (sesiUser.nama || sesiUser.email) : '',
      dicentang: cek.length - belum, total: cek.length, belum,
      revisi: lama && lama.waktu ? (lama.revisi || 0) + 1 : 0,
    });
    renderChecklist();
    toast(lama && lama.waktu ? 'Koreksi checklist disimpan' : 'Persiapan OK tersimpan', 'ok');
  };

  window.tampilkanChecklist = function () {
    if (!butuhEvent()) return;
    const cek = Store.getCek(evtId);
    const st = Store.getCekStatus(evtId);
    const sudah = cek.filter((c) => c.done), belum = cek.filter((c) => !c.done);
    const ul = (arr) => '<ul>' + arr.map((c) => '<li>' + esc(c.teks) + '</li>').join('') + '</ul>';
    showModalBox('Checklist Persiapan', `<div class="cek-modal">
      ${st && st.waktu ? '<p class="rekap-note">Disimpan ' + Store.waktuWIB(st.waktu) + (st.oleh ? ' oleh ' + esc(st.oleh) : '') + '</p>' : ''}
      <h4>Sudah dicentang (${sudah.length})</h4>
      ${sudah.length ? ul(sudah) : '<p class="rekap-note">Belum ada.</p>'}
      ${belum.length ? '<div class="belum"><h4>Belum dicentang (' + belum.length + ')</h4>' + ul(belum) + '</div>' : ''}
    </div>`, `<div class="btn-row">
      <button class="btn btn-secondary" onclick="tutupModal()">Tutup</button>
      <button class="btn btn-ghost" onclick="koreksiChecklist()">Koreksi</button>
    </div>`);
  };

  // Koreksi: buka kembali checklist untuk diubah, lalu Simpan Koreksi
  window.koreksiChecklist = function () {
    const st = Store.getCekStatus(evtId);
    if (st) Store.setCekStatus(evtId, Object.assign({}, st, { tersimpan: false }));
    tutupModal();
    renderChecklist();
  };

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

  /* ---- Produk yang dibawa: scan → sheet Master → modal → sheet produk_pameran_<tanggal> ---- */
  let versiLokalPP = 0;        // naik tiap data lokal berubah; mencegah hasil sinkron lama menimpa data baru
  let syncPPJalan = false;
  let hasilMasterSementara = [];
  let kodeHapusPP = null;

  function produkEvent() { return evtId ? Store.getProdukPameran(evtId) : []; }

  function renderProdukPameran() {
    const produk = produkEvent();
    const total = produk.reduce((a, p) => a + Number(p.jumlah || 0), 0);
    $('pspStat').innerHTML = `
      <div class="stat"><span class="stat-value">${produk.length}</span><span class="stat-label">Produk</span></div>
      <div class="stat"><span class="stat-value">${total}</span><span class="stat-label">Total dibawa</span></div>`;
    $('pspStokList').innerHTML = produk.length
      ? '<div class="data-list">' + produk.slice().reverse().map((p) => `
        <div class="data-item">
          <div class="data-top">
            <span class="data-nama text-truncate-2">${esc(p.nama)}</span>
            <span class="chip chip-teal">× ${Number(p.jumlah || 0)}</span>
          </div>
          <div class="data-meta"><span>${esc(p.kode)}</span><span>${rupiah(p.harga)}</span></div>
          <div class="btn-row" style="margin-top:8px">
            <button class="btn btn-pill btn-sm btn-secondary" data-kode="${esc(p.kode)}" onclick="ubahProdukPameran(this.dataset.kode)">Ubah</button>
            <button class="btn btn-pill btn-sm btn-danger" data-kode="${esc(p.kode)}" onclick="hapusProdukPameran(this.dataset.kode)">Hapus</button>
          </div>
        </div>`).join('') + '</div>'
      : '<div class="empty-state">Belum ada produk. Tekan “Scan Produk” atau ketik kode / judul di atas.</div>';
  }

  // Tarik daftar produk event ini dari sheet (sumber kebenaran). Gagal/offline → pakai data di perangkat.
  async function syncProdukPameran(diam) {
    const ev = Store.getActiveEvent();
    if (!ev || syncPPJalan) return;
    syncPPJalan = true;
    const versi = versiLokalPP;
    try {
      const list = await GAS.getProdukPameran({ event: ev.nama, tgl: ev.tglMulai });
      if (versi === versiLokalPP && ev.id === evtId) {
        Store.setProdukPameran(ev.id, list);
        if (document.querySelector('#scr-persiapan.active')) renderProdukPameran();
      }
    } catch (err) {
      console.warn('Sinkron produk pameran gagal:', err.message);
      if (!diam) toast('Memakai data di perangkat — sinkron sheet gagal: ' + err.message, 'error');
    } finally {
      syncPPJalan = false;
    }
  }

  window.bukaScanProduk = function () {
    if (!butuhEvent()) return;
    Scanner.buka({
      judul: 'Scan produk fisik',
      petunjuk: 'Arahkan kamera ke barcode / QR produk. Data ditarik dari sheet Master.',
      onKode: (teks, sumber) => cariDanPilihMaster(teks, sumber === 'kamera'),
    });
  };
  window.bukaModalProduk = window.bukaScanProduk; // tombol "Produk" di header semua sesi

  window.cariMasterManual = async function () {
    const inp = $('pspCariMaster');
    const teks = (inp.value || '').trim();
    if (!teks) return;
    if (await cariDanPilihMaster(teks, false)) inp.value = '';
  };

  // true = modal dibuka (scanner ditahan sampai modal ditutup)
  async function cariDanPilihMaster(teks, hanyaPersis) {
    if (!butuhEvent()) return false;
    toast('Mencari di sheet Master…');
    let r;
    try { r = await GAS.cariMaster({ q: teks, exact: !!hanyaPersis }); }
    catch (err) { tampilkanGalatMaster(err); return true; }
    if (r.exact) { bukaModalJumlah(r.exact); return true; }
    if (r.hasil && r.hasil.length) { tampilkanPilihanMaster(r.hasil, r.total); return true; }
    // Tidak ketemu: tampilkan di modal (bukan toast sekilas) beserta teks yang terbaca, supaya mudah ditelusuri
    showModalBox('Produk tidak ditemukan', `
      <p>${hanyaPersis ? 'Kode yang terbaca' : 'Yang dicari'}: <strong>${esc(String(teks).slice(0, 60))}</strong></p>
      <p class="rekap-note">Tidak ada produk dengan <em>produk_id</em> / <em>isbn</em> tersebut${hanyaPersis ? '' : ' (atau judul yang mengandung kata itu)'} di sheet <strong>Master</strong>.
      Periksa isi sheet Master, atau ketik judulnya di kolom pencarian.</p>`,
      '<button class="btn btn-primary btn-block" onclick="tutupModal()">Tutup</button>');
    return true;
  }

  function tampilkanGalatMaster(err) {
    let pesan = esc(err.message || 'Galat tidak diketahui');
    if (err.jaringan) pesan = 'Tidak ada koneksi ke server. Periksa internet lalu coba lagi.';
    else if (/Aksi tidak dikenal/i.test(err.message || '')) {
      pesan = 'Backend Apps Script belum versi terbaru. Buka Apps Script → <strong>Deploy → Manage deployments → ✏️ → New version → Deploy</strong>, lalu coba lagi.';
    }
    showModalBox('Gagal membaca sheet Master', '<p>' + pesan + '</p>',
      '<button class="btn btn-primary btn-block" onclick="tutupModal()">Tutup</button>');
  }

  function tampilkanPilihanMaster(list, total) {
    hasilMasterSementara = list;
    const lebih = total && total > list.length ? '<p class="rekap-note">Menampilkan ' + list.length + ' dari ' + total + ' hasil — perjelas kata kunci untuk mempersempit.</p>' : '';
    showModalBox('Pilih produk', lebih + '<div>' + list.map((m) => `
      <div class="result-item" data-kode="${esc(m.kode)}" onclick="pilihDariMaster(this.dataset.kode)">
        <span class="result-nama">${esc(m.nama)}</span>
        <span class="result-sub"><span>${esc(m.kode)}</span><span>${rupiah(m.harga)}</span></span>
      </div>`).join('') + '</div>',
      '<button class="btn btn-secondary btn-block" onclick="tutupModal()">Batal</button>');
  }

  window.pilihDariMaster = function (kode) {
    const m = hasilMasterSementara.find((x) => x.kode === kode);
    if (m) bukaModalJumlah(m);
  };

  // Modal: kode & nama terkunci (tidak bisa diubah), harga & jumlah diisi user
  function bukaModalJumlah(m) {
    produkMaster = m;
    const ada = produkEvent().find((p) => Store.normKode(p.kode) === Store.normKode(m.kode));
    const harga = ada ? ada.harga : m.harga;
    showModalBox('Produk Pameran', `
      <div class="form-group"><label class="form-label" for="ppKode">Kode produk</label>
        <input type="text" id="ppKode" class="inp-readonly" value="${esc(m.kode)}" readonly tabindex="-1"></div>
      <div class="form-group"><label class="form-label" for="ppNama">Nama produk</label>
        <input type="text" id="ppNama" class="inp-readonly" value="${esc(m.nama)}" readonly tabindex="-1"></div>
      <div class="pp-grid">
        <div class="form-group"><label class="form-label" for="ppHarga">Harga (Rp)</label>
          <input type="number" id="ppHarga" min="0" step="1" inputmode="numeric" placeholder="0" value="${harga ? Number(harga) : ''}"></div>
        <div class="form-group"><label class="form-label" for="ppJumlah">Jumlah dibawa</label>
          <input type="number" id="ppJumlah" min="1" step="1" inputmode="numeric" placeholder="0" value="${ada ? Number(ada.jumlah) : ''}"
                 onkeydown="if(event.key==='Enter'){event.preventDefault();simpanProdukPameran()}"></div>
      </div>
      ${ada ? '<p class="rekap-note">Produk ini sudah ada di daftar (' + Number(ada.jumlah) + ' pcs). Menyimpan akan memperbarui harga &amp; jumlah.</p>' : ''}
    `, `<div class="btn-row">
        <button class="btn btn-secondary" onclick="tutupModal()">Batal</button>
        <button class="btn btn-primary" id="ppSimpan" onclick="simpanProdukPameran()">Simpan</button>
      </div>`);
    setTimeout(() => { const el = $(harga ? 'ppJumlah' : 'ppHarga'); if (el) el.focus(); }, 60);
  }

  window.simpanProdukPameran = async function () {
    if (!butuhEvent() || !produkMaster) return;
    const harga = Number($('ppHarga').value);
    const jumlah = Number($('ppJumlah').value);
    if ($('ppHarga').value === '' || !Number.isInteger(harga) || harga < 0) { toast('Harga harus bilangan bulat ≥ 0', 'error'); return; }
    if (!Number.isInteger(jumlah) || jumlah < 1) { toast('Jumlah dibawa minimal 1', 'error'); return; }
    const ev = Store.getActiveEvent();
    const btn = $('ppSimpan');
    btn.disabled = true; btn.textContent = 'Menyimpan…';
    try {
      const r = await GAS.simpanProdukPameran({ event: ev.nama, tgl: ev.tglMulai, kode: produkMaster.kode, harga, jumlah });
      Store.upsertProdukPameran(evtId, r.produk);
      versiLokalPP++;
      tutupModal();
      renderProdukPameran();
      if (document.querySelector('#scr-penginputan.active')) renderPenginputan();
      toast((r.diperbarui ? 'Diperbarui: ' : 'Tersimpan: ') + r.produk.nama.slice(0, 30) + ' × ' + r.produk.jumlah, 'ok');
    } catch (err) {
      toast('Gagal simpan ke sheet: ' + err.message, 'error');
      btn.disabled = false; btn.textContent = 'Simpan';
    }
  };

  window.ubahProdukPameran = function (kode) {
    const p = produkEvent().find((x) => x.kode === kode);
    if (p) bukaModalJumlah({ kode: p.kode, isbn: p.isbn, nama: p.nama, harga: p.harga });
  };

  window.hapusProdukPameran = function (kode) {
    const p = produkEvent().find((x) => x.kode === kode);
    if (!p) return;
    const dipakai = Store.getTransaksi(evtId).some((t) => !t.deleted && t.items.some((i) => i.kode === kode)) ||
                    Store.getInputan(evtId).some((x) => !x.deleted && x.kode === kode);
    if (dipakai) { toast('Tidak bisa dihapus: produk sudah dipakai di transaksi / input', 'error'); return; }
    kodeHapusPP = kode;
    showModalBox('Hapus dari daftar?', `<p>“${esc(p.nama)}” (${esc(p.kode)}) akan dihapus dari sheet produk pameran.</p>`,
      `<div class="btn-row">
        <button class="btn btn-secondary" onclick="tutupModal()">Batal</button>
        <button class="btn btn-danger" onclick="konfirmasiHapusProduk()">Hapus</button>
      </div>`);
  };

  window.konfirmasiHapusProduk = async function () {
    const ev = Store.getActiveEvent();
    if (!ev || !kodeHapusPP) return;
    try {
      await GAS.hapusProdukPameran({ event: ev.nama, tgl: ev.tglMulai, kode: kodeHapusPP });
      Store.hapusProdukPameranLokal(evtId, kodeHapusPP);
      versiLokalPP++;
      tutupModal();
      renderProdukPameran();
      toast('Produk dihapus dari daftar', 'ok');
    } catch (err) {
      toast('Gagal menghapus: ' + err.message, 'error');
    }
  };

  /* ================= SESI 2 — PAMERAN ================= */
  let hasilCariTimer = null;

  function renderPameran() {
    if (!butuhEvent()) return;
    // Gerbang waktu: sesi pameran hanya terbuka pada rentang tanggal agenda
    // Tanggal acuan = WIB (Asia/Jakarta)
    const ev = Store.getEvents().find((e) => e.id === evtId);
    if (ev && ev.tglMulai) {
      const hariIni = Store.tglWIB(); // YYYY-MM-DD zona WIB
      if (hariIni < ev.tglMulai || hariIni > (ev.tglSelesai || ev.tglMulai)) {
        toast('Sesi pameran baru terbuka saat hari-H (' + ev.tanggal + ')', 'error');
        goScreen('persiapan');
        return;
      }
    }
    trxAktif = trxAktif || keranjang.length > 0;
    renderSyncBar();
    renderPanelTransaksi();
    renderKeranjang();
    renderRiwayatTransaksi();
  }
  window.renderPameran = renderPameran;

  // Sisa stok tercatat = jumlah dibawa − terjual + input manual − yang sudah ada di keranjang
  function stokTersisa(kode) {
    const p = produkEvent().find((x) => x.kode === kode);
    if (!p) return 0;
    let terjual = 0, masuk = 0;
    Store.getTransaksi(evtId).forEach((t) => {
      // transaksi dibatalkan → stok kembali; transaksi yang sedang dikoreksi dihitung ulang lewat keranjang
      if (!t.deleted && t.id !== koreksiDari) t.items.forEach((i) => { if (i.kode === kode) terjual += i.qty; });
    });
    Store.getInputan(evtId).forEach((x) => { if (!x.deleted && x.kode === kode) masuk += x.qty; });
    const diKeranjang = keranjang.filter((k) => k.produk.kode === kode).reduce((a, k) => a + k.qty, 0);
    return Number(p.jumlah || 0) - terjual + masuk - diKeranjang;
  }

  window.cariProduk = function (q) {
    clearTimeout(hasilCariTimer);
    hasilCariTimer = setTimeout(() => {
      const panel = $('pmHasilCari');
      const kata = (q || '').trim().toLowerCase();
      if (!kata) { panel.style.display = 'none'; panel.innerHTML = ''; return; }
      const nk = Store.normKode(kata);
      // Hanya produk yang dibawa ke pameran (sheet produk_pameran_<tanggal>)
      const hasil = produkEvent().filter((p) =>
        p.nama.toLowerCase().includes(kata) || p.kode.toLowerCase().includes(kata) ||
        (nk && (Store.normKode(p.kode).includes(nk) || Store.normKode(p.isbn).includes(nk)))
      ).slice(0, 20);
      if (!hasil.length) {
        panel.innerHTML = '<div class="result-item"><span class="result-sub">Tidak ada di produk pameran — tambahkan lewat sesi Persiapan</span></div>';
      } else {
        panel.innerHTML = '<div class="result-head">' + hasil.length + ' produk — ketuk untuk memilih</div>' + hasil.map((p) => `
          <div class="result-item" data-kode="${esc(p.kode)}" onclick="pilihKode(this.dataset.kode)">
            <span class="result-nama">${esc(p.nama)}</span>
            <span class="result-sub"><span>${esc(p.kode)}</span><span>${rupiah(p.harga)}</span><span>stok ${stokTersisa(p.kode)}</span></span>
          </div>`).join('');
      }
      panel.style.display = '';
      if (panel.scrollIntoView) panel.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); // tetap terlihat di atas keyboard
    }, 120);
  };

  window.beriFokusCari = function () {
    const inp = $('pmCari');
    inp.focus();
    inp.select();
  };

  window.pilihKode = function (kode) {
    const p = Store.findProdukPameran(evtId, kode);
    if (p) pilihProduk(p);
  };

  window.pilihProduk = function (p) {
    $('pmHasilCari').style.display = 'none';
    $('pmCari').value = '';
    produkTerpilih = p;
    $('pmProdukInfo').style.display = '';
    $('pmProdukNama').textContent = p.nama;
    $('pmProdukSub').textContent = p.kode + ' · ' + rupiah(p.harga) + ' · stok ' + stokTersisa(p.kode);
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
    else keranjang.push({ produk: produkTerpilih, qty, catatan: ket, diskonTipe: 'PERSEN', diskonNilai: 0 });
    const kodeTambah = produkTerpilih.kode;
    $('pmCatatanItem').value = '';
    produkTerpilih = null;
    $('pmProdukInfo').style.display = 'none';
    renderKeranjang();
    const sisa = stokTersisa(kodeTambah);
    if (sisa < 0) toast('Ditambah, tetapi melebihi stok tercatat (selisih ' + Math.abs(sisa) + ' pcs)', 'error');
    else toast('Ditambah ke keranjang', 'ok');
  };

  window.hapusKeranjang = function (i) {
    keranjang.splice(i, 1);
    renderKeranjang();
  };

  /* ---- Transaksi Baru ---- */
  let koreksiDari = null;   // id transaksi yang sedang dikoreksi (bila ada)

  function renderPanelTransaksi() {
    $('pmTrxBaru').style.display = trxAktif ? '' : 'none';
    $('pmBtnBaru').style.display = trxAktif ? 'none' : '';
    $('pmJudulTrx').textContent = koreksiDari ? 'Koreksi Transaksi' : 'Transaksi Baru';
    const info = $('pmKoreksiInfo');
    info.style.display = koreksiDari ? '' : 'none';
    if (koreksiDari) info.textContent = 'Mengoreksi transaksi #' + kodePendek(koreksiDari) + '. Transaksi lama otomatis dibatalkan saat transaksi baru ini disimpan.';
  }

  const kodePendek = (id) => String(id).slice(-6).toUpperCase();

  function resetFormTransaksi() {
    keranjang = [];
    produkTerpilih = null;
    koreksiDari = null;
    $('pmProdukInfo').style.display = 'none';
    $('pmCari').value = '';
    $('pmHasilCari').style.display = 'none';
    $('pmCatatanItem').value = '';
    $('pmMetode').value = 'TUNAI';
    $('pmTunai').value = '';
    ubahMetode();
  }

  window.mulaiTransaksiBaru = async function () {
    if (!butuhEvent()) return;
    if (!produkEvent().length) await syncProdukPameran(true);
    if (!produkEvent().length) { toast('Belum ada produk pameran — tambahkan dulu di sesi Persiapan', 'error'); return; }
    trxAktif = true;
    resetFormTransaksi();
    renderPanelTransaksi();
    renderKeranjang();
    setTimeout(() => $('pmCari').focus(), 50);
  };

  window.batalTransaksi = function () {
    const pesan = koreksiDari ? 'Batalkan koreksi? Transaksi lama tetap berlaku.' : 'Batalkan transaksi ini? Isi keranjang akan dikosongkan.';
    if ((keranjang.length || koreksiDari) && !confirm(pesan)) return;
    trxAktif = false;
    resetFormTransaksi();
    renderPanelTransaksi();
    renderKeranjang();
  };

  // Tambah 1 pcs berdasarkan kode / ISBN (hasil scan, atau ketikan + Enter dari scanner hardware)
  function tambahDariKode(teks, diam) {
    const p = Store.findProdukPameran(evtId, teks);
    if (!p) {
      if (!diam) toast('“' + String(teks).slice(0, 40) + '” tidak ada di produk pameran', 'error');
      return false;
    }
    const idx = keranjang.findIndex((k) => k.produk.kode === p.kode && !k.catatan);
    if (idx >= 0) keranjang[idx].qty += 1;
    else keranjang.push({ produk: p, qty: 1, catatan: '', diskonTipe: 'PERSEN', diskonNilai: 0 });
    renderKeranjang();
    const qty = keranjang.filter((k) => k.produk.kode === p.kode).reduce((a, k) => a + k.qty, 0);
    const sisa = stokTersisa(p.kode);
    toast(p.nama.slice(0, 40) + ' × ' + qty + (sisa < 0 ? ' — melebihi stok tercatat' : ''), sisa < 0 ? 'error' : 'ok');
    return true;
  }

  window.cariEnter = function (teks) {
    teks = (teks || '').trim();
    if (!teks) return;
    clearTimeout(hasilCariTimer);
    if (tambahDariKode(teks, true)) { $('pmCari').value = ''; $('pmHasilCari').style.display = 'none'; }
  };

  /* ---- Scan di Pameran: produk ditemukan → kartu (pilih) → Scan lagi / Lanjut ke keranjang ---- */
  let kandidatScan = [];   // [{p, pilih}] produk hasil scan yang menunggu dipilih

  // Masukkan produk ke keranjang (baris yang sama bertambah qty); kembalikan total qty produk itu di keranjang
  function masukKeranjang(p, qty) {
    const idx = keranjang.findIndex((k) => k.produk.kode === p.kode && !k.catatan);
    if (idx >= 0) keranjang[idx].qty += qty;
    else keranjang.push({ produk: p, qty, catatan: '', diskonTipe: 'PERSEN', diskonNilai: 0 });
    return keranjang.filter((k) => k.produk.kode === p.kode).reduce((a, k) => a + k.qty, 0);
  }

  function tampilkanKandidat(kodeBaru) {
    const kartu = kandidatScan.map((k) => `
      <button type="button" class="pick-card${k.pilih ? ' on' : ''}${k.p.kode === kodeBaru ? ' baru' : ''}" role="checkbox"
              aria-checked="${k.pilih}" data-kode="${esc(k.p.kode)}" onclick="pilihKandidat(this.dataset.kode)">
        <span class="pick-radio" aria-hidden="true"></span>
        <span class="pick-info">
          <span class="pick-nama">${esc(k.p.nama)}</span>
          <span class="pick-sub">${esc(k.p.kode)} · ${rupiah(k.p.harga)} · stok ${stokTersisa(k.p.kode)}</span>
        </span>
      </button>`).join('');
    showModalBox(kandidatScan.length > 1 ? 'Produk ditemukan (' + kandidatScan.length + ')' : 'Produk ditemukan',
      '<p class="rekap-note">Ketuk kartu untuk memilih produk yang dibeli. Tekan <strong>Scan</strong> bila membeli lebih dari satu jenis, atau <strong>Lanjut</strong> untuk memasukkan yang dipilih ke keranjang.</p>' +
      '<div class="pick-list">' + kartu + '</div>',
      `<div class="btn-row">
        <button class="btn btn-secondary" onclick="scanLagiPameran()">Scan</button>
        <button class="btn btn-primary" onclick="lanjutKandidat()">Lanjut</button>
      </div>`);
  }

  window.pilihKandidat = function (kode) {
    const k = kandidatScan.find((x) => x.p.kode === kode);
    if (!k) return;
    k.pilih = !k.pilih;
    const el = document.querySelector('.pick-card[data-kode="' + (window.CSS && CSS.escape ? CSS.escape(kode) : kode) + '"]');
    if (el) { el.classList.toggle('on', k.pilih); el.setAttribute('aria-checked', k.pilih ? 'true' : 'false'); }
  };

  // Scan produk berikutnya: modal ditutup, kamera lanjut; kartu sebelumnya tetap tersimpan
  window.scanLagiPameran = function () { tutupModal(); };

  window.lanjutKandidat = function () {
    const dipilih = kandidatScan.filter((k) => k.pilih);
    if (!dipilih.length) { toast('Ketuk kartu produk yang dipilih dulu', 'error'); return; }
    let melebihi = 0;
    dipilih.forEach((k) => { masukKeranjang(k.p, 1); if (stokTersisa(k.p.kode) < 0) melebihi++; });
    kandidatScan = [];
    tutupModal();
    Scanner.tutup();
    renderKeranjang();
    toast(dipilih.length + ' produk masuk keranjang — atur jumlah & diskon' + (melebihi ? ' (ada yang melebihi stok)' : ''), melebihi ? 'error' : 'ok');
    const box = $('pmKeranjang');
    if (box && box.scrollIntoView) box.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  window.bukaScanPameran = async function () {
    if (!trxAktif) { await mulaiTransaksiBaru(); if (!trxAktif) return; }
    kandidatScan = [];
    Scanner.buka({
      judul: 'Scan produk — transaksi',
      petunjuk: 'Scan produk, pilih kartunya, lalu Lanjut. Scan lagi bila membeli lebih dari satu jenis.',
      onTutup: () => { kandidatScan = []; },
      onKode: async (teks, sumber) => {
        const p = Store.findProdukPameran(evtId, teks);
        if (p) {
          if (!kandidatScan.some((k) => k.p.kode === p.kode)) kandidatScan.push({ p, pilih: false });
          tampilkanKandidat(p.kode);
          return true;                       // scanner ditahan sampai modal ditutup
        }
        if (sumber === 'manual') {
          // Ketikan bukan kode persis → tutup scanner dan tampilkan hasil pencarian
          Scanner.tutup();
          $('pmCari').value = teks;
          cariProduk(teks);
          $('pmCari').focus();
        } else {
          toast('“' + String(teks).slice(0, 40) + '” tidak ada di produk pameran', 'error');
        }
        return false;
      },
    });
  };

  window.ubahQtyKeranjang = function (i, d) {
    if (!keranjang[i]) return;
    keranjang[i].qty = Math.max(1, keranjang[i].qty + d);
    renderKeranjang();
  };

  /* ---- Hitungan PER ITEM ----
     sub      = harga × qty
     potongan = sub × persen / 100 (dibulatkan ke rupiah)  atau  nominal Rp untuk baris itu (maks. sub)
     net      = sub − potongan          total = jumlah net semua baris */
  function hitungBaris(k) {
    const sub = k.qty * k.produk.harga;
    const nilai = Math.max(0, Number(k.diskonNilai) || 0);
    const rupiahTipe = k.diskonTipe === 'RUPIAH';
    let pot = rupiahTipe ? Math.round(nilai) : Math.round((sub * Math.min(nilai, 100)) / 100 + 1e-9);
    pot = Math.min(pot, sub);
    return { sub, nilai, pot, net: sub - pot, salah: rupiahTipe ? nilai > sub : nilai > 100 };
  }

  function hitungTotal() {
    let subtotal = 0, potongan = 0, total = 0, salah = null;
    keranjang.forEach((k) => {
      const b = hitungBaris(k);
      subtotal += b.sub; potongan += b.pot; total += b.net;
      if (b.salah && !salah) salah = k;
    });
    return { subtotal, potongan, total, salah };
  }

  function rumusBaris(k, b) {
    if (b.salah) return k.diskonTipe === 'RUPIAH' ? 'Potongan melebihi subtotal item' : 'Diskon persen maksimum 100%';
    if (!b.pot) return '';
    return k.diskonTipe === 'RUPIAH'
      ? rupiah(b.sub) + ' − ' + rupiah(b.pot) + ' = ' + rupiah(b.net)
      : b.nilai + '% × ' + rupiah(b.sub) + ' = −' + rupiah(b.pot) + ' → ' + rupiah(b.net);
  }

  // Dipanggil tiap isian diskon berubah: hanya memperbarui angka (tidak merender ulang daftar → fokus ketikan aman)
  window.renderTotal = function () {
    const h = hitungTotal();
    $('pmSubtotal').textContent = rupiah(h.subtotal);
    $('pmDiskonRow').style.display = h.potongan > 0 ? '' : 'none';
    $('pmDiskonRp').textContent = '− ' + rupiah(h.potongan);
    $('pmTotRp').textContent = rupiah(h.total);
    keranjang.forEach((k, i) => {
      const b = hitungBaris(k);
      const net = $('ci-net-' + i), rm = $('ci-rumus-' + i);
      if (net) net.textContent = rupiah(b.net);
      if (rm) { rm.textContent = rumusBaris(k, b); rm.classList.toggle('salah', b.salah); }
    });
    hitungKembalian();
  };

  window.ubahDiskonItem = function (i, bagian, nilai) {
    const k = keranjang[i];
    if (!k) return;
    if (bagian === 'tipe') k.diskonTipe = nilai === 'RUPIAH' ? 'RUPIAH' : 'PERSEN';
    else k.diskonNilai = nilai === '' ? 0 : (parseFloat(nilai) || 0);
    renderTotal();
  };

  function renderKeranjang() {
    const list = $('pmKeranjang');
    if (!keranjang.length) {
      list.innerHTML = '<div class="empty-state">Keranjang kosong. Scan atau cari produk, lalu tekan “Tambah ke Keranjang”.</div>';
    } else {
      list.innerHTML = '<ul class="cart-list">' + keranjang.map((k, i) => `
        <li class="cart-item cart-item-2">
          <div class="cart-info">
            <span class="cart-nama">${esc(k.produk.nama)}</span>
            <span class="cart-sub">${esc(k.produk.kode)} · ${rupiah(k.produk.harga)}${k.catatan ? ' · ' + esc(k.catatan) : ''}</span>
          </div>
          <button class="cart-remove" onclick="hapusKeranjang(${i})" aria-label="Hapus">×</button>
          <div class="cart-line">
            <div class="cart-qty">
              <button type="button" onclick="ubahQtyKeranjang(${i}, -1)" aria-label="Kurangi">−</button>
              <span>${k.qty}</span>
              <button type="button" onclick="ubahQtyKeranjang(${i}, 1)" aria-label="Tambah">+</button>
            </div>
            <strong class="cart-price" id="ci-net-${i}">${rupiah(k.qty * k.produk.harga)}</strong>
          </div>
          <div class="cart-diskon">
            <select aria-label="Jenis diskon" onchange="ubahDiskonItem(${i}, 'tipe', this.value)">
              <option value="PERSEN"${k.diskonTipe === 'RUPIAH' ? '' : ' selected'}>%</option>
              <option value="RUPIAH"${k.diskonTipe === 'RUPIAH' ? ' selected' : ''}>Rp</option>
            </select>
            <input type="number" min="0" step="any" inputmode="decimal" placeholder="Diskon item (opsional)"
                   value="${k.diskonNilai ? Number(k.diskonNilai) : ''}" oninput="ubahDiskonItem(${i}, 'nilai', this.value)" aria-label="Diskon ${esc(k.produk.nama)}">
          </div>
          <span class="cart-rumus" id="ci-rumus-${i}"></span>
        </li>`).join('') + '</ul>';
    }
    $('pmTotItem').textContent = keranjang.reduce((a, k) => a + k.qty, 0);
    $('pmBayarRow').style.display = keranjang.length ? '' : 'none';
    renderTotal();
    updateBadgeNav();
  }

  window.simpanTransaksi = function () {
    if (!butuhEvent()) return;
    if (!keranjang.length) { toast('Keranjang kosong', 'error'); return; }
    const h = hitungTotal();
    if (h.salah) { toast('Diskon “' + h.salah.produk.nama.slice(0, 30) + '” tidak valid', 'error'); return; }
    const metode = ($('pmMetode').value) || 'TUNAI';
    let bayar = h.total; // non-tunai: lunas sesuai total
    if (metode === 'TUNAI') {
      // Tunai: uang pas atau lebih → lanjut (lebih = ada kembalian); kurang → ditolak
      const raw = $('pmTunai').value;
      bayar = raw === '' ? 0 : (parseFloat(raw) || 0);
      if (bayar < h.total) { toast('Uang diterima kurang ' + rupiah(h.total - bayar) + ' (' + rupiah(bayar - h.total) + ')', 'error'); return; }
    }
    const ev = Store.getActiveEvent();
    const email = sesiUser ? sesiUser.email : '';
    const id = Store.uid();
    const waktu = new Date().toISOString();
    const items = keranjang.map((k) => {
      const b = hitungBaris(k);
      return { kode: k.produk.kode, nama: k.produk.nama, harga: k.produk.harga, qty: k.qty, kategori: k.produk.kategori || '',
               catatan: k.catatan, diskonTipe: k.diskonTipe === 'RUPIAH' ? 'RUPIAH' : 'PERSEN', diskonNilai: b.nilai, diskon: b.pot, net: b.net };
    });
    const trx = {
      id, waktu, metode,
      subtotal: h.subtotal, diskon: h.potongan, total: h.total,   // total = setelah diskon per item (dipakai untuk omzet)
      bayar, kembali: Math.max(0, bayar - h.total),
      items,
      kasir: sesiUser ? (sesiUser.nama || sesiUser.email) : '—',
      kasirEmail: email,
      menggantikan: koreksiDari || '',
      deleted: false,
      sinkron: !Sync._stub,
    };
    const semua = Store.getTransaksi(evtId);
    semua.push(trx);
    Store.setTransaksi(evtId, semua);
    if (koreksiDari) {
      // transaksi lama ditandai batal di perangkat; di server dibatalkan bersama penyimpanan transaksi baru (satu proses)
      Store.ubahTransaksi(evtId, koreksiDari, (t) => {
        t.deleted = true;
        t.batal = { alasan: 'Dikoreksi → #' + kodePendek(id), oleh: email, waktu };
        t.diubahLokal = Date.now();
      });
    }
    Sync.tambah({
      aksi: 'simpan', evId: ev.id, event: ev.nama, tgl: ev.tglMulai, trxId: id,
      payload: { trx: { id, waktu, metode, bayar, menggantikan: koreksiDari || '',
        items: items.map((i) => ({ kode: i.kode, nama: i.nama, harga: i.harga, qty: i.qty, diskonTipe: i.diskonTipe, diskonNilai: i.diskonNilai })) } },
    });
    const koreksi = !!koreksiDari;
    trxAktif = false;
    resetFormTransaksi();
    renderPanelTransaksi();
    renderKeranjang();
    renderRiwayatTransaksi();
    toast((koreksi ? 'Koreksi disimpan (' : 'Transaksi disimpan (') + rupiah(h.total) + ')', 'ok');
    Sync.flush();
  };

  /* ---- Riwayat, detail, batal, koreksi ---- */
  function bolehUbahTrx(t) {
    if (!sesiUser) return false;
    return sesiUser.role === 'ADMIN' || !t.kasirEmail || String(t.kasirEmail).toLowerCase() === String(sesiUser.email).toLowerCase();
  }

  function chipSinkron(t) {
    const st = Sync.statusTrx(evtId, t);
    if (st === 'tertunda') return '<span class="chip chip-warn">⏳ Menunggu kirim</span>';
    if (st === 'gagal') return '<span class="chip chip-bad">⚠ Gagal sinkron</span>';
    if (st === 'lokal') return '<span class="chip">Hanya di perangkat</span>';
    return '';
  }

  function renderRiwayatTransaksi() {
    const semua = Store.getTransaksi(evtId);
    const aktif = semua.filter((t) => !t.deleted);
    const box = $('pmRiwayat');
    const hariIni = Store.tglWIB();
    const hariIniTrx = aktif.filter((t) => Store.tglWIB(t.waktu) === hariIni);
    $('pmStat').innerHTML = `
      <div class="stat"><span class="stat-value">${hariIniTrx.length}</span><span class="stat-label">Transaksi</span></div>
      <div class="stat"><span class="stat-value">${hariIniTrx.reduce((a, t) => a + t.items.reduce((x, i) => x + i.qty, 0), 0)}</span><span class="stat-label">Pcs terjual</span></div>
      <div class="stat"><span class="stat-value">${rupiah(hariIniTrx.reduce((a, t) => a + t.total, 0))}</span><span class="stat-label">Omzet</span></div>`;
    if (!semua.length) {
      box.innerHTML = '<div class="empty-state">Belum ada transaksi.</div>';
      return;
    }
    const urut = semua.slice().sort((a, b) => String(b.waktu).localeCompare(String(a.waktu))).slice(0, 30);
    box.innerHTML = '<div class="data-list">' + urut.map((t) => `
      <div class="data-item${t.deleted ? ' deleted' : ''}">
        <div class="data-top">
          <span class="data-nama">${rupiah(t.total)}</span>
          <span class="data-time">#${kodePendek(t.id)} · ${Store.jamWIB(t.waktu)}</span>
        </div>
        <div class="data-meta">
          <span class="chip ${t.metode === 'TUNAI' ? 'chip-ok' : 'chip-warn'}">${esc(t.metode)}</span>
          ${t.deleted ? '<span class="chip chip-bad">Dibatalkan</span>' : ''}
          ${t.menggantikan ? '<span class="chip">Koreksi</span>' : ''}
          ${t.diskon ? '<span class="chip chip-warn">Diskon − ' + rupiah(t.diskon) + '</span>' : ''}
          ${chipSinkron(t)}
          <span>${t.items.map((i) => esc(i.nama) + '×' + i.qty).join(', ')}</span>
        </div>
        <button class="btn btn-pill btn-sm btn-secondary" style="margin-top:8px" data-id="${esc(t.id)}" onclick="detailTransaksi(this.dataset.id)">Detail</button>
      </div>`).join('') + '</div>';
  }

  window.detailTransaksi = function (id) {
    const t = Store.getTransaksi(evtId).find((x) => x.id === id);
    if (!t) return;
    const baris = t.items.map((i) => {
      const net = i.net != null ? i.net : i.qty * i.harga;
      const pot = i.diskon || 0;
      return `<div class="detail-baris">
        <div><strong>${esc(i.nama)}</strong><br><span class="cart-sub">${esc(i.kode)} · ${i.qty} × ${rupiah(i.harga)}${pot ? ' · diskon −' + rupiah(pot) + (i.diskonTipe === 'PERSEN' && i.diskonNilai ? ' (' + i.diskonNilai + '%)' : '') : ''}</span></div>
        <strong>${rupiah(net)}</strong></div>`;
    }).join('');
    const sub = t.subtotal != null ? t.subtotal : t.items.reduce((a, i) => a + i.qty * i.harga, 0);
    const boleh = !t.deleted && bolehUbahTrx(t);
    showModalBox('Transaksi #' + kodePendek(t.id), `
      <div class="detail-list">${baris}</div>
      <div class="total-row"><span class="label">Subtotal</span><span class="value" style="font-size:var(--text-md)">${rupiah(sub)}</span></div>
      ${t.diskon ? '<div class="total-row"><span class="label">Total diskon</span><span class="value" style="font-size:var(--text-md)">− ' + rupiah(t.diskon) + '</span></div>' : ''}
      <div class="total-row grand"><span class="label">Total</span><span class="value">${rupiah(t.total)}</span></div>
      <p class="rekap-note">${esc(t.metode)}${t.metode === 'TUNAI' ? ' · diterima ' + rupiah(t.bayar) + ' · kembali ' + rupiah(t.kembali || 0) : ''}<br>
        ${Store.waktuWIB(t.waktu, true)} · ${esc(t.kasir || t.kasirEmail || '—')}${t.menggantikan ? '<br>Mengoreksi #' + kodePendek(t.menggantikan) : ''}</p>
      ${t.deleted ? '<p class="rekap-note"><span class="chip chip-bad">Dibatalkan</span> ' + esc((t.batal && t.batal.alasan) || '') + (t.batal && t.batal.oleh ? ' — ' + esc(t.batal.oleh) : '') + '<br>Stok produk sudah dikembalikan.</p>' : ''}
      ${chipSinkron(t)}`,
      `<div class="btn-row">${boleh ? `
        <button class="btn btn-secondary" onclick="koreksiTransaksi('${esc(t.id)}')">Koreksi</button>
        <button class="btn btn-danger" onclick="batalkanTransaksi('${esc(t.id)}')">Batalkan</button>` : ''}
        <button class="btn btn-primary" onclick="tutupModal()">Tutup</button></div>`);
  };

  window.batalkanTransaksi = function (id) {
    const t = Store.getTransaksi(evtId).find((x) => x.id === id);
    if (!t || t.deleted) return;
    showModalBox('Batalkan transaksi?', `
      <p>Transaksi #${kodePendek(t.id)} (${rupiah(t.total)}) dibatalkan dan <strong>stok produknya dikembalikan</strong>. Datanya tetap tersimpan sebagai riwayat.</p>
      <div class="form-group"><label class="form-label" for="alasanJenis">Alasan</label>
        <select id="alasanJenis"><option>Salah input</option><option>Pelanggan membatalkan</option><option>Retur</option><option>Lainnya</option></select></div>
      <div class="form-group"><label class="form-label" for="alasanCatatan">Catatan (opsional)</label>
        <input type="text" id="alasanCatatan" maxlength="120" placeholder="mis. salah scan buku"></div>`,
      `<div class="btn-row">
        <button class="btn btn-secondary" onclick="detailTransaksi('${esc(t.id)}')">Kembali</button>
        <button class="btn btn-danger" onclick="konfirmasiBatalTransaksi('${esc(t.id)}')">Ya, batalkan</button>
      </div>`);
  };

  window.konfirmasiBatalTransaksi = function (id) {
    const t = Store.getTransaksi(evtId).find((x) => x.id === id);
    if (!t || t.deleted) return;
    const cat = ($('alasanCatatan').value || '').trim();
    const alasan = $('alasanJenis').value + (cat ? ': ' + cat : '');
    const ev = Store.getActiveEvent();
    const email = sesiUser ? sesiUser.email : '';
    Store.ubahTransaksi(evtId, id, (x) => {
      x.deleted = true;
      x.batal = { alasan, oleh: email, waktu: new Date().toISOString() };
      x.diubahLokal = Date.now();
    });
    if (t.sinkron) {
      Sync.tambah({ aksi: 'batal', evId: ev.id, event: ev.nama, tgl: ev.tglMulai, trxId: id, payload: { id, alasan } });
    }
    tutupModal();
    renderRiwayatTransaksi();
    toast('Transaksi dibatalkan — stok dikembalikan', 'ok');
    Sync.flush();
  };

  // Koreksi = muat isi transaksi ke keranjang; saat disimpan, transaksi lama otomatis dibatalkan
  window.koreksiTransaksi = function (id) {
    const t = Store.getTransaksi(evtId).find((x) => x.id === id);
    if (!t || t.deleted) return;
    if (trxAktif && keranjang.length && !confirm('Keranjang yang sedang dibuat akan diganti dengan isi transaksi ini. Lanjut?')) return;
    tutupModal();
    resetFormTransaksi();
    keranjang = t.items.map((i) => ({
      produk: { kode: i.kode, nama: i.nama, harga: i.harga, isbn: '', kategori: i.kategori || '' },
      qty: i.qty, catatan: i.catatan || '',
      diskonTipe: i.diskonTipe === 'RUPIAH' ? 'RUPIAH' : 'PERSEN',
      diskonNilai: Number(i.diskonNilai) || 0,
    }));
    koreksiDari = id;
    trxAktif = true;
    $('pmMetode').value = t.metode || 'TUNAI';
    ubahMetode();
    renderPanelTransaksi();
    renderKeranjang();
    window.scrollTo({ top: 0 });
  };

  /* ---- Status sinkron ---- */
  function renderSyncBar() {
    const chip = $('pmSyncChip');
    if (!chip || !evtId) return;
    const r = Sync.ringkas(evtId);
    let teks = '✓ Tersinkron', kelas = 'chip-ok';
    if (Sync._stub) { teks = '⚠ js/sync.js tidak termuat — transaksi TIDAK dikirim ke Sheet'; kelas = 'chip-bad'; }
    else if (r.sesiHabis) { teks = 'Sesi habis — login ulang untuk sinkron'; kelas = 'chip-bad'; }
    else if (r.gagal) { teks = '⚠ ' + r.gagal + ' gagal sinkron'; kelas = 'chip-bad'; }
    else if (r.menunggu) { teks = '⏳ ' + r.menunggu + ' menunggu kirim'; kelas = 'chip-warn'; }
    if (r.offline) teks += ' · offline';
    chip.textContent = teks;
    chip.className = 'chip ' + kelas;
  }

  // Kirim antrean lalu tarik data terbaru dari sheet
  async function sinkronTransaksi(diam) {
    const ev = Store.getActiveEvent();
    if (!ev) return;
    await Sync.flush();
    const ok = await Sync.tarik(ev);
    renderSyncBar();
    if (!diam) toast(ok ? 'Sinkron selesai' : 'Sinkron belum berhasil — akan dicoba lagi otomatis', ok ? 'ok' : 'error');
  }
  window.sinkronSekarang = function () { sinkronTransaksi(false); };

  window.tampilkanStatusSync = function () {
    const gagal = Sync.daftar(evtId).filter((o) => o.gagal);
    const r = Sync.ringkas(evtId);
    if (!gagal.length) {
      showModalBox('Status sinkron',
        `<p>${r.menunggu ? r.menunggu + ' transaksi menunggu dikirim ke Sheet. Dikirim otomatis saat koneksi tersedia.' : 'Semua transaksi sudah tersimpan di Sheet.'}</p>` +
        (r.sesiHabis ? '<p>Sesi login habis. Keluar lalu login lagi agar antrean terkirim.</p>' : ''));
      return;
    }
    showModalBox('Gagal sinkron', gagal.map((o) => `
      <div class="data-item deleted" style="margin-bottom:8px">
        <div class="data-nama">${o.aksi === 'simpan' ? 'Simpan' : 'Batalkan'} transaksi #${kodePendek(o.trxId)}</div>
        <div class="data-meta"><span>${esc(o.gagal)}</span></div>
        <div class="btn-row" style="margin-top:8px">
          <button class="btn btn-pill btn-sm btn-secondary" data-q="${esc(o.qid)}" onclick="cobaLagiSync(this.dataset.q)">Coba lagi</button>
          <button class="btn btn-pill btn-sm btn-danger" data-q="${esc(o.qid)}" onclick="buangSync(this.dataset.q)">Buang</button>
        </div>
      </div>`).join(''));
  };
  window.cobaLagiSync = async function (qid) { tutupModal(); await Sync.cobaLagi(qid); renderSyncBar(); };
  window.buangSync = function (qid) {
    if (!confirm('Buang antrean ini? Perubahan tersebut TIDAK akan sampai ke Sheet.')) return;
    Sync.buang(qid); tutupModal(); renderSyncBar(); renderRiwayatTransaksi();
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
    const produk = produkEvent();
    sel.innerHTML = '<option value="">— pilih produk —</option>' +
      produk.map((p) => `<option value="${esc(p.kode)}">${esc(p.kode)} — ${esc(p.nama)}</option>`).join('');
  }

  window.simpanInputManual = function () {
    const kode = $('piProduk').value;
    const qty = parseInt($('piQty').value, 10);
    const kat = $('piKategori').value;
    const ket = $('piCatatan').value.trim();
    const KATEGORI_VALID = ['KANISIUS', 'NON_KANISIUS', 'EKSTERNAL'];
    if (!kode) { toast('Pilih produk', 'err'); return; }
    if (!qty || qty < 1) { toast('Jumlah tidak valid', 'err'); return; }
    if (!KATEGORI_VALID.includes(kat)) { toast('Kategori tidak valid', 'err'); return; }
    const p = Store.findProdukPameran(evtId, kode);
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
          <span class="data-time">${Store.jamWIB(x.waktu)}</span>
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
    const trx = Store.getTransaksi(evtId).filter((t) => !t.deleted);
    const inputs = Store.getInputan(evtId).filter((x) => !x.deleted);
    const keluar = {};
    trx.forEach((t) => t.items.forEach((i) => { keluar[i.kode] = (keluar[i.kode] || 0) + i.qty; }));
    const masuk = {};
    inputs.forEach((x) => { masuk[x.kode] = (masuk[x.kode] || 0) + x.qty; });

    const rows = [['Kode', 'Produk', 'Kategori', 'Stok Awal', 'Terjual', 'Input Manual', 'Sisa Estimasi']];
    // Stok awal = jumlah dibawa (sesi Persiapan, sheet produk_pameran_<tanggal>)
    produkEvent().forEach((p) => {
      const aw = Number(p.jumlah || 0), klr = keluar[p.kode] || 0, msk = masuk[p.kode] || 0;
      rows.push([p.kode, p.nama, p.kategori || '', aw, klr, msk, aw - klr + msk]);
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
    // Total transaksi hanya di baris pertama tiap transaksi (agar tidak terhitung ganda saat dijumlah)
    const rows = [['Waktu', 'Metode', 'Kode', 'Produk', 'Qty', 'Harga', 'Subtotal Item', 'Diskon Item (Rp)', 'Total Item (Rp)', 'Catatan', 'Total Transaksi (Rp)', 'ID Transaksi']];
    trx.forEach((t) =>
      t.items.forEach((i, n) => {
        const sub = i.qty * i.harga, pot = i.diskon || 0;
        rows.push([Store.waktuWIB(t.waktu, true), t.metode, i.kode, i.nama, i.qty, i.harga, sub, pot,
                   i.net != null ? i.net : sub - pot, i.catatan || '', n === 0 ? t.total : '', t.id]);
      })
    );
    Store.unduhCSV('transaksi-' + Store.tglWIB() + '.csv', rows);
    toast('CSV transaksi diunduh', 'ok');
  };

  /* ================= TAMBAHAN: kembalian, tabel rekap, selesai dari sesi ================= */
  // Selisih = uang diterima − total. Positif → kembalian; negatif tampil minus (mis. Rp -2.000); 0 → uang pas
  window.hitungKembalian = function () {
    const total = hitungTotal().total;
    const raw = $('pmTunai') ? $('pmTunai').value : '';
    const bayar = raw === '' ? 0 : (parseFloat(raw) || 0);
    const selisih = bayar - total;
    const el = $('pmKembalian');
    if (el) el.textContent = rupiah(selisih);
    const row = $('pmKembalianRow');
    if (row) row.classList.toggle('kurang', selisih < 0);
  };

  window.ubahMetode = function () {
    const tunai = ($('pmMetode').value || 'TUNAI') === 'TUNAI';
    $('pmTunaiBox').style.display = tunai ? '' : 'none';
    hitungKembalian();
  };

  window.uangPas = function () {
    $('pmTunai').value = hitungTotal().total;
    hitungKembalian();
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
    // Add logged-in class to show navigation bar
    document.body.classList.add('logged-in');
    const navAdmin = $('navAdminBtn');
    if (navAdmin) navAdmin.style.display = user.role === 'ADMIN' ? '' : 'none';
    const chip = $('admRoleChip');
    if (chip) chip.textContent = user.role;
    isiGasUrl();
    $('homeEventInfo').textContent = user.cabang + ' · ' + user.nama;
    goScreen('home');
    catatAktivitas();
    mulaiPemantauIdle();
    Sync.flush(); // kirim antrean yang tertinggal (mis. saat sesi sebelumnya habis / offline)
  }

  window.aksiLogin = async function (e) {
    e.preventDefault();
    const btn = $('btnLogin');
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
    try { localStorage.removeItem(K_AKTIF); localStorage.removeItem(K_LAYAR); } catch (e) { /* abaikan */ }
    GAS.logout();
    location.reload();
  };

  /* ================= SESI: AUTO LOGOUT (idle 1 jam) & PULIH HALAMAN ================= */
  let aktifTerakhir = Date.now();
  let tulisAktifPada = 0;
  let timerIdle = null;
  let peringatanIdle = false;

  function catatAktivitas() {
    const kini = Date.now();
    aktifTerakhir = kini;
    if (kini - tulisAktifPada > 5000) {      // dibagikan antar tab lewat localStorage (maks. 1× per 5 dtk)
      tulisAktifPada = kini;
      try { localStorage.setItem(K_AKTIF, String(kini)); } catch (e) { /* abaikan */ }
    }
    if (peringatanIdle) { peringatanIdle = false; tutupModal(); } // beraktivitas → peringatan ditutup
  }

  function terakhirAktif() {
    let t = aktifTerakhir;
    try { t = Math.max(t, Number(localStorage.getItem(K_AKTIF)) || 0); } catch (e) { /* abaikan */ }
    return t;
  }

  function periksaIdle() {
    if (!sesiUser) return;
    const idle = Date.now() - terakhirAktif();
    if (idle >= BATAS_IDLE_MS) { akhiriSesiIdle(true); return; }
    const sisa = BATAS_IDLE_MS - idle;
    if (sisa <= PERINGATAN_MS) {
      const detik = Math.ceil(sisa / 1000);
      if (!peringatanIdle) {
        peringatanIdle = true;
        showModalBox('Masih di sini?', `<p>Tidak ada aktivitas. Anda akan <strong>keluar otomatis</strong> dalam <strong id="idleSisa">${detik}</strong> detik.</p>
          <p class="rekap-note">Data yang belum tersinkron tetap aman di perangkat.</p>`,
          '<button class="btn btn-primary btn-block" onclick="tetapMasuk()">Tetap masuk</button>');
      } else {
        const el = $('idleSisa');
        if (el) el.textContent = detik;
      }
    }
  }
  window.periksaIdle = periksaIdle;
  window.tetapMasuk = function () { catatAktivitas(); };

  function mulaiPemantauIdle() {
    if (timerIdle) return;
    ['pointerdown', 'keydown', 'touchstart', 'wheel', 'scroll', 'input'].forEach((ev) =>
      window.addEventListener(ev, catatAktivitas, { passive: true, capture: true }));
    document.addEventListener('visibilitychange', () => { if (!document.hidden) periksaIdle(); }); // HP baru dibuka lagi
    timerIdle = setInterval(periksaIdle, 5000);
  }

  function tampilkanPesanLogin() {
    let pesan = '';
    try { pesan = localStorage.getItem(K_PESAN) || ''; localStorage.removeItem(K_PESAN); } catch (e) { /* abaikan */ }
    const el = $('loginPesan');
    if (!el) return;
    el.textContent = pesan;
    el.style.display = pesan ? '' : 'none';
  }

  // Keluar otomatis: cabut sesi (juga di server). Data & antrean sinkron tetap di perangkat.
  function akhiriSesiIdle(muatUlang) {
    try {
      localStorage.setItem(K_PESAN, 'Anda keluar otomatis karena tidak aktif selama 1 jam. Data yang belum tersinkron tetap aman di perangkat dan terkirim setelah Anda masuk lagi.');
      localStorage.removeItem(K_AKTIF);
    } catch (e) { /* abaikan */ }
    GAS.logout();
    if (muatUlang) { location.reload(); return; }
    sesiUser = null;
    document.body.classList.remove('logged-in');
    SCREENS.forEach((sc) => { const el = $('scr-' + sc); if (el) el.classList.toggle('active', sc === 'login'); });
    tampilkanPesanLogin();
  }

  // Dipanggil saat halaman dimuat: periksa sesi, pulihkan pameran aktif & halaman terakhir
  function pulihSesi() {
    const s = GAS.getSession();
    let layarPulih = null;
    if (s && s.user) {
      let t = 0;
      try { t = Number(localStorage.getItem(K_AKTIF)) || 0; } catch (e) { /* abaikan */ }
      if (t && Date.now() - t >= BATAS_IDLE_MS) { akhiriSesiIdle(false); }   // ditinggal >1 jam (mis. HP dimatikan)
      else {
        try { layarPulih = JSON.parse(localStorage.getItem(K_LAYAR) || 'null'); } catch (e) { layarPulih = null; }
        tampilkanApp(s.user);
      }
    } else {
      $('scr-login').classList.add('active');
      tampilkanPesanLogin();
    }

    // Restore event aktif
    const id = Store.getActiveId();
    if (id && Store.getEvents().some((e) => e.id === id)) {
      evtId = id;
      const ev = Store.getActiveEvent();
      $('homeEventInfo').textContent = ev.nama + ' · ' + ev.tanggal;
    }
    renderHome();

    // Pulihkan halaman terakhir (hanya bila masih sah: Admin untuk /admin, pameran aktif untuk sesi pameran)
    if (layarPulih && sesiUser && SCREENS.includes(layarPulih) && layarPulih !== 'login' && layarPulih !== 'home') {
      const perluEvent = ['persiapan', 'pameran', 'penginputan'].includes(layarPulih);
      if ((layarPulih !== 'admin' || isAdmin()) && (!perluEvent || evtId)) goScreen(layarPulih);
    }
  }
  window.pulihSesi = pulihSesi;

  /* ================= HALAMAN ADMIN ================= */
  function catatLog(txt) {
    const box = $('admLog');
    if (box.textContent === '(belum ada aktivitas)' || box.textContent === '(log dibersihkan)') box.textContent = '';
    box.textContent = Store.waktuWIB(Date.now(), true) + ' ▸ ' + txt + '\n' + box.textContent;
  }

  function isiGasUrl() {
    const el = $('gasUrl');
    if (!el) return;
    const u = GAS.getUrl() || '';
    const ringkas = u.replace(/^https:\/\//, '');
    el.textContent = ringkas.length > 46 ? ringkas.slice(0, 30) + '…' + ringkas.slice(-12) : ringkas;
    el.title = u;
  }

  window.salinGasUrl = async function () {
    try { await navigator.clipboard.writeText(GAS.getUrl()); toast('URL disalin', 'ok'); }
    catch (e) { toast('Tidak bisa menyalin — salin manual dari js/gas.js', 'error'); }
  };

  // Status koneksi: idle | loading | ok | bad
  function setStatusKoneksi(state, teks) {
    const el = $('admStatus');
    if (!el) return;
    el.setAttribute('data-state', state);
    $('admStatusTeks').textContent = teks;
  }

  window.tesKoneksi = async function () {
    const btn = $('btnTesKoneksi');
    btn.disabled = true;
    setStatusKoneksi('loading', 'Menguji…');
    catatLog('ping…');
    const t0 = Date.now();
    try {
      const d = await GAS.runTest('ping');
      const ms = Date.now() - t0;
      setStatusKoneksi('ok', 'Terhubung · ' + ms + ' ms');
      catatLog('OK (' + ms + ' ms): ' + JSON.stringify(d));
      toast('Koneksi OK', 'ok');
    } catch (e) {
      setStatusKoneksi('bad', e.jaringan ? 'Tidak ada koneksi' : 'Gagal');
      catatLog('GAGAL: ' + e.message);
      toast('Koneksi gagal: ' + e.message, 'error');
    } finally { btn.disabled = false; }
  };

  window.jalanTes = async function (nama) {
    catatLog('test ' + nama + '…');
    try { const d = await GAS.runTest(nama); catatLog(JSON.stringify(d, null, 1)); toast('Tes selesai', 'ok'); }
    catch (e) { catatLog('GAGAL: ' + e.message); toast('Tes gagal', 'error'); }
  };

  window.bersihkanLog = function () { $('admLog').textContent = '(log dibersihkan)'; };

  window.muaiUsers = async function () {
    const ul = $('admUserList');
    ul.innerHTML = '<li class="hint-text">Memuat…</li>';
    try {
      const users = await GAS.listUsers();
      $('admJumlah').textContent = users.length;
      if (admStatusIdle()) setStatusKoneksi('ok', 'Terhubung');
      ul.innerHTML = users.map((u) => `
        <li class="user-row">
          <div style="min-width:0"><span class="user-cabang">${esc(u.cabang)}</span><span class="user-email">${esc(u.email)}</span></div>
          <span class="chip chip-role">${esc(u.role)}</span>
          <button class="btn btn-pill btn-sm btn-danger-ghost" data-email="${esc(u.email)}" onclick="hapusUser(this.dataset.email)"
                  aria-label="Hapus ${esc(u.email)}">Hapus</button>
        </li>`).join('') || '<li class="hint-text">Belum ada user.</li>';
    } catch (e) {
      $('admJumlah').textContent = '0';
      setStatusKoneksi('bad', e.jaringan ? 'Tidak ada koneksi' : 'Gagal');
      ul.innerHTML = '<li class="hint-text">Gagal memuat: ' + esc(e.message) + '</li>';
    }
  };
  const admStatusIdle = () => $('admStatus').getAttribute('data-state') !== 'loading';

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
      toast('Akun ' + u.email + ' dibuat — user bisa langsung login', 'ok');
      $('admCabang').value = ''; $('admEmail').value = ''; $('admPass').value = '';
      muaiUsers();
    } catch (e) { toast('Gagal: ' + e.message, 'error'); }
  };

  window.hapusUser = async function (email) {
    if (!confirm('Hapus akun ' + email + '?')) return;
    try { await GAS.deleteUser(email); toast('User dihapus', 'ok'); muaiUsers(); }
    catch (e) { toast('Gagal: ' + e.message, 'error'); }
  };

  /* ================= INIT ================= */
  document.addEventListener('DOMContentLoaded', function () {
    terapkanTheme(document.documentElement.getAttribute('data-theme') === 'dark', false); // sinkronkan posisi slider
    isiGasUrl(); // URL Web App (dikunci di js/gas.js) pada halaman Admin, hanya-baca

    pulihSesi(); // gate RBAC + auto logout + pulihkan pameran aktif & halaman terakhir

    // Shortcut pencarian: "/" fokus ke input cari
    // Shortcut tema: Ctrl+Shift+T
    // Shortcut logout: Ctrl+Shift+L
    document.addEventListener('keydown', function (e) {
      if (e.key === '/' && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) {
        if (document.querySelector('#scr-pameran.active')) { e.preventDefault(); $('pmCari').focus(); }
      }
      if (e.key === 'Escape') {
        $('pmHasilCari').style.display = 'none';
        tutupModal();
      }
      // Ctrl+Shift+T untuk toggle tema
      if (e.ctrlKey && e.shiftKey && e.key === 'T') {
        e.preventDefault();
        toggleTheme();
      }
      // Ctrl+Shift+L untuk logout
      if (e.ctrlKey && e.shiftKey && e.key === 'L') {
        e.preventDefault();
        keluarLogin();
      }
    });

    // Sinkron transaksi: render ulang saat antrean/data berubah; tarik data berkala saat layar Pameran terbuka
    Sync.onUbah(function () {
      renderSyncBar();
      if (document.querySelector('#scr-pameran.active') && evtId) renderRiwayatTransaksi();
    });
    Sync.onTick = function () {
      if (document.querySelector('#scr-pameran.active')) return Sync.tarik(Store.getActiveEvent());
    };
    Sync.mulaiOtomatis();

    // Klik luar modal menutup
    $('modalUmum').addEventListener('click', function (e) {
      if (e.target === this) tutupModal();
    });
  });
})();
