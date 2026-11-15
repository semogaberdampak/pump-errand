/* ============================================================
   app/pameran.js — Sesi 2: pencarian produk, keranjang, diskon,
   pembayaran, riwayat transaksi, koreksi/pembatalan, serta
   pemindaian (kamera & scan gun).
   ============================================================ */
(function (App) {
  'use strict';
  const S = App.state;
  const {
    $, esc, rupiah, toast, showModalBox, tutupModal,
    butuhEvent, produkEvent, kodePendek, updateBadgeNav, goScreen,
  } = App;
  const { Store, Sync } = window;

  /* ================= SESI 2 — PAMERAN ================= */
  let hasilCariTimer = null;

  function renderPameran() {
    if (!App.butuhEvent()) return;
    // Gerbang waktu: sesi pameran hanya terbuka pada rentang tanggal agenda
    // Tanggal acuan = WIB (Asia/Jakarta)
    const ev = Store.getEvents().find((e) => e.id === S.evtId);
    if (ev && ev.tglMulai) {
      const hariIni = Store.tglWIB(); // YYYY-MM-DD zona WIB
      if (hariIni < ev.tglMulai || hariIni > (ev.tglSelesai || ev.tglMulai)) {
        toast('Sesi pameran baru terbuka saat hari-H (' + ev.tanggal + ')', 'error');
        goScreen('persiapan');
        return;
      }
    }
    S.trxAktif = S.trxAktif || S.keranjang.length > 0;
    renderSyncBar();
    renderPanelTransaksi();
    renderKeranjang();
    renderRiwayatTransaksi();
  }
  window.renderPameran = renderPameran;

  // Sisa stok tercatat = jumlah dibawa − terjual + input manual − yang sudah ada di keranjang
  function stokTersisa(kode) {
    const p = App.produkEvent().find((x) => x.kode === kode);
    if (!p) return 0;
    let terjual = 0, masuk = 0;
    Store.getTransaksi(S.evtId).forEach((t) => {
      // transaksi dibatalkan → stok kembali; transaksi yang sedang dikoreksi dihitung ulang lewat keranjang
      if (!t.deleted && t.id !== S.koreksiDari) t.items.forEach((i) => { if (i.kode === kode) terjual += i.qty; });
    });
    Store.getInputan(S.evtId).forEach((x) => { if (!x.deleted && x.kode === kode) masuk += x.qty; });
    const diKeranjang = S.keranjang.filter((k) => k.produk.kode === kode).reduce((a, k) => a + k.qty, 0);
    return Number(p.jumlah || 0) - terjual + masuk - diKeranjang;
  }

  window.cariProduk = function (q) {
    clearTimeout(hasilCariTimer);
    hasilCariTimer = setTimeout(() => {
      const panel = $('pmHasilCari');
      const kata = (q || '').trim().toLowerCase();
      if (!kata) { panel.style.display = 'none'; panel.innerHTML = ''; return; }
      const nk = Store.normKode(kata);
      // Hanya produk yang dibawa ke pameran (database produk_pameran)
      const hasil = App.produkEvent().filter((p) =>
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
    const p = Store.findProdukPameran(S.evtId, kode);
    if (p) pilihProduk(p);
  };

  window.pilihProduk = function (p) {
    $('pmHasilCari').style.display = 'none';
    $('pmCari').value = '';
    S.produkTerpilih = p;
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
    if (!S.produkTerpilih) { toast('Pilih produk dulu', 'err'); return; }
    const qty = parseInt($('pmQty').value, 10);
    if (!qty || qty < 1) { toast('Jumlah tidak valid', 'err'); return; }
    const ket = ($('pmCatatanItem').value || '').trim();
    const idx = S.keranjang.findIndex((k) => k.produk.kode === S.produkTerpilih.kode && k.catatan === ket);
    if (idx >= 0) S.keranjang[idx].qty += qty;
    else S.keranjang.push({ produk: S.produkTerpilih, qty, catatan: ket, diskonTipe: 'PERSEN', diskonNilai: 0 });
    const kodeTambah = S.produkTerpilih.kode;
    $('pmCatatanItem').value = '';
    S.produkTerpilih = null;
    $('pmProdukInfo').style.display = 'none';
    renderKeranjang();
    const sisa = stokTersisa(kodeTambah);
    if (sisa < 0) toast('Ditambah, tetapi melebihi stok tercatat (selisih ' + Math.abs(sisa) + ' pcs)', 'error');
    else toast('Ditambah ke keranjang', 'ok');
  };

  window.hapusKeranjang = function (i) {
    S.keranjang.splice(i, 1);
    renderKeranjang();
  };

  /* ---- Transaksi Baru ---- */

  // Bilah lengket: tampil selama transaksi berjalan dan keranjang tidak kosong,
  // sehingga total & tombol bayar tetap terlihat tanpa menggulir keranjang panjang.
  function renderDock() {
    const el = $('pmDock');
    if (!el) return;
    const tampil = S.trxAktif && S.keranjang.length > 0;
    el.style.display = tampil ? '' : 'none';
    document.body.classList.toggle('dock-open', tampil);
    if (!tampil) return;
    const h = hitungTotal();
    $('pmDockTotal').textContent = rupiah(h.total);
    $('pmDockLabel').textContent = 'Total · ' + S.keranjang.reduce((a, k) => a + k.qty, 0) + ' pcs';
  }

  // Tombol bayar di bilah lengket: tunai butuh uang diterima, selain itu langsung simpan
  window.dockBayar = function () {
    const metode = ($('pmMetode').value) || 'TUNAI';
    if (metode === 'TUNAI' && ($('pmTunai').value || '') === '') {
      const row = $('pmBayarRow');
      if (row && row.scrollIntoView) row.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setTimeout(() => { const el = $('pmTunai'); if (el) el.focus(); }, 300);
      toast('Isi uang diterima dulu', 'error');
      return;
    }
    simpanTransaksi();
  };

  function renderPanelTransaksi() {
    $('pmTrxBaru').style.display = S.trxAktif ? '' : 'none';
    $('pmBtnBaru').style.display = S.trxAktif ? 'none' : '';
    renderDock();
    $('pmJudulTrx').textContent = S.koreksiDari ? 'Koreksi Transaksi' : 'Transaksi Baru';
    const info = $('pmKoreksiInfo');
    info.style.display = S.koreksiDari ? '' : 'none';
    if (S.koreksiDari) info.textContent = 'Mengoreksi transaksi #' + App.kodePendek(S.koreksiDari) + '. Transaksi lama otomatis dibatalkan saat transaksi baru ini disimpan.';
  }


  function resetFormTransaksi() {
    S.keranjang = [];
    S.produkTerpilih = null;
    S.koreksiDari = null;
    $('pmProdukInfo').style.display = 'none';
    $('pmCari').value = '';
    $('pmHasilCari').style.display = 'none';
    $('pmCatatanItem').value = '';
    $('pmMetode').value = 'TUNAI';
    $('pmTunai').value = '';
    ubahMetode();
  }

  window.mulaiTransaksiBaru = async function () {
    if (!App.butuhEvent()) return;
    if (!App.produkEvent().length) await App.syncProdukPameran(true);
    if (!App.produkEvent().length) { toast('Belum ada produk pameran — tambahkan dulu di sesi Persiapan', 'error'); return; }
    S.trxAktif = true;
    resetFormTransaksi();
    renderPanelTransaksi();
    renderKeranjang();
    setTimeout(() => $('pmCari').focus(), 50);
  };

  window.batalTransaksi = function () {
    const pesan = S.koreksiDari ? 'Batalkan koreksi? Transaksi lama tetap berlaku.' : 'Batalkan transaksi ini? Isi keranjang akan dikosongkan.';
    if ((S.keranjang.length || S.koreksiDari) && !confirm(pesan)) return;
    S.trxAktif = false;
    resetFormTransaksi();
    renderPanelTransaksi();
    renderKeranjang();
  };

  // Tambah 1 pcs berdasarkan kode / ISBN (hasil scan, atau ketikan + Enter dari scanner hardware)
  function tambahDariKode(teks, diam) {
    const p = Store.findProdukPameran(S.evtId, teks);
    if (!p) {
      if (App.suara) App.suara.mainkan('gagal');   // kode tidak dikenal: nada rendah + getar
      if (!diam) toast('“' + String(teks).slice(0, 40) + '” tidak ada di produk pameran', 'error');
      return false;
    }
    const idx = S.keranjang.findIndex((k) => k.produk.kode === p.kode && !k.catatan);
    if (idx >= 0) S.keranjang[idx].qty += 1;
    else S.keranjang.push({ produk: p, qty: 1, catatan: '', diskonTipe: 'PERSEN', diskonNilai: 0 });
    renderKeranjang();
    const qty = S.keranjang.filter((k) => k.produk.kode === p.kode).reduce((a, k) => a + k.qty, 0);
    const sisa = stokTersisa(p.kode);
    if (App.suara) App.suara.mainkan(sisa < 0 ? 'stok' : 'ok');   // bunyi langsung, tanpa lihat layar
    toast(p.nama.slice(0, 40) + ' × ' + qty + (sisa < 0 ? ' — melebihi stok tercatat' : ''), sisa < 0 ? 'error' : 'ok');
    return true;
  }

  window.cariEnter = function (teks) {
    teks = (teks || '').trim();
    if (!teks) return;
    clearTimeout(hasilCariTimer);
    if (tambahDariKode(teks, true)) { $('pmCari').value = ''; $('pmHasilCari').style.display = 'none'; }
  };

  /* ---- Scanner gun (keyboard wedge) bekerja global ----
     Scanner gun mengetik kode dengan jeda sangat rapat lalu Enter. Bila fokus
     tidak ada di kolom input mana pun, kode langsung masuk keranjang tanpa
     membuka pencarian. Ketikan manusia (jeda > 80 ms) diabaikan. */
  function pasangScanGun() {
    let buf = '';
    let mulai = 0;
    let terakhir = 0;
    const lupakan = () => { buf = ''; mulai = 0; };

    document.addEventListener('keydown', function (e) {
      if (e.ctrlKey || e.metaKey || e.altKey) { lupakan(); return; }

      if (e.key === 'Enter') {
        const kode = buf;
        const deras = buf.length >= 4 && Date.now() - mulai < 400;
        lupakan();
        if (!deras) return;
        if (document.querySelector('#modalUmum.open, #scanOverlay.open')) return;
        if (!document.querySelector('#scr-pameran.active')) return;
        if (!S.trxAktif) { toast('Tekan “Transaksi Baru” dulu sebelum scan', 'error'); return; }
        e.preventDefault();
        tambahDariKode(kode, false);
        return;
      }

      if (typeof e.key !== 'string' || e.key.length !== 1) { lupakan(); return; }
      const target = e.target;
      if (target && /INPUT|TEXTAREA|SELECT/.test(target.tagName)) { lupakan(); return; }

      const kini = Date.now();
      if (kini - terakhir > 80) { buf = ''; mulai = kini; }   // jeda panjang → kode baru
      terakhir = kini;
      buf += e.key;
    });
  }

  /* ---- Scan di Pameran: produk ditemukan → kartu (otomatis terpilih) → Scan lagi / Lanjut ke keranjang ---- */

  // Masukkan produk ke keranjang (baris yang sama bertambah qty); kembalikan total qty produk itu di keranjang
  function masukKeranjang(p, qty) {
    const idx = S.keranjang.findIndex((k) => k.produk.kode === p.kode && !k.catatan);
    if (idx >= 0) S.keranjang[idx].qty += qty;
    else S.keranjang.push({ produk: p, qty, catatan: '', diskonTipe: 'PERSEN', diskonNilai: 0 });
    return S.keranjang.filter((k) => k.produk.kode === p.kode).reduce((a, k) => a + k.qty, 0);
  }

  function tampilkanKandidat(kodeBaru) {
    const kartu = S.kandidatScan.map((k) => `
      <button type="button" class="pick-card${k.pilih ? ' on' : ''}${k.p.kode === kodeBaru ? ' baru' : ''}" role="checkbox"
              aria-checked="${k.pilih}" data-kode="${esc(k.p.kode)}" onclick="pilihKandidat(this.dataset.kode)">
        <span class="pick-radio" aria-hidden="true"></span>
        <span class="pick-info">
          <span class="pick-nama">${esc(k.p.nama)}</span>
          <span class="pick-sub">${esc(k.p.kode)} · ${rupiah(k.p.harga)} · stok ${stokTersisa(k.p.kode)}</span>
        </span>
        ${k.n > 1 ? '<span class="pick-qty">×' + k.n + '</span>' : ''}
      </button>`).join('');
    const totalPcs = S.kandidatScan.filter((k) => k.pilih).reduce((a, k) => a + k.n, 0);
    showModalBox(S.kandidatScan.length > 1 ? 'Produk ditemukan (' + S.kandidatScan.length + ')' : 'Produk ditemukan',
      '<p class="rekap-note">Semua hasil scan otomatis terpilih — scan judul lain, atau scan kode yang sama lagi untuk menambah jumlah. Ketuk kartu untuk membatalkan pilihan, lalu <strong>Lanjut</strong> memasukkan <span id="pickTotal">' + totalPcs + ' pcs</span> ke keranjang.</p>' +
      '<div class="pick-list">' + kartu + '</div>',
      `<div class="btn-row">
        <button class="btn btn-secondary" onclick="scanLagiPameran()">Scan</button>
        <button class="btn btn-primary" onclick="lanjutKandidat()">Lanjut</button>
      </div>`);
  }

  window.pilihKandidat = function (kode) {
    const k = S.kandidatScan.find((x) => x.p.kode === kode);
    if (!k) return;
    k.pilih = !k.pilih;
    const el = document.querySelector('.pick-card[data-kode="' + (window.CSS && CSS.escape ? CSS.escape(kode) : kode) + '"]');
    if (el) { el.classList.toggle('on', k.pilih); el.setAttribute('aria-checked', k.pilih ? 'true' : 'false'); }
    const total = $('pickTotal');
    if (total) total.textContent = S.kandidatScan.filter((x) => x.pilih).reduce((a, x) => a + x.n, 0) + ' pcs';
  };

  // Scan produk berikutnya: modal ditutup, kamera lanjut; kartu sebelumnya tetap tersimpan
  window.scanLagiPameran = function () { tutupModal(); };

  window.lanjutKandidat = function () {
    const dipilih = S.kandidatScan.filter((k) => k.pilih);
    if (!dipilih.length) { toast('Ketuk kartu produk yang akan dimasukkan dulu', 'error'); return; }
    let melebihi = 0, totalPcs = 0;
    dipilih.forEach((k) => { totalPcs += k.n; masukKeranjang(k.p, k.n); if (stokTersisa(k.p.kode) < 0) melebihi++; });
    S.kandidatScan = [];
    tutupModal();
    Scanner.tutup();
    renderKeranjang();
    if (App.suara) App.suara.mainkan(melebihi ? 'stok' : 'ok');
    toast(totalPcs + ' pcs (' + dipilih.length + ' judul) masuk keranjang — atur diskon bila perlu' + (melebihi ? ' (ada yang melebihi stok)' : ''), melebihi ? 'error' : 'ok');
    const box = $('pmKeranjang');
    if (box && box.scrollIntoView) box.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  window.bukaScanPameran = async function () {
    if (!S.trxAktif) { await mulaiTransaksiBaru(); if (!S.trxAktif) return; }
    S.kandidatScan = [];
    Scanner.buka({
      judul: 'Scan produk — transaksi',
      petunjuk: 'Scan produk satu per satu, lalu tekan Lanjut. Kode yang sama di-scan lagi = jumlah bertambah.',
      onTutup: () => { S.kandidatScan = []; },
      onKode: async (teks, sumber) => {
        const p = Store.findProdukPameran(S.evtId, teks);
        if (p) {
          const ada = S.kandidatScan.find((k) => k.p.kode === p.kode);
          if (ada) { ada.n += 1; ada.pilih = true; }   // buku yang sama: tambah jumlah
          else S.kandidatScan.push({ p, pilih: true, n: 1 });
          if (App.suara) App.suara.mainkan(stokTersisa(p.kode) < 0 ? 'stok' : 'ok');
          tampilkanKandidat(p.kode);
          return true;                       // scanner ditahan sampai modal ditutup
        }
        if (App.suara) App.suara.mainkan('gagal');
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
    if (!S.keranjang[i]) return;
    S.keranjang[i].qty = Math.max(1, S.keranjang[i].qty + d);
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
    S.keranjang.forEach((k) => {
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
    S.keranjang.forEach((k, i) => {
      const b = hitungBaris(k);
      const net = $('ci-net-' + i), rm = $('ci-rumus-' + i);
      if (net) net.textContent = rupiah(b.net);
      if (rm) { rm.textContent = rumusBaris(k, b); rm.classList.toggle('salah', b.salah); }
    });
    hitungKembalian();
    renderDock();
  };

  window.ubahDiskonItem = function (i, bagian, nilai) {
    const k = S.keranjang[i];
    if (!k) return;
    if (bagian === 'tipe') k.diskonTipe = nilai === 'RUPIAH' ? 'RUPIAH' : 'PERSEN';
    else k.diskonNilai = nilai === '' ? 0 : (parseFloat(nilai) || 0);
    renderTotal();
  };

  function renderKeranjang() {
    const list = $('pmKeranjang');
    if (!S.keranjang.length) {
      list.innerHTML = '<div class="empty-state">Keranjang kosong. Scan atau cari produk, lalu tekan “Tambah ke Keranjang”.</div>';
    } else {
      list.innerHTML = '<ul class="cart-list">' + S.keranjang.map((k, i) => `
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
    $('pmTotItem').textContent = S.keranjang.reduce((a, k) => a + k.qty, 0);
    $('pmBayarRow').style.display = S.keranjang.length ? '' : 'none';
    renderTotal();
    App.updateBadgeNav();
  }

  window.simpanTransaksi = function () {
    if (!App.butuhEvent()) return;
    if (!S.keranjang.length) { toast('Keranjang kosong', 'error'); return; }
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
    const email = S.user ? S.user.email : '';
    const id = Store.uid();
    const waktu = new Date().toISOString();
    const items = S.keranjang.map((k) => {
      const b = hitungBaris(k);
      return { kode: k.produk.kode, nama: k.produk.nama, harga: k.produk.harga, qty: k.qty, kategori: k.produk.kategori || '',
               catatan: k.catatan, diskonTipe: k.diskonTipe === 'RUPIAH' ? 'RUPIAH' : 'PERSEN', diskonNilai: b.nilai, diskon: b.pot, net: b.net };
    });
    const trx = {
      id, waktu, metode,
      subtotal: h.subtotal, diskon: h.potongan, total: h.total,   // total = setelah diskon per item (dipakai untuk omzet)
      bayar, kembali: Math.max(0, bayar - h.total),
      items,
      kasir: S.user ? (S.user.nama || S.user.email) : '—',
      kasirEmail: email,
      menggantikan: S.koreksiDari || '',
      deleted: false,
      sinkron: !Sync._stub,
    };
    const semua = Store.getTransaksi(S.evtId);
    semua.push(trx);
    Store.setTransaksi(S.evtId, semua);
    if (S.koreksiDari) {
      // transaksi lama ditandai batal di perangkat; di server dibatalkan bersama penyimpanan transaksi baru (satu proses)
      Store.ubahTransaksi(S.evtId, S.koreksiDari, (t) => {
        t.deleted = true;
        t.batal = { alasan: 'Dikoreksi → #' + App.kodePendek(id), oleh: email, waktu };
        t.diubahLokal = Date.now();
      });
    }
    Sync.tambah({
      aksi: 'simpan', evId: ev.id, event: ev.nama, tgl: ev.tglMulai, trxId: id,
      payload: { trx: { id, waktu, metode, bayar, menggantikan: S.koreksiDari || '',
        items: items.map((i) => ({ kode: i.kode, nama: i.nama, harga: i.harga, qty: i.qty, diskonTipe: i.diskonTipe, diskonNilai: i.diskonNilai })) } },
    });
    const koreksi = !!S.koreksiDari;
    S.trxAktif = false;
    resetFormTransaksi();
    renderPanelTransaksi();
    renderKeranjang();
    renderRiwayatTransaksi();
    toast((koreksi ? 'Koreksi disimpan (' : 'Transaksi disimpan (') + rupiah(h.total) + ')', 'ok');
    Sync.flush();
  };

  /* ---- Riwayat, detail, batal, koreksi ---- */
  function bolehUbahTrx(t) {
    if (!S.user) return false;
    return S.user.role === 'ADMIN' || !t.kasirEmail || String(t.kasirEmail).toLowerCase() === String(S.user.email).toLowerCase();
  }

  function chipSinkron(t) {
    const st = Sync.statusTrx(S.evtId, t);
    if (st === 'tertunda') return '<span class="chip chip-warn">⏳ Menunggu kirim</span>';
    if (st === 'gagal') return '<span class="chip chip-bad">⚠ Gagal sinkron</span>';
    if (st === 'lokal') return '<span class="chip">Hanya di perangkat</span>';
    return '';
  }

  function renderRiwayatTransaksi() {
    const semua = Store.getTransaksi(S.evtId);
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
          <span class="data-time">#${App.kodePendek(t.id)} · ${Store.jamWIB(t.waktu)}</span>
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
    const t = Store.getTransaksi(S.evtId).find((x) => x.id === id);
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
    showModalBox('Transaksi #' + App.kodePendek(t.id), `
      <div class="detail-list">${baris}</div>
      <div class="total-row"><span class="label">Subtotal</span><span class="value" style="font-size:var(--text-md)">${rupiah(sub)}</span></div>
      ${t.diskon ? '<div class="total-row"><span class="label">Total diskon</span><span class="value" style="font-size:var(--text-md)">− ' + rupiah(t.diskon) + '</span></div>' : ''}
      <div class="total-row grand"><span class="label">Total</span><span class="value">${rupiah(t.total)}</span></div>
      <p class="rekap-note">${esc(t.metode)}${t.metode === 'TUNAI' ? ' · diterima ' + rupiah(t.bayar) + ' · kembali ' + rupiah(t.kembali || 0) : ''}<br>
        ${Store.waktuWIB(t.waktu, true)} · ${esc(t.kasir || t.kasirEmail || '—')}${t.menggantikan ? '<br>Mengoreksi #' + App.kodePendek(t.menggantikan) : ''}</p>
      ${t.deleted ? '<p class="rekap-note"><span class="chip chip-bad">Dibatalkan</span> ' + esc((t.batal && t.batal.alasan) || '') + (t.batal && t.batal.oleh ? ' — ' + esc(t.batal.oleh) : '') + '<br>Stok produk sudah dikembalikan.</p>' : ''}
      ${chipSinkron(t)}`,
      `<div class="btn-row">${boleh ? `
        <button class="btn btn-secondary" onclick="koreksiTransaksi('${esc(t.id)}')">Koreksi</button>
        <button class="btn btn-danger" onclick="batalkanTransaksi('${esc(t.id)}')">Batalkan</button>` : ''}
        <button class="btn btn-primary" onclick="tutupModal()">Tutup</button></div>`);
  };

  window.batalkanTransaksi = function (id) {
    const t = Store.getTransaksi(S.evtId).find((x) => x.id === id);
    if (!t || t.deleted) return;
    showModalBox('Batalkan transaksi?', `
      <p>Transaksi #${App.kodePendek(t.id)} (${rupiah(t.total)}) dibatalkan dan <strong>stok produknya dikembalikan</strong>. Datanya tetap tersimpan sebagai riwayat.</p>
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
    const t = Store.getTransaksi(S.evtId).find((x) => x.id === id);
    if (!t || t.deleted) return;
    const cat = ($('alasanCatatan').value || '').trim();
    const alasan = $('alasanJenis').value + (cat ? ': ' + cat : '');
    const ev = Store.getActiveEvent();
    const email = S.user ? S.user.email : '';
    Store.ubahTransaksi(S.evtId, id, (x) => {
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
    const t = Store.getTransaksi(S.evtId).find((x) => x.id === id);
    if (!t || t.deleted) return;
    if (S.trxAktif && S.keranjang.length && !confirm('Keranjang yang sedang dibuat akan diganti dengan isi transaksi ini. Lanjut?')) return;
    tutupModal();
    resetFormTransaksi();
    S.keranjang = t.items.map((i) => ({
      produk: { kode: i.kode, nama: i.nama, harga: i.harga, isbn: '', kategori: i.kategori || '' },
      qty: i.qty, catatan: i.catatan || '',
      diskonTipe: i.diskonTipe === 'RUPIAH' ? 'RUPIAH' : 'PERSEN',
      diskonNilai: Number(i.diskonNilai) || 0,
    }));
    S.koreksiDari = id;
    S.trxAktif = true;
    $('pmMetode').value = t.metode || 'TUNAI';
    ubahMetode();
    renderPanelTransaksi();
    renderKeranjang();
    window.scrollTo({ top: 0 });
  };

  /* ---- Status sinkron ---- */
  function renderSyncBar() {
    const chip = $('pmSyncChip');
    if (!chip || !S.evtId) return;
    const r = Sync.ringkas(S.evtId);
    let teks = '✓ Tersinkron', kelas = 'chip-ok';
    if (Sync._stub) { teks = '⚠ js/sync.js tidak termuat — transaksi TIDAK dikirim ke database'; kelas = 'chip-bad'; }
    else if (r.sesiHabis) { teks = 'Sesi habis — login ulang untuk sinkron'; kelas = 'chip-bad'; }
    else if (r.gagal) { teks = '⚠ ' + r.gagal + ' gagal sinkron'; kelas = 'chip-bad'; }
    else if (r.menunggu) { teks = '⏳ ' + r.menunggu + ' menunggu kirim'; kelas = 'chip-warn'; }
    if (r.offline) teks += ' · offline';
    chip.textContent = teks;
    chip.className = 'chip ' + kelas;
  }

  // Kirim antrean lalu tarik data terbaru dari database
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
    const gagal = Sync.daftar(S.evtId).filter((o) => o.gagal);
    const r = Sync.ringkas(S.evtId);
    if (!gagal.length) {
      showModalBox('Status sinkron',
        `<p>${r.menunggu ? r.menunggu + ' transaksi menunggu dikirim ke database. Dikirim otomatis saat koneksi tersedia.' : 'Semua transaksi sudah tersimpan di database.'}</p>` +
        (r.sesiHabis ? '<p>Sesi login habis. Keluar lalu login lagi agar antrean terkirim.</p>' : ''));
      return;
    }
    showModalBox('Gagal sinkron', gagal.map((o) => `
      <div class="data-item deleted" style="margin-bottom:8px">
        <div class="data-nama">${o.aksi === 'simpan' ? 'Simpan' : 'Batalkan'} transaksi #${App.kodePendek(o.trxId)}</div>
        <div class="data-meta"><span>${esc(o.gagal)}</span></div>
        <div class="btn-row" style="margin-top:8px">
          <button class="btn btn-pill btn-sm btn-secondary" data-q="${esc(o.qid)}" onclick="cobaLagiSync(this.dataset.q)">Coba lagi</button>
          <button class="btn btn-pill btn-sm btn-danger" data-q="${esc(o.qid)}" onclick="buangSync(this.dataset.q)">Buang</button>
        </div>
      </div>`).join(''));
  };
  window.cobaLagiSync = async function (qid) { tutupModal(); await Sync.cobaLagi(qid); renderSyncBar(); };
  window.buangSync = function (qid) {
    if (!confirm('Buang antrean ini? Perubahan tersebut TIDAK akan sampai ke database.')) return;
    Sync.buang(qid); tutupModal(); renderSyncBar(); renderRiwayatTransaksi();
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


  App.renderPameran = renderPameran;
  App.sinkronTransaksi = sinkronTransaksi;
  App.renderSyncBar = renderSyncBar;
  App.renderRiwayatTransaksi = renderRiwayatTransaksi;
  App.pasangScanGun = pasangScanGun;
  App.renderDock = renderDock;
  App.tambahDariKode = tambahDariKode;
})(window.App = window.App || {});
