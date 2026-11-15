/* ============================================================
   app/persiapan.js — Sesi 1: checklist persiapan dan daftar
   produk yang dibawa (scan/kode → master → produk_pameran).
   ============================================================ */
(function (App) {
  'use strict';
  const S = App.state;
  const { $, esc, rupiah, toast, showModalBox, tutupModal, butuhEvent, produkEvent } = App;
  const { Store, DB } = window;

  /* ================= SESI 1 — PERSIAPAN ================= */
  function renderPersiapan() {
    if (!App.butuhEvent()) return;
    const ev = Store.getActiveEvent();
    $('pspJudul').textContent = ev.nama;
    $('pspSub').textContent = ev.tanggal + (ev.catatan ? ' · ' + ev.catatan : '');

    renderChecklist();

    // Produk yang dibawa (dari database produk_pameran)
    renderProdukPameran();
  }
  window.renderPersiapan = renderPersiapan;

  /* ---- Checklist: Simpan → status "Persiapan OK"; Tampilkan (modal) & Koreksi ---- */
  function renderChecklist() {
    const cek = Store.getCek(S.evtId);
    const st = Store.getCekStatus(S.evtId);
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
    if (!App.butuhEvent()) return;
    const cek = Store.getCek(S.evtId);
    if (!cek.length) { toast('Checklist masih kosong', 'error'); return; }
    const belum = cek.filter((c) => !c.done).length;
    if (belum && !confirm(belum + ' item belum dicentang. Tetap simpan sebagai "Persiapan OK"?')) return;
    const lama = Store.getCekStatus(S.evtId);
    Store.setCekStatus(S.evtId, {
      tersimpan: true, waktu: new Date().toISOString(),
      oleh: S.user ? (S.user.nama || S.user.email) : '',
      dicentang: cek.length - belum, total: cek.length, belum,
      revisi: lama && lama.waktu ? (lama.revisi || 0) + 1 : 0,
    });
    renderChecklist();
    toast(lama && lama.waktu ? 'Koreksi checklist disimpan' : 'Persiapan OK tersimpan', 'ok');
  };

  window.tampilkanChecklist = function () {
    if (!App.butuhEvent()) return;
    const cek = Store.getCek(S.evtId);
    const st = Store.getCekStatus(S.evtId);
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
    const st = Store.getCekStatus(S.evtId);
    if (st) Store.setCekStatus(S.evtId, Object.assign({}, st, { tersimpan: false }));
    tutupModal();
    renderChecklist();
  };

  window.tambahCek = function () {
    const inp = $('psnCekBaru');
    const teks = (inp.value || '').trim();
    if (!teks) return;
    const cek = Store.getCek(S.evtId);
    cek.push({ teks, done: false });
    Store.setCek(S.evtId, cek);
    inp.value = '';
    renderPersiapan();
  };

  window.toggleCek = function (i) {
    const cek = Store.getCek(S.evtId);
    cek[i].done = !cek[i].done;
    Store.setCek(S.evtId, cek);
    renderPersiapan();
  };

  window.hapusCek = function (i) {
    const cek = Store.getCek(S.evtId);
    cek.splice(i, 1);
    Store.setCek(S.evtId, cek);
    renderPersiapan();
  };

  /* ---- Produk yang dibawa: scan → master_produk → modal → produk_pameran ---- */
  let versiLokalPP = 0;        // naik tiap data lokal berubah; mencegah hasil sinkron lama menimpa data baru
  let syncPPJalan = false;
  let hasilMasterSementara = [];
  let kodeHapusPP = null;
  let produkMaster = null;     // produk master yang sedang dibuka di modal jumlah


  function renderProdukPameran() {
    const produk = App.produkEvent();
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

  // Tarik daftar produk event ini dari database (sumber kebenaran). Gagal/offline → pakai data di perangkat.
  async function syncProdukPameran(diam) {
    const ev = Store.getActiveEvent();
    if (!ev || syncPPJalan) return;
    syncPPJalan = true;
    const versi = versiLokalPP;
    try {
      const list = await DB.getProdukPameran({ event: ev.nama, tgl: ev.tglMulai });
      if (versi === versiLokalPP && ev.id === S.evtId) {
        Store.setProdukPameran(ev.id, list);
        if (document.querySelector('#scr-persiapan.active')) renderProdukPameran();
      }
    } catch (err) {
      console.warn('Sinkron produk pameran gagal:', err.message);
      if (!diam) toast('Memakai data di perangkat — sinkron database gagal: ' + err.message, 'error');
    } finally {
      syncPPJalan = false;
    }
  }

  window.bukaScanProduk = function () {
    if (!App.butuhEvent()) return;
    Scanner.buka({
      judul: 'Scan produk fisik',
      petunjuk: 'Arahkan kamera ke barcode / QR produk. Data ditarik dari master produk.',
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
    if (!App.butuhEvent()) return false;
    toast('Mencari di master produk…');
    let r;
    try { r = await DB.cariMaster({ q: teks, exact: !!hanyaPersis }); }
    catch (err) { tampilkanGalatMaster(err); return true; }
    if (r.exact) { bukaModalJumlah(r.exact); return true; }
    if (r.hasil && r.hasil.length) { tampilkanPilihanMaster(r.hasil, r.total); return true; }
    // Tidak ketemu: tampilkan di modal (bukan toast sekilas) beserta teks yang terbaca, supaya mudah ditelusuri
    showModalBox('Produk tidak ditemukan', `
      <p>${hanyaPersis ? 'Kode yang terbaca' : 'Yang dicari'}: <strong>${esc(String(teks).slice(0, 60))}</strong></p>
      <p class="rekap-note">Tidak ada produk dengan <em>kode</em> / <em>isbn</em> tersebut${hanyaPersis ? '' : ' (atau judul yang mengandung kata itu)'} di <strong>produk POS</strong> maupun <strong>master produk pameran</strong>.
      Periksa kode di aplikasi POS, atau ketik judulnya di kolom pencarian.</p>`,
      '<button class="btn btn-primary btn-block" onclick="tutupModal()">Tutup</button>');
    return true;
  }

  function tampilkanGalatMaster(err) {
    let pesan = esc(err.message || 'Galat tidak diketahui');
    if (err.jaringan) pesan = 'Tidak ada koneksi ke server. Periksa internet lalu coba lagi.';
    else if (/Aksi tidak dikenal/i.test(err.message || '')) {
      pesan = 'Fungsi database belum terpasang. Jalankan <strong>supabase/schema.sql</strong> di SQL Editor Supabase, lalu coba lagi.';
    }
    showModalBox('Gagal membaca master produk', '<p>' + pesan + '</p>',
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
    const ada = App.produkEvent().find((p) => Store.normKode(p.kode) === Store.normKode(m.kode));
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
    if (!App.butuhEvent() || !produkMaster) return;
    const harga = Number($('ppHarga').value);
    const jumlah = Number($('ppJumlah').value);
    if ($('ppHarga').value === '' || !Number.isInteger(harga) || harga < 0) { toast('Harga harus bilangan bulat ≥ 0', 'error'); return; }
    if (!Number.isInteger(jumlah) || jumlah < 1) { toast('Jumlah dibawa minimal 1', 'error'); return; }
    const ev = Store.getActiveEvent();
    const btn = $('ppSimpan');
    btn.disabled = true; btn.textContent = 'Menyimpan…';
    try {
      const r = await DB.simpanProdukPameran({ event: ev.nama, tgl: ev.tglMulai, kode: produkMaster.kode, harga, jumlah });
      Store.upsertProdukPameran(S.evtId, r.produk);
      versiLokalPP++;
      tutupModal();
      renderProdukPameran();
      if (document.querySelector('#scr-penginputan.active')) App.renderPenginputan();
      toast((r.diperbarui ? 'Diperbarui: ' : 'Tersimpan: ') + r.produk.nama.slice(0, 30) + ' × ' + r.produk.jumlah, 'ok');
    } catch (err) {
      toast('Gagal simpan ke database: ' + err.message, 'error');
      btn.disabled = false; btn.textContent = 'Simpan';
    }
  };

  window.ubahProdukPameran = function (kode) {
    const p = App.produkEvent().find((x) => x.kode === kode);
    if (p) bukaModalJumlah({ kode: p.kode, isbn: p.isbn, nama: p.nama, harga: p.harga });
  };

  window.hapusProdukPameran = function (kode) {
    const p = App.produkEvent().find((x) => x.kode === kode);
    if (!p) return;
    const dipakai = Store.getTransaksi(S.evtId).some((t) => !t.deleted && t.items.some((i) => i.kode === kode)) ||
                    Store.getInputan(S.evtId).some((x) => !x.deleted && x.kode === kode);
    if (dipakai) { toast('Tidak bisa dihapus: produk sudah dipakai di transaksi / input', 'error'); return; }
    kodeHapusPP = kode;
    showModalBox('Hapus dari daftar?', `<p>“${esc(p.nama)}” (${esc(p.kode)}) akan dihapus dari database produk pameran.</p>`,
      `<div class="btn-row">
        <button class="btn btn-secondary" onclick="tutupModal()">Batal</button>
        <button class="btn btn-danger" onclick="konfirmasiHapusProduk()">Hapus</button>
      </div>`);
  };

  window.konfirmasiHapusProduk = async function () {
    const ev = Store.getActiveEvent();
    if (!ev || !kodeHapusPP) return;
    try {
      await DB.hapusProdukPameran({ event: ev.nama, tgl: ev.tglMulai, kode: kodeHapusPP });
      Store.hapusProdukPameranLokal(S.evtId, kodeHapusPP);
      versiLokalPP++;
      tutupModal();
      renderProdukPameran();
      toast('Produk dihapus dari daftar', 'ok');
    } catch (err) {
      toast('Gagal menghapus: ' + err.message, 'error');
    }
  };


  App.renderPersiapan = renderPersiapan;
  App.syncProdukPameran = syncProdukPameran;
})(window.App = window.App || {});
