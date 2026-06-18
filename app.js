import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

/* ── SUPABASE / STATE ── */
const STORAGE_BUCKET = 'dokumente';
const MAX_FILE_SIZE = 5 * 1024 * 1024;
const LOCAL_STORAGE_KEY = 'immo-dashboard';

function hasSupabasePlaceholder(value) {
  return !value || /DEIN|DEINE|PLACEHOLDER|example\.supabase\.co|anon-public-key/i.test(value);
}

const configuredSupabase = !hasSupabasePlaceholder(SUPABASE_URL) && !hasSupabasePlaceholder(SUPABASE_ANON_KEY);
if (!configuredSupabase) {
  console.warn('Supabase ist noch nicht vollständig konfiguriert. Bitte config.js mit Project URL und anon public key ausfüllen.');
}

const supabase = createClient(
  configuredSupabase ? SUPABASE_URL : 'https://example.supabase.co',
  configuredSupabase ? SUPABASE_ANON_KEY : 'placeholder-anon-key'
);
const DEFAULT_STATE = { mieter: [], zahlungen: {} };
let state = structuredClone(DEFAULT_STATE);
let currentTab = 'uebersicht';
let pendingVertrag = null;
let currentUser = null;
let isBootstrapping = true;

function normalizeState(s) {
  if (!s || typeof s !== 'object') s = structuredClone(DEFAULT_STATE);
  if (!Array.isArray(s.mieter)) s.mieter = [];
  if (!s.zahlungen || typeof s.zahlungen !== 'object') s.zahlungen = {};
  s.unklar = {}; // Alte lokale Hilfsdaten werden nicht mehr cloudgespeichert.
  return s;
}

function setStatus(msg, type = 'info') {
  const el = document.getElementById('auth-status');
  if (!el) return;
  el.textContent = msg || '';
  el.className = 'auth-status ' + type;
  el.style.display = msg ? 'block' : 'none';
}

function showApp(user) {
  currentUser = user;
  document.getElementById('auth-screen').style.display = 'none';
  document.querySelector('.layout').style.display = '';
  const userLabel = document.getElementById('user-label');
  if (userLabel) userLabel.textContent = user.email || 'Angemeldet';
}

function showLogin() {
  currentUser = null;
  state = structuredClone(DEFAULT_STATE);
  document.getElementById('auth-screen').style.display = 'grid';
  document.querySelector('.layout').style.display = 'none';
  const userLabel = document.getElementById('user-label');
  if (userLabel) userLabel.textContent = '';
}

async function requireSupabaseReady() {
  if (!configuredSupabase) {
    const missing = [];
    if (hasSupabasePlaceholder(SUPABASE_URL)) missing.push('Project URL');
    if (hasSupabasePlaceholder(SUPABASE_ANON_KEY)) missing.push('anon public key');
    throw new Error(`Supabase ist fast verbunden. Bitte in config.js noch ${missing.join(' und ')} eintragen.`);
  }
}

async function initAuth() {
  await requireSupabaseReady();
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  if (data.session?.user) await afterLogin(data.session.user);
  else showLogin();
  supabase.auth.onAuthStateChange(async (_event, session) => {
    if (isBootstrapping) return;
    if (session?.user) await afterLogin(session.user);
    else showLogin();
  });
}

async function afterLogin(user) {
  showApp(user);
  setStatus('Daten werden geladen…');
  await loadCloudState();
  await offerLocalMigration();
  renderAll();
  setStatus('');
}

async function loginWithEmail(e) {
  e.preventDefault();
  try {
    await requireSupabaseReady();
    setStatus('Anmeldung läuft…');
    const email = document.getElementById('auth-email').value.trim();
    const password = document.getElementById('auth-password').value;
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
  } catch (err) {
    console.error(err);
    setStatus(err.message || 'Anmeldung fehlgeschlagen.', 'error');
  }
}

async function signUpWithEmail() {
  try {
    await requireSupabaseReady();
    const email = document.getElementById('auth-email').value.trim();
    const password = document.getElementById('auth-password').value;
    if (!email || !password) return setStatus('Bitte E-Mail und Passwort eintragen.', 'error');
    setStatus('Konto wird angelegt…');
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: window.location.origin + window.location.pathname }
    });
    if (error) throw error;
    setStatus('Konto angelegt. Falls E-Mail-Bestätigung aktiv ist: bitte Bestätigungslink öffnen; danach hier anmelden.', 'success');
  } catch (err) {
    console.error(err);
    setStatus(err.message || 'Konto konnte nicht angelegt werden.', 'error');
  }
}

async function resendConfirmationEmail() {
  try {
    await requireSupabaseReady();
    const email = document.getElementById('auth-email').value.trim();
    if (!email) return setStatus('Bitte zuerst die E-Mail-Adresse eintragen.', 'error');
    setStatus('Bestätigungs-E-Mail wird erneut gesendet…');
    const { error } = await supabase.auth.resend({
      type: 'signup',
      email,
      options: { emailRedirectTo: window.location.origin + window.location.pathname }
    });
    if (error) throw error;
    setStatus('Bestätigungs-E-Mail wurde erneut gesendet. Bitte Postfach prüfen.', 'success');
  } catch (err) {
    console.error(err);
    setStatus(err.message || 'Bestätigungs-E-Mail konnte nicht erneut gesendet werden.', 'error');
  }
}

async function logout() {
  await supabase.auth.signOut();
  showLogin();
}

async function loadCloudState() {
  const [{ data: mieter, error: mErr }, { data: zahlungen, error: zErr }] = await Promise.all([
    supabase.from('mieter').select('*').order('created_at', { ascending: true }),
    supabase.from('zahlungen').select('*').order('monat', { ascending: false }),
  ]);
  if (mErr) throw mErr;
  if (zErr) throw zErr;
  state = normalizeState({ mieter: (mieter || []).map(rowToMieter), zahlungen: rowsToZahlungen(zahlungen || []) });
}

function rowToMieter(row) {
  return { id: row.id, name: row.name || '', objekt: row.objekt || '', einheit: row.einheit || '', miete: Number(row.miete || 0), faellig: Number(row.faellig || 1), iban: row.iban || '', vwz: row.vwz || '', vertragName: fileNameFromPath(row.vertrag_path), vertragPath: row.vertrag_path || '' };
}

function rowsToZahlungen(rows) {
  const out = {};
  rows.forEach(row => {
    if (!out[row.monat]) out[row.monat] = {};
    out[row.monat][row.mieter_id] = { id: row.id, bezahlt: Number(row.bezahlt || 0), datum: row.datum || '', notiz: row.notiz || '', belegName: fileNameFromPath(row.beleg_path), belegPath: row.beleg_path || '' };
  });
  return out;
}

function mieterToRow(m) {
  return { id: m.id, user_id: currentUser.id, name: m.name, objekt: m.objekt, einheit: m.einheit || null, miete: m.miete || 0, faellig: m.faellig || 1, iban: m.iban || null, vwz: m.vwz || null, vertrag_path: m.vertragPath || null };
}

function zahlungToRow(mieterId, monat, entry) {
  return { id: entry.id || crypto.randomUUID(), user_id: currentUser.id, mieter_id: mieterId, monat, bezahlt: entry.bezahlt || 0, datum: entry.datum || null, notiz: entry.notiz || null, beleg_path: entry.belegPath || null };
}

async function upsertMieter(m) {
  const { error } = await supabase.from('mieter').upsert(mieterToRow(m), { onConflict: 'id' });
  if (error) throw error;
}
async function upsertZahlung(mieterId, monat, entry) {
  const row = zahlungToRow(mieterId, monat, entry);
  const { data, error } = await supabase.from('zahlungen').upsert(row, { onConflict: 'mieter_id,monat' }).select('id').single();
  if (error) throw error;
  entry.id = data.id;
}
function saveState() { /* Cloud-Speicherung erfolgt direkt in den jeweiligen upsert/delete-Funktionen. */ }
function renderAll() { renderUebersicht(); renderMieter(); renderZahlungen(); renderWarnliste(); updateWarnBadge(); }
function safeFileName(name) { return (name || 'datei').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/-+/g, '-').slice(0, 120); }
function fileNameFromPath(path) { if (!path) return ''; return decodeURIComponent(String(path).split('/').pop() || ''); }
function storagePath(kind, file, { mieterId, monat } = {}) { const folder = kind === 'vertrag' ? `vertraege/${mieterId}` : `belege/${mieterId}/${monat}`; return `${currentUser.id}/${folder}/${Date.now()}-${safeFileName(file.name)}`; }
async function uploadStorageFile(kind, file, meta) {
  if (!file) return '';
  if (file.size > MAX_FILE_SIZE) throw new Error('Datei zu groß (max. 5 MB).');
  const path = storagePath(kind, file, meta);
  const { error } = await supabase.storage.from(STORAGE_BUCKET).upload(path, file, { cacheControl: '3600', upsert: true, contentType: file.type || 'application/octet-stream' });
  if (error) throw error;
  return path;
}
async function openStorageFile(path, title) {
  if (!path) return alert('Keine Datei hinterlegt.');
  const w = window.open('', '_blank');
  try {
    const { data, error } = await supabase.storage.from(STORAGE_BUCKET).createSignedUrl(path, 60 * 10);
    if (error) throw error;
    if (w) w.document.write(`<title>${title || 'Dokument'}</title><iframe src="${data.signedUrl}" style="position:fixed;inset:0;border:0;width:100%;height:100%"></iframe>`);
    else window.open(data.signedUrl, '_blank');
  } catch (err) { if (w) w.close(); console.error(err); alert('Datei konnte nicht geöffnet werden: ' + (err.message || err)); }
}
function dataUrlToFile(dataUrl, name) {
  const [header, base64] = String(dataUrl).split(',');
  const mime = (header.match(/data:(.*?);base64/) || [])[1] || 'application/octet-stream';
  const binary = atob(base64 || '');
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new File([bytes], name || 'import-datei', { type: mime });
}
function isUuid(id) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id || ''); }
async function offerLocalMigration() {
  const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
  if (!raw || localStorage.getItem(`${LOCAL_STORAGE_KEY}-imported-${currentUser.id}`)) return;
  if (!confirm('Es wurden lokale Browser-Daten gefunden. Jetzt einmalig in Supabase importieren?')) return;
  await importLocalStorage(raw);
  localStorage.setItem(`${LOCAL_STORAGE_KEY}-imported-${currentUser.id}`, new Date().toISOString());
  localStorage.removeItem(LOCAL_STORAGE_KEY);
  await loadCloudState();
  alert('Import abgeschlossen. Die lokalen Browser-Daten wurden entfernt; künftig speichert die App in Supabase.');
}
async function importLocalStorage(raw) {
  const local = normalizeState(JSON.parse(raw));
  const idMap = new Map();
  for (const old of local.mieter) {
    const newId = isUuid(old.id) ? old.id : crypto.randomUUID();
    idMap.set(old.id, newId);
    const m = { id: newId, name: old.name || '', objekt: old.objekt || '', einheit: old.einheit || '', miete: Number(old.miete || 0), faellig: Number(old.faellig || 1), iban: old.iban || '', vwz: old.vwz || '', vertragName: old.vertragName || '', vertragPath: '' };
    const oldVertragData = old.vertragData || old.vertragPath;
    if (oldVertragData) { const f = dataUrlToFile(oldVertragData, old.vertragName || 'mietvertrag.pdf'); m.vertragPath = await uploadStorageFile('vertrag', f, { mieterId: newId }); m.vertragName = f.name; }
    await upsertMieter(m);
  }
  for (const [monat, entries] of Object.entries(local.zahlungen || {})) {
    for (const [oldMieterId, oldEntry] of Object.entries(entries || {})) {
      const mieterId = idMap.get(oldMieterId); if (!mieterId) continue;
      const entry = { bezahlt: Number(oldEntry.bezahlt || 0), datum: oldEntry.datum || '', notiz: oldEntry.notiz || '', belegName: oldEntry.belegName || '', belegPath: '' };
      const oldBelegData = oldEntry.belegData || oldEntry.belegPath;
      if (oldBelegData) { const f = dataUrlToFile(oldBelegData, oldEntry.belegName || 'beleg.pdf'); entry.belegPath = await uploadStorageFile('beleg', f, { mieterId, monat }); entry.belegName = f.name; }
      await upsertZahlung(mieterId, monat, entry);
    }
  }
}

/* ── HELPERS ── */
function fmt(n) {
  return new Intl.NumberFormat('de-DE', { minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(Math.round(n)) + ' €';
}
function fmt2(n) {
  return new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n) + ' €';
}

function currentMonthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function monthLabel(key) {
  const [y, m] = key.split('-');
  return new Date(y, m - 1, 1).toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });
}

function generateMonthOptions(n = 12) {
  const months = [];
  const now = new Date();
  for (let i = 0; i < n; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    months.push({ key, label: monthLabel(key) });
  }
  return months;
}

function fillMonatSelect(selectId, defaultKey) {
  const sel = document.getElementById(selectId);
  const months = generateMonthOptions();
  sel.innerHTML = months.map(m =>
    `<option value="${m.key}" ${m.key === defaultKey ? 'selected' : ''}>${m.label}</option>`
  ).join('');
}

function getZahlungenForMonth(monat) {
  return state.zahlungen[monat] || {};
}

function effectiveStatus(m, bezahlt, monat) {
  if (bezahlt >= m.miete && bezahlt > 0) return 'bezahlt';
  if (bezahlt > 0) return 'teilzahlung';
  const [y, mo] = monat.split('-').map(Number);
  const due = new Date(y, mo - 1, m.faellig);
  return new Date() > due ? 'ueberfaellig' : 'offen';
}

function statusBadge(status) {
  switch (status) {
    case 'bezahlt': return '<span class="badge badge-success">Bezahlt</span>';
    case 'teilzahlung': return '<span class="badge badge-warn">Teilzahlung</span>';
    case 'ueberfaellig': return '<span class="badge badge-danger">Überfällig</span>';
    default: return '<span class="badge badge-muted">Offen</span>';
  }
}

function parseDate(s) {
  if (!s) return null;
  s = String(s).trim();
  let m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2,4})$/);
  if (m) { const y = m[3].length === 2 ? '20' + m[3] : m[3]; return new Date(+y, +m[2] - 1, +m[1]); }
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) { const y = m[3].length === 2 ? '20' + m[3] : m[3]; return new Date(+y, +m[2] - 1, +m[1]); }
  const d = new Date(s);
  return isNaN(d) ? null : d;
}

function toISO(s) {
  const d = parseDate(s);
  if (!d) return s || '—';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function faelligISO(monat, tag) {
  const [y, mo] = monat.split('-');
  return `${y}-${mo}-${String(tag).padStart(2, '0')}`;
}

function uniqueObjekte() {
  return [...new Set(state.mieter.map(m => m.objekt).filter(Boolean))].sort();
}

function populateObjektFilter(selectId) {
  const sel = document.getElementById(selectId);
  const cur = sel.value;
  sel.innerHTML = '<option value="">Alle Objekte</option>' +
    uniqueObjekte().map(o => `<option value="${o}">${o}</option>`).join('');
  sel.value = cur;
}

/* ── HEADER / TABS ── */
const TAB_META = {
  uebersicht:   { title: 'Übersicht',    sub: 'Objekte & Mieter im Überblick',  action: null },
  mieter:       { title: 'Mieter',       sub: 'Stammdaten & Verträge',         action: '+ Mieter hinzufügen',  primary: true },
  zahlungen:    { title: 'Zahlungen',    sub: 'Monatliche Zahlungsliste',      action: '+ Zahlung eintragen',  primary: true },
  warnliste:    { title: 'Warnliste',    sub: 'Offene & überfällige Mieten',   action: null },
};

function updateHeader(tab) {
  const meta = TAB_META[tab];
  document.getElementById('page-title').textContent = meta.title;
  document.getElementById('page-subtitle').textContent = meta.sub;
  const btn = document.getElementById('header-action');
  if (meta.action) {
    btn.style.display = '';
    btn.textContent = meta.action;
    btn.className = meta.primary ? 'btn-primary' : 'btn-outline';
  } else {
    btn.style.display = 'none';
  }
}

function headerAction(e) {
  if (e) e.stopPropagation();
  if (currentTab === 'mieter') {
    showContextMenu(e, [
      { label: 'Mieter manuell anlegen', action: () => openMieterDialog() },
      { label: 'Mietvertrag auswählen…', action: () => document.getElementById('vertrag-new-input').click() },
    ]);
  } else if (currentTab === 'zahlungen') {
    addZahlungManual();
  }
}

/* ── INIT ── */
document.addEventListener('DOMContentLoaded', async () => {
  const cur = currentMonthKey();
  fillMonatSelect('monat-select', cur);
  fillMonatSelect('warn-monat-select', cur);
  updateHeader('uebersicht');

  document.addEventListener('click', hideContextMenu);
  window.addEventListener('scroll', hideContextMenu, true);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') hideContextMenu(); });
  document.getElementById('ctx-vertrag-input').addEventListener('change', e => { if (ctxVertragMieterId && e.target.files[0]) uploadVertrag(ctxVertragMieterId, e.target); e.target.value = ''; });
  document.getElementById('vertrag-new-input').addEventListener('change', e => { if (e.target.files[0]) handleVertragFile(e.target.files[0]); e.target.value = ''; });
  document.getElementById('ctx-beleg-input').addEventListener('change', e => { if (ctxBelegTarget && e.target.files[0]) uploadBeleg(ctxBelegTarget.mieterId, ctxBelegTarget.monat, e.target); e.target.value = ''; });

  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
      currentTab = btn.dataset.tab;
      document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('tab-' + currentTab).classList.add('active');
      updateHeader(currentTab);
      if (currentTab === 'uebersicht') renderUebersicht();
      if (currentTab === 'mieter') renderMieter();
      if (currentTab === 'zahlungen') renderZahlungen();
      if (currentTab === 'warnliste') renderWarnliste();
    });
  });

  try { await initAuth(); }
  catch (err) { console.error(err); showLogin(); setStatus(err.message || 'Supabase konnte nicht initialisiert werden.', 'error'); }
  finally { isBootstrapping = false; }
});

/* ── MIETER (STAMMDATEN) ── */
function renderMieter() {
  populateObjektFilter('m-objekt-filter');
  const search = (document.getElementById('m-search').value || '').toLowerCase();
  const objektFilter = document.getElementById('m-objekt-filter').value;

  const tbody = document.getElementById('mieter-tbody');
  const empty = document.getElementById('mieter-empty');
  const wrap = document.querySelector('#tab-mieter .table-wrap');

  const list = state.mieter.filter(m => {
    if (objektFilter && m.objekt !== objektFilter) return false;
    if (search && !(`${m.name} ${m.objekt} ${m.einheit || ''}`.toLowerCase().includes(search))) return false;
    return true;
  });

  if (!state.mieter.length) {
    tbody.innerHTML = '';
    empty.textContent = 'Noch keine Mieter angelegt.';
    empty.style.display = 'block';
    wrap.style.display = 'none';
    return;
  }
  wrap.style.display = 'block';
  empty.style.display = list.length ? 'none' : 'block';
  if (!list.length) empty.textContent = 'Keine Treffer für die aktuelle Filterung.';

  tbody.innerHTML = list.map(m => `
    <tr oncontextmenu="mieterContextMenu(event, '${m.id}')">
      <td><div class="row-name">${m.name}</div></td>
      <td>${m.objekt}${m.einheit ? ' · ' + m.einheit : ''}</td>
      <td>${m.faellig}. des Monats</td>
      <td class="text-muted">${m.iban ? formatIBAN(m.iban) : '—'}</td>
      <td class="text-muted">${m.vertragPath ? 'hinterlegt' : '—'}</td>
    </tr>
  `).join('');
}

function resetMieterFilter() {
  document.getElementById('m-search').value = '';
  document.getElementById('m-objekt-filter').value = '';
  renderMieter();
}

function formatIBAN(iban) {
  return iban.replace(/\s/g, '').replace(/(.{4})/g, '$1 ').trim();
}

function openMieterDialog(id) {
  const d = document.getElementById('mieter-dialog');
  document.getElementById('overlay').classList.add('open');
  document.getElementById('m-vertrag').value = '';
  document.getElementById('vertrag-attached').style.display = 'none';
  if (id) {
    const m = state.mieter.find(x => x.id === id);
    document.getElementById('mieter-dialog-title').textContent = 'Mieter bearbeiten';
    document.getElementById('mieter-id').value = m.id;
    document.getElementById('m-name').value = m.name;
    document.getElementById('m-objekt').value = m.objekt;
    document.getElementById('m-einheit').value = m.einheit || '';
    document.getElementById('m-miete').value = m.miete;
    document.getElementById('m-faellig').value = m.faellig;
    document.getElementById('m-iban').value = m.iban || '';
    document.getElementById('m-vwz').value = m.vwz || '';
  } else {
    document.getElementById('mieter-dialog-title').textContent = 'Mieter hinzufügen';
    document.getElementById('mieter-id').value = '';
    document.getElementById('mieter-form').reset();
  }
  d.style.display = 'block';
}

async function saveMieter(e) {
  e.preventDefault();
  try {
    const id = document.getElementById('mieter-id').value;
    const existing = id ? state.mieter.find(x => x.id === id) : null;
    const m = {
      id: id || crypto.randomUUID(),
      name: document.getElementById('m-name').value.trim(),
      objekt: document.getElementById('m-objekt').value.trim(),
      einheit: document.getElementById('m-einheit').value.trim(),
      miete: parseFloat(document.getElementById('m-miete').value),
      faellig: parseInt(document.getElementById('m-faellig').value),
      iban: document.getElementById('m-iban').value.replace(/\s/g, '').toUpperCase(),
      vwz: document.getElementById('m-vwz').value.trim(),
      vertragName: existing ? existing.vertragName : '',
      vertragPath: existing ? existing.vertragPath : '',
    };
    const file = document.getElementById('m-vertrag').files[0] || (pendingVertrag && pendingVertrag.file);
    if (file) { m.vertragPath = await uploadStorageFile('vertrag', file, { mieterId: m.id }); m.vertragName = file.name; }
    if (id) state.mieter[state.mieter.findIndex(x => x.id === id)] = m; else state.mieter.push(m);
    await upsertMieter(m);
    closeAllDialogs(); renderMieter(); renderZahlungen(); renderUebersicht(); updateWarnBadge();
  } catch (err) { console.error(err); alert('Mieter konnte nicht gespeichert werden: ' + (err.message || err)); }
}

async function deleteMieter(id) {
  if (!confirm('Mieter wirklich löschen?')) return;
  try {
    const { error } = await supabase.from('mieter').delete().eq('id', id);
    if (error) throw error;
    state.mieter = state.mieter.filter(m => m.id !== id);
    Object.keys(state.zahlungen).forEach(monat => { delete state.zahlungen[monat][id]; });
    renderMieter(); renderZahlungen(); renderUebersicht(); updateWarnBadge();
  } catch (err) { console.error(err); alert('Mieter konnte nicht gelöscht werden: ' + (err.message || err)); }
}

/* ── MIETVERTRAG / BELEG ── */
async function uploadVertrag(mieterId, input) {
  const file = input.files[0]; if (!file) return;
  try {
    const m = state.mieter.find(x => x.id === mieterId); if (!m) return;
    m.vertragPath = await uploadStorageFile('vertrag', file, { mieterId }); m.vertragName = file.name;
    await upsertMieter(m); renderMieter(); renderZahlungen(); renderUebersicht();
  } catch (err) { console.error(err); alert('Mietvertrag konnte nicht hochgeladen werden: ' + (err.message || err)); }
}

async function pruefenVertrag(mieterId) {
  const m = state.mieter.find(x => x.id === mieterId);
  if (m && m.vertragPath) await openStorageFile(m.vertragPath, m.vertragName || 'Mietvertrag');
  else alert('Kein Mietvertrag hinterlegt. Bitte in den Stammdaten (Mieter bearbeiten) hochladen.');
}

/* ── ZAHLUNGEN ── */
function onMonatChange() {
  renderZahlungen();
}

function renderZahlungen() {
  const monat = document.getElementById('monat-select').value;
  const z = getZahlungenForMonth(monat);
  populateObjektFilter('z-objekt-filter');

  const search = (document.getElementById('z-search').value || '').toLowerCase();
  const statusFilter = document.getElementById('z-status-filter').value;
  const objektFilter = document.getElementById('z-objekt-filter').value;

  const tbody = document.getElementById('zahlungen-tbody');
  const wrap = document.querySelector('#tab-zahlungen .table-wrap');
  const empty = document.getElementById('zahlungen-empty');

  if (!state.mieter.length) {
    tbody.innerHTML = '';
    wrap.style.display = 'none';
    empty.textContent = 'Bitte zuerst Mieter anlegen.';
    empty.style.display = 'block';
    document.getElementById('zahlungen-alert').style.display = 'none';
    return;
  }

  // Kennzahlen nur für die Warnzeile
  let offenTotal = 0, offeneMieter = 0, ueberfaelligCount = 0;
  state.mieter.forEach(m => {
    const bezahlt = (z[m.id] || {}).bezahlt || 0;
    const st = effectiveStatus(m, bezahlt, monat);
    offenTotal += Math.max(0, m.miete - bezahlt);
    if (st !== 'bezahlt') offeneMieter++;
    if (st === 'ueberfaellig') ueberfaelligCount++;
  });

  const alert = document.getElementById('zahlungen-alert');
  if (offeneMieter > 0 || ueberfaelligCount > 0) {
    alert.style.display = 'block';
    alert.textContent = `${ueberfaelligCount} Mieter überfällig · ${offeneMieter} offene Mieter · ${fmt(offenTotal)} ausstehend`;
  } else {
    alert.style.display = 'none';
  }

  // Tabelle (gefiltert)
  const list = state.mieter.filter(m => {
    const bezahlt = (z[m.id] || {}).bezahlt || 0;
    const st = effectiveStatus(m, bezahlt, monat);
    if (statusFilter && st !== statusFilter) return false;
    if (objektFilter && m.objekt !== objektFilter) return false;
    if (search && !(`${m.name} ${m.objekt} ${m.einheit || ''}`.toLowerCase().includes(search))) return false;
    return true;
  });

  wrap.style.display = list.length ? 'block' : 'none';
  empty.style.display = list.length ? 'none' : 'block';
  if (!list.length) empty.textContent = 'Keine Mieter für die aktuelle Filterung.';

  tbody.innerHTML = list.map(m => {
    const eintrag = z[m.id] || { bezahlt: 0, datum: '', belegName: '' };
    const bezahlt = eintrag.bezahlt || 0;
    const offen = Math.max(0, m.miete - bezahlt);
    const st = effectiveStatus(m, bezahlt, monat);
    return `
      <tr oncontextmenu="zahlungContextMenu(event, '${m.id}', '${monat}')">
        <td><div class="row-name">${m.name}</div></td>
        <td>${m.objekt}${m.einheit ? ' · ' + m.einheit : ''}</td>
        <td class="text-right">${fmt(m.miete)}</td>
        <td class="text-muted">${faelligISO(monat, m.faellig)}</td>
        <td class="text-muted">${bezahlt > 0 && eintrag.datum ? toISO(eintrag.datum) : '—'}</td>
        <td class="text-right">${offen > 0 ? `<span style="color:var(--danger)">${fmt(offen)}</span>` : `<span style="color:var(--success)">0 €</span>`}</td>
        <td>${statusBadge(st)}</td>
      </tr>
    `;
  }).join('');
}

function resetZahlungenFilter() {
  document.getElementById('z-search').value = '';
  document.getElementById('z-status-filter').value = '';
  document.getElementById('z-objekt-filter').value = '';
  renderZahlungen();
}

function openZahlungDialog(mieterId, monat) {
  const curMonat = monat || document.getElementById('monat-select').value;
  const sel = document.getElementById('z-mieter-select');
  sel.innerHTML = state.mieter.map(m =>
    `<option value="${m.id}" ${m.id === mieterId ? 'selected' : ''}>${m.name}</option>`
  ).join('');
  document.getElementById('z-monat').value = curMonat;
  const ex = (getZahlungenForMonth(curMonat)[mieterId]) || {};
  document.getElementById('z-datum').value = ex.datum ? toISO(ex.datum) : new Date().toISOString().split('T')[0];
  document.getElementById('z-notiz').value = ex.notiz || '';
  document.getElementById('z-beleg').value = '';
  const note = document.getElementById('z-beleg-note');
  if (ex.belegName) { note.textContent = '📎 Beleg hinterlegt: ' + ex.belegName; note.style.display = 'block'; }
  else { note.style.display = 'none'; }
  prefillZahlung();
  document.getElementById('overlay').classList.add('open');
  document.getElementById('zahlung-dialog').style.display = 'block';
}

function addZahlungManual() {
  if (!state.mieter.length) return alert('Bitte zuerst Mieter anlegen.');
  openZahlungDialog(state.mieter[0].id, document.getElementById('monat-select').value);
}

function prefillZahlung() {
  const id = document.getElementById('z-mieter-select').value;
  const m = state.mieter.find(x => x.id === id);
  const monat = document.getElementById('z-monat').value;
  const ex = (getZahlungenForMonth(monat)[id]) || {};
  document.getElementById('z-betrag').value = ex.bezahlt != null && ex.bezahlt > 0 ? ex.bezahlt : (m ? m.miete : '');
}

async function saveZahlung(e) {
  e.preventDefault();
  try {
    const mieterId = document.getElementById('z-mieter-select').value;
    const monat = document.getElementById('z-monat').value || document.getElementById('monat-select').value;
    if (!state.zahlungen[monat]) state.zahlungen[monat] = {};
    const ex = state.zahlungen[monat][mieterId] || {};
    const entry = { id: ex.id, bezahlt: parseFloat(document.getElementById('z-betrag').value), datum: document.getElementById('z-datum').value, notiz: document.getElementById('z-notiz').value, belegName: ex.belegName || '', belegPath: ex.belegPath || '' };
    const file = document.getElementById('z-beleg').files[0];
    if (file) { entry.belegPath = await uploadStorageFile('beleg', file, { mieterId, monat }); entry.belegName = file.name; }
    state.zahlungen[monat][mieterId] = entry;
    await upsertZahlung(mieterId, monat, entry);
    closeAllDialogs(); renderZahlungen(); renderWarnliste(); renderUebersicht(); updateWarnBadge();
  } catch (err) { console.error(err); alert('Zahlung konnte nicht gespeichert werden: ' + (err.message || err)); }
}

/* Beleg pro Zahlung */
let ctxBelegTarget = null;

function triggerBelegUpload(mieterId, monat) {
  ctxBelegTarget = { mieterId, monat };
  document.getElementById('ctx-beleg-input').click();
}

async function uploadBeleg(mieterId, monat, input) {
  const file = input.files[0]; if (!file) return;
  try {
    if (!state.zahlungen[monat]) state.zahlungen[monat] = {};
    const ex = state.zahlungen[monat][mieterId] || { bezahlt: 0, datum: '', notiz: '' };
    ex.belegPath = await uploadStorageFile('beleg', file, { mieterId, monat }); ex.belegName = file.name;
    state.zahlungen[monat][mieterId] = ex;
    await upsertZahlung(mieterId, monat, ex); renderZahlungen();
  } catch (err) { console.error(err); alert('Beleg konnte nicht hochgeladen werden: ' + (err.message || err)); }
}

async function openBeleg(mieterId, monat) {
  const ex = (getZahlungenForMonth(monat)[mieterId]) || {};
  if (ex.belegPath) await openStorageFile(ex.belegPath, ex.belegName || 'Beleg'); else alert('Kein Beleg hinterlegt.');
}

async function deleteZahlung(mieterId, monat) {
  if (!confirm('Zahlung löschen?')) return;
  try {
    const { error } = await supabase.from('zahlungen').delete().eq('mieter_id', mieterId).eq('monat', monat);
    if (error) throw error;
    if (state.zahlungen[monat]) delete state.zahlungen[monat][mieterId];
    renderZahlungen(); renderWarnliste(); renderUebersicht(); updateWarnBadge();
  } catch (err) { console.error(err); alert('Zahlung konnte nicht gelöscht werden: ' + (err.message || err)); }
}

/* ── WARNLISTE / AUSWERTUNG ── */
function renderWarnliste() {
  const monat = document.getElementById('warn-monat-select').value;
  const z = getZahlungenForMonth(monat);
  const [y, mo] = monat.split('-').map(Number);
  const today = new Date();

  const probleme = state.mieter
    .map(m => {
      const eintrag = z[m.id] || { bezahlt: 0 };
      const bezahlt = eintrag.bezahlt || 0;
      const st = effectiveStatus(m, bezahlt, monat);
      if (st === 'bezahlt') return null;
      const faelligDate = new Date(y, mo - 1, m.faellig);
      const diffDays = Math.floor((today - faelligDate) / 86400000);
      return { m, bezahlt, offen: m.miete - bezahlt, status: st, diffDays, faelligDate };
    })
    .filter(Boolean)
    .sort((a, b) => b.diffDays - a.diffDays);

  const empty = document.getElementById('warn-empty');
  const cards = document.getElementById('warn-cards');
  const stats = document.getElementById('warn-stats');
  const unklarCount = ((state.unklar && state.unklar[monat]) || []).length;

  if (!probleme.length) {
    empty.style.display = 'block';
    cards.innerHTML = '';
    stats.innerHTML = unklarCount
      ? `<div class="kpi accent"><div class="label">Unklare Zahlungen</div><div class="value">${unklarCount}</div></div>`
      : '';
    renderUnklar(monat);
    return;
  }
  empty.style.display = 'none';

  const totalOffen = probleme.reduce((s, p) => s + p.offen, 0);
  const ueberfaellig = probleme.filter(p => p.status === 'ueberfaellig').length;
  const teilzahlung = probleme.filter(p => p.status === 'teilzahlung').length;

  stats.innerHTML = `
    <div class="kpi red"><div class="label">Gesamtoffen</div><div class="value">${fmt(totalOffen)}</div></div>
    <div class="kpi red"><div class="label">Überfällig</div><div class="value">${ueberfaellig} Mieter</div></div>
    <div class="kpi warn"><div class="label">Teilzahlungen</div><div class="value">${teilzahlung} Mieter</div></div>
    ${unklarCount ? `<div class="kpi accent"><div class="label">Unklare Zahlungen</div><div class="value">${unklarCount}</div></div>` : ''}
  `;

  cards.innerHTML = probleme.map(p => `
    <div class="warn-card ${p.status === 'teilzahlung' ? 'partial' : ''}">
      <div class="warn-card-header">
        <div>
          <h3>${p.m.name}</h3>
          <div class="sub">${p.m.objekt}${p.m.einheit ? ' · ' + p.m.einheit : ''}</div>
        </div>
        <div style="text-align:right">
          ${statusBadge(p.status)}
          <div class="amount">${fmt2(p.offen)} offen</div>
        </div>
      </div>
      <div style="display:flex; gap:2rem; font-size:.78rem; color:var(--text-muted); margin-top:.25rem; flex-wrap:wrap">
        <span>Soll: ${fmt2(p.m.miete)}</span>
        ${p.bezahlt > 0 ? `<span>Gezahlt: ${fmt2(p.bezahlt)}</span>` : ''}
        <span>${p.diffDays > 0 ? `Seit ${p.diffDays} Tagen überfällig` : `Fällig am ${p.faelligDate.toLocaleDateString('de-DE')}`}</span>
      </div>
    </div>
  `).join('');

  renderUnklar(monat);
}

function renderUnklar(monat) {
  const list = (state.unklar && state.unklar[monat]) || [];
  const section = document.getElementById('unklar-section');
  const cards = document.getElementById('unklar-cards');
  if (!list.length) {
    section.style.display = 'none';
    cards.innerHTML = '';
    return;
  }
  section.style.display = 'block';
  cards.innerHTML = list.map((u, i) => `
    <div class="warn-card">
      <div class="warn-card-header">
        <div>
          <h3>${u.name || 'Unbekannter Absender'}</h3>
          <div class="sub">${u.vwz || '—'}${u.datum ? ' · ' + toISO(u.datum) : ''}</div>
        </div>
        <div class="amount" style="color:var(--accent)">${fmt2(u.betrag)}</div>
      </div>
      <div style="display:flex; gap:.5rem; align-items:center; margin-top:.5rem; flex-wrap:wrap">
        <select class="match-select" id="unklar-${i}">
          <option value="">— Mieter wählen —</option>
          ${state.mieter.map(m => `<option value="${m.id}" ${u.vorschlagId === m.id ? 'selected' : ''}>${m.name}</option>`).join('')}
        </select>
        <button class="btn-primary" onclick="assignUnklar('${monat}', ${i})">Zuordnen</button>
        <button class="btn-ghost" onclick="dismissUnklar('${monat}', ${i})">Verwerfen</button>
      </div>
    </div>
  `).join('');
}

function assignUnklar(monat, i) {
  const sel = document.getElementById(`unklar-${i}`);
  const mieterId = sel && sel.value;
  if (!mieterId) return alert('Bitte einen Mieter auswählen.');
  const u = state.unklar[monat][i];
  if (!state.zahlungen[monat]) state.zahlungen[monat] = {};
  const ex = state.zahlungen[monat][mieterId] || { bezahlt: 0 };
  state.zahlungen[monat][mieterId] = {
    bezahlt: (ex.bezahlt || 0) + u.betrag,
    datum: u.datum,
    notiz: 'Manuell zugeordnet: ' + (u.vwz || ''),
    belegName: ex.belegName || '',
    belegPath: ex.belegPath || '',
  };
  state.unklar[monat].splice(i, 1);
  saveState();
  updateWarnBadge();
  renderZahlungen();
  renderWarnliste();
}

function dismissUnklar(monat, i) {
  if (!confirm('Diese Zahlung verwerfen?')) return;
  state.unklar[monat].splice(i, 1);
  saveState();
  updateWarnBadge();
  renderWarnliste();
}

function updateWarnBadge() {
  const monat = currentMonthKey();
  const z = getZahlungenForMonth(monat);
  const overdue = state.mieter.filter(m => {
    const bezahlt = (z[m.id] || {}).bezahlt || 0;
    return effectiveStatus(m, bezahlt, monat) === 'ueberfaellig';
  }).length;
  const unklar = ((state.unklar && state.unklar[monat]) || []).length;
  const count = overdue + unklar;
  const badge = document.getElementById('warn-badge');
  badge.textContent = count > 0 ? count : '';
  badge.style.display = count > 0 ? 'inline' : 'none';
}

/* ── ÜBERSICHT (ohne Geldbeträge) ── */
function renderUebersicht() {
  const kpis = document.getElementById('ue-kpis');
  const objektList = document.getElementById('ue-objekt-list');
  const mieterList = document.getElementById('ue-mieter-list');

  if (!state.mieter.length) {
    kpis.innerHTML = '';
    objektList.innerHTML = '<p class="mini-empty">Noch keine Objekte – lege Mieter unter „Mieter" an.</p>';
    mieterList.innerHTML = '<p class="mini-empty">Noch keine Mieter angelegt.</p>';
    return;
  }

  const mieterCount = new Set(state.mieter.map(m => m.name.toLowerCase())).size;
  const objekte = [...new Set(state.mieter.map(m => m.objekt).filter(Boolean))];

  const monat = currentMonthKey();
  const z = getZahlungenForMonth(monat);
  const ausstehend = state.mieter.filter(m => {
    const bezahlt = (z[m.id] || {}).bezahlt || 0;
    return effectiveStatus(m, bezahlt, monat) !== 'bezahlt';
  }).length;

  kpis.innerHTML = `
    <div class="kpi"><div class="label">Mieter</div><div class="value">${mieterCount}</div></div>
    <div class="kpi"><div class="label">Objekte</div><div class="value">${objekte.length}</div></div>
    <div class="kpi ${ausstehend > 0 ? 'red' : 'green'}"><div class="label">Ausstehende Zahlungen</div><div class="value">${ausstehend}</div></div>
  `;

  objektList.innerHTML = objekte.map(o => {
    const count = state.mieter.filter(m => m.objekt === o).length;
    return `
      <div class="mini-row">
        <div><div class="mini-main">${o}</div></div>
        <div class="mini-right"><div class="mini-sub">${count} Mieter</div></div>
      </div>`;
  }).join('');

  mieterList.innerHTML = state.mieter.map(m => `
    <div class="mini-row">
      <div>
        <div class="mini-main">${m.name}</div>
        <div class="mini-sub">${m.objekt}${m.einheit ? ' · ' + m.einheit : ''}</div>
      </div>
      <div class="mini-right">${m.vertragPath ? '<span class="badge badge-success">Vertrag</span>' : '<span class="badge badge-muted">kein Vertrag</span>'}</div>
    </div>
  `).join('');
}

/* ── KONTEXTMENÜ (Rechtsklick auf Tabellenzeilen) ── */
let ctxVertragMieterId = null;

function showContextMenu(e, items) {
  e.preventDefault();
  const menu = document.getElementById('context-menu');
  menu.innerHTML = '';
  items.forEach(it => {
    if (it === 'sep') {
      const d = document.createElement('div');
      d.className = 'sep';
      menu.appendChild(d);
      return;
    }
    const b = document.createElement('button');
    b.textContent = it.label;
    if (it.danger) b.classList.add('danger');
    b.addEventListener('click', () => { hideContextMenu(); it.action(); });
    menu.appendChild(b);
  });
  menu.style.display = 'block';
  const r = menu.getBoundingClientRect();
  let x = e.clientX, y = e.clientY;
  if (x + r.width > innerWidth - 8) x = innerWidth - r.width - 8;
  if (y + r.height > innerHeight - 8) y = innerHeight - r.height - 8;
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
}

function hideContextMenu() {
  document.getElementById('context-menu').style.display = 'none';
}

function triggerVertragUpload(mieterId) {
  ctxVertragMieterId = mieterId;
  document.getElementById('ctx-vertrag-input').click();
}

function mieterContextMenu(e, id) {
  const m = state.mieter.find(x => x.id === id);
  if (!m) return;
  const items = [
    { label: 'Bearbeiten', action: () => openMieterDialog(id) },
  ];
  if (m.vertragPath) items.push({ label: 'Mietvertrag öffnen', action: () => pruefenVertrag(id) });
  items.push({ label: m.vertragPath ? 'Mietvertrag ersetzen…' : 'Mietvertrag hochladen…', action: () => triggerVertragUpload(id) });
  items.push('sep');
  items.push({ label: 'Mieter löschen', danger: true, action: () => deleteMieter(id) });
  showContextMenu(e, items);
}

function zahlungContextMenu(e, mieterId, monat) {
  const m = state.mieter.find(x => x.id === mieterId);
  if (!m) return;
  const eintrag = (getZahlungenForMonth(monat)[mieterId]) || {};
  const bezahlt = eintrag.bezahlt || 0;
  const items = [
    { label: 'Zahlung eintragen', action: () => openZahlungDialog(mieterId, monat) },
  ];
  if (bezahlt > 0) items.push({ label: 'Zahlung löschen', danger: true, action: () => deleteZahlung(mieterId, monat) });
  items.push('sep');
  if (eintrag.belegPath) items.push({ label: 'Beleg öffnen', action: () => openBeleg(mieterId, monat) });
  items.push({ label: eintrag.belegPath ? 'Beleg ersetzen…' : 'Beleg auswählen…', action: () => triggerBelegUpload(mieterId, monat) });
  items.push('sep');
  items.push({ label: 'Mieter bearbeiten', action: () => openMieterDialog(mieterId) });
  if (m.vertragPath) items.push({ label: 'Mietvertrag öffnen', action: () => pruefenVertrag(mieterId) });
  showContextMenu(e, items);
}

/* ── DIALOGS ── */
function closeAllDialogs() {
  document.getElementById('overlay').classList.remove('open');
  document.querySelectorAll('dialog').forEach(d => d.style.display = 'none');
  pendingVertrag = null;
  document.getElementById('vertrag-attached').style.display = 'none';
}

/* ── MIETVERTRAG: AUTO-AUSLESEN ── */
let statusTimer = null;
function showStatus(msg, ms) {
  const el = document.getElementById('vertrag-status');
  el.textContent = msg;
  el.style.display = 'block';
  if (statusTimer) clearTimeout(statusTimer);
  if (ms) statusTimer = setTimeout(() => { el.style.display = 'none'; }, ms);
}

function readAsDataURL(file) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.onerror = rej;
    fr.readAsDataURL(file);
  });
}
function readAsArrayBuffer(file) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.onerror = rej;
    fr.readAsArrayBuffer(file);
  });
}

function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = res;
    s.onerror = () => rej(new Error('Konnte nicht laden: ' + src));
    document.head.appendChild(s);
  });
}

let pdfReady = null;
function loadPdfJs() {
  if (pdfReady) return pdfReady;
  pdfReady = loadScript('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js')
    .then(() => { pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'; });
  return pdfReady;
}
let tessReady = null;
function loadTesseract() {
  if (tessReady) return tessReady;
  tessReady = loadScript('https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js');
  return tessReady;
}

async function extractPdfText(arrayBuffer) {
  await loadPdfJs();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  let text = '';
  const pages = Math.min(pdf.numPages, 8);
  for (let i = 1; i <= pages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map(it => it.str).join(' ') + '\n';
  }
  return text;
}

async function ocrImage(file) {
  await loadTesseract();
  const { data } = await Tesseract.recognize(file, 'deu');
  return data.text || '';
}

async function handleVertragFile(file) {
  if (!file) return;
  if (file.size > MAX_FILE_SIZE) { alert('Datei zu groß (max. 5 MB).'); return; }
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  const isImg = /^image\//.test(file.type) || /\.(png|jpe?g|webp|gif|bmp)$/i.test(file.name);

  showStatus('📄 Mietvertrag wird gelesen…');
  let text = '';
  try {
    if (isPdf) {
      const buf = await readAsArrayBuffer(file);
      text = await extractPdfText(buf);
      if (text.replace(/\s/g, '').length < 25) {
        showStatus('⚠︎ Kein Text im PDF gefunden (vermutlich gescannt) – bitte Felder ergänzen.', 5000);
      }
    } else if (isImg) {
      showStatus('🔍 Texterkennung (OCR) läuft… das kann einige Sekunden dauern.');
      text = await ocrImage(file);
    } else {
      showStatus('⚠︎ Format nicht unterstützt – bitte PDF oder Bild verwenden.', 4000);
    }
  } catch (err) {
    console.error(err);
    showStatus('⚠︎ Automatisches Auslesen nicht möglich (evtl. offline) – bitte Felder manuell ausfüllen.', 5000);
  }

  const parsed = text ? parseVertragText(text) : {};
  pendingVertrag = { name: file.name, file };

  openMieterDialog();
  applyParsedToDialog(parsed);
  if (pendingVertrag) showVertragAttached(file.name);

  const found = Object.values(parsed).filter(v => v !== '' && v != null).length;
  if (found > 0) showStatus(`✓ ${found} Feld(er) automatisch erkannt – bitte prüfen & speichern.`, 5000);
  else if (text) showStatus('Keine Felder sicher erkannt – bitte manuell ausfüllen.', 4000);
}

function applyParsedToDialog(p) {
  const setIf = (id, val) => {
    const el = document.getElementById(id);
    if (val != null && val !== '' && !el.value) el.value = val;
  };
  setIf('m-name', p.name);
  setIf('m-objekt', p.objekt);
  setIf('m-einheit', p.einheit);
  if (p.miete) setIf('m-miete', p.miete);
  if (p.faellig) setIf('m-faellig', p.faellig);
  setIf('m-iban', p.iban ? formatIBAN(p.iban) : '');
  setIf('m-vwz', p.vwz);
}

function showVertragAttached(name) {
  const el = document.getElementById('vertrag-attached');
  el.textContent = '📎 Mietvertrag wird angehängt: ' + name;
  el.style.display = 'block';
}

/* Heuristische Feld-Extraktion aus deutschem Mietvertragstext */
function parseGermanAmount(s) {
  s = s.replace(/€|eur|euro/gi, '').replace(/\s/g, '').trim();
  if (/,\d{2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.');
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

function amountNear(text, kw) {
  const i = text.toLowerCase().indexOf(kw);
  if (i < 0) return null;
  const win = text.slice(i, i + 90);
  const m = win.match(/(\d{1,3}(?:[.\s]\d{3})*(?:,\d{2})?|\d+,\d{2}|\d+)\s*(?:€|EUR|Euro)/i);
  return m ? parseGermanAmount(m[0]) : null;
}

function parseVertragText(text) {
  const t = (text || '').replace(/ /g, ' ');
  const res = {};

  // IBAN (DE + 20 Ziffern, mit/ohne Leerzeichen)
  const ibanRaw = (t.match(/DE(?:\s?\d){20}/i) || [])[0];
  if (ibanRaw) res.iban = ibanRaw.replace(/\s/g, '').toUpperCase();

  // Miete (Priorität: Gesamt/Warm > Kalt/Grund > Miete)
  const miete = amountNear(t, 'gesamtmiete') || amountNear(t, 'warmmiete') || amountNear(t, 'bruttomiete')
    || amountNear(t, 'monatliche miete') || amountNear(t, 'monatsmiete')
    || amountNear(t, 'kaltmiete') || amountNear(t, 'grundmiete') || amountNear(t, 'nettomiete')
    || amountNear(t, 'miete');
  if (miete) res.miete = Math.round(miete * 100) / 100;

  // Fälligkeit
  const wmap = { ersten: 1, zweiten: 2, dritten: 3, vierten: 4, fünften: 5 };
  let fm = t.match(/(?:bis\s+zum|spätestens\s+am|am|zum)\s+(\d{1,2})\.?\s*(?:Werktag|Kalendertag|des\s+Monats|eines\s+Monats)/i);
  if (fm) res.faellig = +fm[1];
  else { fm = t.match(/(ersten|zweiten|dritten|vierten|fünften)\s+Werktag/i); if (fm) res.faellig = wmap[fm[1].toLowerCase()]; }
  if (res.faellig && (res.faellig < 1 || res.faellig > 28)) delete res.faellig;

  // Name (Mieter)
  let nm = t.match(/Mieter(?:in)?\s*[:\-]?\s*(?:Herrn?|Frau)?\s*([A-ZÄÖÜ][a-zäöüß\-]+(?:\s+[A-ZÄÖÜ][a-zäöüß\-]+){1,2})/);
  if (!nm) nm = t.match(/und\s+(?:Herrn?|Frau)\s+([A-ZÄÖÜ][a-zäöüß\-]+(?:\s+[A-ZÄÖÜ][a-zäöüß\-]+){1,2})/);
  if (nm) res.name = nm[1].replace(/\s+/g, ' ').trim();

  // Objekt / Adresse
  const am = t.match(/([A-ZÄÖÜ][a-zäöüß.\-]*(?:straße|strasse|str\.|weg|allee|platz|gasse|ring|damm|ufer|chaussee)\s*\d+\s*[a-zA-Z]?)(?:[,\s]+(\d{5})\s+([A-ZÄÖÜ][a-zäöüß.\- ]+?))?(?=[,.\n]|$)/i);
  if (am) {
    let o = am[1].trim();
    if (am[2] && am[3]) o += ', ' + am[2] + ' ' + am[3].trim();
    res.objekt = o.replace(/\s+/g, ' ');
  }

  // Einheit (Etage / Zimmer / Wohnungsnr.)
  const em = t.match(/(\d{1,2}\.?\s*(?:OG|Obergeschoss|Stock|Etage))|(EG|Erdgeschoss|DG|Dachgeschoss|UG)|(Zimmer\s*\d+)|(Whg\.?\s*Nr\.?\s*\d+)|(Wohnung\s*Nr\.?\s*\d+)/i);
  if (em) res.einheit = em[0].replace(/\s+/g, ' ').trim();

  // Verwendungszweck-Vorschlag
  if (res.name) res.vwz = 'Miete ' + res.name.split(' ').slice(-1)[0];

  return res;
}


/* ── GLOBALS FÜR INLINE-HANDLER ── */
Object.assign(window, {
  loginWithEmail, signUpWithEmail, resendConfirmationEmail, logout,
  headerAction, renderMieter, resetMieterFilter, saveMieter, closeAllDialogs,
  onMonatChange, renderZahlungen, resetZahlungenFilter, saveZahlung, prefillZahlung,
  renderWarnliste, assignUnklar, dismissUnklar,
  mieterContextMenu, zahlungContextMenu,
});
