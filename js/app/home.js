/* ============================================================
   app/home.js — Beranda: daftar agenda pameran, buat, buka,
   tandai selesai, dan hapus pameran.
   ============================================================ */
(function (App) {
  'use strict';
  const S = App.state;
  const { $, esc, toast, showModalBox, tutupModal, isAdmin, goScreen } = App;
  const { Store, Sync } = window;

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
            ${App.isAdmin() ? `<button class="btn btn-pill btn-sm btn-danger" onclick="hapusEvent('${e.id}')" aria-label="Hapus pameran">
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
    // simpan rentang terstruktur untuk gerbang sesi & nama database
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
    S.evtId = id;
    const ev = Store.getActiveEvent();
    $('homeEventInfo').textContent = ev ? ev.nama + ' · ' + ev.tanggal : '';
    renderHome();
    goScreen('persiapan');
  };

  window.hapusEvent = function (id) {
    if (!App.isAdmin()) { toast('Hanya Admin yang dapat menghapus pameran', 'error'); return; }
    const ev = Store.getEvents().find((e) => e.id === id);
    if (!ev) return;
    showModalBox('Hapus pameran?', `<p>“${esc(ev.nama)}” beserta seluruh datanya akan dihapus permanen.</p>`,
      `<div class="btn-row">
        <button class="btn btn-secondary" onclick="tutupModal()">Batal</button>
        <button class="btn btn-danger" onclick="konfirmasiHapusEvent('${id}')">Hapus</button>
      </div>`);
  };

  window.konfirmasiHapusEvent = function (id) {
    if (!App.isAdmin()) { tutupModal(); toast('Hanya Admin yang dapat menghapus pameran', 'error'); return; }
    Store.hapusEvent(id);
    try { Sync.buangEvent(id); } catch (e) { console.warn(e); }
    if (S.evtId === id) { S.evtId = null; $('homeEventInfo').textContent = ''; }
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


  App.renderHome = renderHome;
})(window.App = window.App || {});
