/* ============================================================
   app/penginputan.js — Sesi 3: input manual, rekap stok, dan
   unduhan CSV (rekap & transaksi).
   ============================================================ */
(function (App) {
  'use strict';
  const S = App.state;
  const { $, esc, toast, showModalBox, butuhEvent, produkEvent, renderHome } = App;
  const { Store } = window;

  /* ================= SESI 3 — PENGINPUTAN ================= */
  function renderPenginputan() {
    if (!App.butuhEvent()) return;
    renderFormInput();
    renderDaftarInput();
    renderRekap();
  }
  window.renderPenginputan = renderPenginputan;

  function renderFormInput() {
    const sel = $('piProduk');
    const produk = App.produkEvent();
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
    const p = Store.findProdukPameran(S.evtId, kode);
    const semua = Store.getInputan(S.evtId);
    semua.push({
      id: Store.uid(),
      waktu: new Date().toISOString(),
      kode, nama: p ? p.nama : kode, qty, kategori: kat, catatan: ket, deleted: false,
    });
    Store.setInputan(S.evtId, semua);
    $('piQty').value = '';
    $('piCatatan').value = '';
    renderDaftarInput();
    renderRekap();
    toast('Input tercatat +' + qty + ' pcs', 'ok');
  };

  function renderDaftarInput() {
    const semua = Store.getInputan(S.evtId);
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
    const semua = Store.getInputan(S.evtId);
    const x = semua.find((y) => y.id === id);
    if (!x) return;
    x.deleted = true;
    Store.setInputan(S.evtId, semua);
    renderDaftarInput();
    renderRekap();
  };

  function renderRekap() {
    const trx = Store.getTransaksi(S.evtId).filter((t) => !t.deleted);
    const inputs = Store.getInputan(S.evtId).filter((x) => !x.deleted);
    const keluar = {};
    trx.forEach((t) => t.items.forEach((i) => { keluar[i.kode] = (keluar[i.kode] || 0) + i.qty; }));
    const masuk = {};
    inputs.forEach((x) => { masuk[x.kode] = (masuk[x.kode] || 0) + x.qty; });

    const rows = [['Kode', 'Produk', 'Kategori', 'Stok Awal', 'Terjual', 'Input Manual', 'Sisa Estimasi']];
    // Stok awal = jumlah dibawa (sesi Persiapan, database produk_pameran)
    App.produkEvent().forEach((p) => {
      const aw = Number(p.jumlah || 0), klr = keluar[p.kode] || 0, msk = masuk[p.kode] || 0;
      rows.push([p.kode, p.nama, p.kategori || '', aw, klr, msk, aw - klr + msk]);
    });
    $('piRekapNote').textContent =
      'Sisa estimasi = stok awal − terjual + input manual. Transaksi: ' + trx.length + ', input: ' + inputs.length + '.';
    window._rekapRows = rows;
  }

  window.unduhRekap = function () {
    if (!App.butuhEvent()) return;
    renderRekap();
    const ev = Store.getActiveEvent();
    Store.unduhCSV('rekap-' + ev.nama.replace(/\s+/g, '-').toLowerCase() + '.csv', window._rekapRows);
    toast('CSV rekap diunduh', 'ok');
  };

  window.unduhTransaksiCsv = function () {
    if (!App.butuhEvent()) return;
    const trx = Store.getTransaksi(S.evtId).filter((t) => !t.deleted);
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


  window.tampilkanRekapTable = function () {
    if (!App.butuhEvent()) return;
    renderRekap();
    const rows = window._rekapRows || [];
    const html = '<div style="overflow-x:auto"><table class="rekap-table">' +
      rows.map((r, i) => '<tr>' + r.map((c, j) =>
        (i === 0 ? '<th' : '<td') + (j > 0 ? ' class="num"' : '') + '>' + esc(c) + '</t' + (i === 0 ? 'h' : 'd') + '>').join('') + '</tr>').join('') +
      '</table></div>';
    showModalBox('Tabel Rekap', html);
  };

  window.selesaiEventAktif = function () {
    if (!App.butuhEvent()) return;
    const ev = Store.getActiveEvent();
    Store.updateEvent(ev.id, { selesai: new Date().toISOString() });
    App.renderHome();
    showModalBox('Pameran selesai 🎉', '<p>“' + esc(ev.nama) + '” ditandai selesai. Unduh rekap CSV sebelum menutup bila perlu.</p>');
    toast('Pameran ditandai selesai', 'ok');
  };

  App.renderPenginputan = renderPenginputan;
})(window.App = window.App || {});
