const { Telegraf, Markup } = require('telegraf');
const { google } = require('googleapis');
const { AsyncLocalStorage } = require('async_hooks');
const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');
const config = require('./rekap.json');

// ---- Multi-tenant context ----
// Tiap update Telegram dijalankan dalam konteks tenant (spreadsheet milik user).
const tenantStore = new AsyncLocalStorage();

function isMultiTenant() {
  return config.multiTenant === true;
}

function masterId() {
  return config.masterSpreadsheetId || config.spreadsheetId;
}

// Spreadsheet ID aktif: ikut konteks tenant bila ada, jika tidak pakai config.
function ssId() {
  const t = tenantStore.getStore();
  return (t && t.spreadsheetId) || config.spreadsheetId;
}

if (!config.botToken) {
  throw new Error('botToken di rekap.json belum diisi');
}

if (!isMultiTenant() && !config.spreadsheetId) {
  throw new Error('spreadsheetId di rekap.json belum diisi');
}

if (isMultiTenant() && !masterId()) {
  throw new Error('masterSpreadsheetId di rekap.json belum diisi (mode multi-tenant)');
}

if (!config.ownerUserId) {
  throw new Error('ownerUserId di rekap.json belum diisi');
}

// Opsi koneksi Telegram: dukung proxy & apiRoot custom bila Telegram diblokir
// ISP/negara atau VPS tak bisa menjangkau api.telegram.org langsung.
const telegramOptions = {};
if (config.telegramApiRoot) telegramOptions.apiRoot = config.telegramApiRoot;
const proxyUrl = config.proxyUrl || process.env.HTTPS_PROXY || process.env.https_proxy;
if (proxyUrl) {
  try {
    let ProxyAgent;
    if (/^socks/i.test(proxyUrl)) {
      ({ SocksProxyAgent: ProxyAgent } = require('socks-proxy-agent'));
    } else {
      ({ HttpsProxyAgent: ProxyAgent } = require('https-proxy-agent'));
    }
    telegramOptions.agent = new ProxyAgent(proxyUrl);
    logInfo('Memakai proxy untuk Telegram: ' + proxyUrl);
  } catch (e) {
    logError(
      'proxyUrl diatur tapi paket proxy belum terpasang. Jalankan:\n' +
      '  npm install https-proxy-agent socks-proxy-agent',
      e
    );
  }
}
const bot = Object.keys(telegramOptions).length
  ? new Telegraf(config.botToken, { telegram: telegramOptions })
  : new Telegraf(config.botToken);

const anthropicApiKey = config.anthropicApiKey || process.env.ANTHROPIC_API_KEY;
const anthropic = anthropicApiKey
  ? new Anthropic({ apiKey: anthropicApiKey })
  : null;

// Menyimpan hasil baca struk sementara (menunggu konfirmasi tombol).
const pendingReceipts = new Map();

// Baris transaksi terakhir yang dihapus (untuk /batal).
let lastDeletedRow = null;

// Keyboard pintasan yang muncul di bawah kolom ketik.
const mainKeyboard = Markup.keyboard([
  ['/ringkasan', '/saldo', '/hari', '/minggu', '/bulan'],
  ['/laporan', '/analisa', '/kategori', '/tips'],
  ['/budget', '/target', '/langganan', '/hutang'],
  ['/neraca', '/akun', '/cari', '/export'],
  ['/edit', '/hapus', '/batal', '/help']
]).resize();

const RECEIPT_CATEGORIES = [
  'Makanan', 'Minuman', 'Kebutuhan Pokok', 'Transportasi', 'Kesehatan',
  'Hiburan', 'Tagihan', 'Pendidikan', 'Belanja', 'Lainnya'
];

function buildReceiptSummary(p) {
  const lines = [];
  lines.push('Hasil baca struk 🧾');
  lines.push(`Tanggal: ${p.tanggal}`);
  if (p.item) lines.push(`Item: ${p.item}`);
  lines.push(`Kategori: ${p.kategori}`);
  if (p.toko) lines.push(`Toko: ${p.toko}`);
  lines.push(
    `Total: Rp${Math.round(p.total).toLocaleString('id-ID')}` +
    (p.totalNote ? ` (≈ ${p.totalNote})` : '')
  );
  if (Array.isArray(p.items) && p.items.length > 0) {
    lines.push('');
    lines.push('Rincian:');
    for (const item of p.items.slice(0, 15)) {
      const harga = coerceAmountNumber(item.harga);
      lines.push(`- ${item.nama}: Rp${harga.toLocaleString('id-ID')}`);
    }
  }
  return lines.join('\n');
}

function receiptKeyboard(id, current) {
  const catRows = [];
  for (let i = 0; i < RECEIPT_CATEGORIES.length; i += 3) {
    catRows.push(
      RECEIPT_CATEGORIES.slice(i, i + 3).map((c) => ({
        text: c === current ? `✅ ${c}` : c,
        callback_data: `rc|cat|${id}|${c}`
      }))
    );
  }
  return {
    inline_keyboard: [
      ...catRows,
      [
        { text: '💾 Simpan', callback_data: `rc|save|${id}` },
        { text: '❌ Batal', callback_data: `rc|cancel|${id}` }
      ]
    ]
  };
}

const auth = new google.auth.GoogleAuth({
  keyFile: config.credentialsFile || './rekap-credentials.json',
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

// Auth terpisah dengan akses Drive — dipakai khusus untuk onboarding otomatis
// (membuat salinan spreadsheet pelanggan + membagikannya ke email). Memerlukan
// Google Drive API aktif untuk service account.
const driveAuth = new google.auth.GoogleAuth({
  keyFile: config.credentialsFile || './rekap-credentials.json',
  scopes: [
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/spreadsheets',
  ],
});

function getSheetName() {
  const t = tenantStore.getStore();
  return (t && t.sheetName) || config.sheetName || 'Sheet1';
}

function getAnalisaSheetName() {
  return config.analisaSheetName || 'Analisa';
}

function getBudgetSheetName() {
  return config.budgetSheetName || 'Budget';
}

function getLanggananSheetName() {
  return config.langgananSheetName || 'Langganan';
}

function getTargetSheetName() {
  return config.targetSheetName || 'Target';
}

function getHutangSheetName() {
  return config.hutangSheetName || 'Hutang';
}

function getKategoriMapSheetName() {
  return config.kategoriMapSheetName || 'KategoriMap';
}

function getNeracaSheetName() {
  return config.neracaSheetName || 'Neraca';
}

// Pemetaan kategori custom dari user (kata kunci -> induk kategori).
// Diisi saat startup & diperbarui saat user menambah/menghapus.
let customCategoryRules = [];

// Aturan induk kategori untuk pengeluaran (urutan = prioritas)
const EXPENSE_CATEGORY_RULES = [
  ['Makanan', ['makan', 'makanan', 'food', 'jajan', 'snack', 'cemilan', 'camilan', 'restoran', 'resto', 'warung', 'warteg', 'nasi', 'bakso', 'mie', 'ayam', 'sate', 'gofood', 'grabfood', 'sarapan', 'lunch', 'dinner']],
  ['Minuman', ['minum', 'minuman', 'drink', 'kopi', 'coffee', 'teh', 'jus', 'boba', 'soda', 'aqua', 'air mineral', 'starbucks']],
  ['Kebutuhan Pokok', ['kebutuhan pokok', 'kebutuhan', 'sembako', 'belanja', 'groceries', 'grocery', 'indomaret', 'alfamart', 'supermarket', 'minimarket', 'pasar', 'beras', 'gula', 'minyak goreng', 'telur', 'sabun', 'deterjen']],
  ['Transportasi', ['transport', 'transportasi', 'kereta', 'krl', 'kai', 'tiket', 'pesawat', 'bus', 'travel', 'bensin', 'pertalite', 'pertamax', 'solar', 'bbm', 'ojek', 'ojol', 'gojek', 'grab', 'taksi', 'taxi', 'parkir', 'tol', 'angkot']],
  ['Kesehatan', ['kesehatan', 'obat', 'apotek', 'apotik', 'dokter', 'klinik', 'rumah sakit', 'vitamin', 'medis']],
  ['Hiburan', ['hiburan', 'bioskop', 'nonton', 'film', 'game', 'netflix', 'spotify', 'streaming', 'wisata', 'liburan', 'rekreasi', 'konser']],
  ['Tagihan', ['tagihan', 'listrik', 'pln', 'air', 'pdam', 'internet', 'wifi', 'indihome', 'pulsa', 'paket data', 'kuota', 'token']],
  ['Pendidikan', ['pendidikan', 'sekolah', 'kuliah', 'spp', 'buku', 'kursus', 'les']],
  ['Belanja', ['baju', 'pakaian', 'sepatu', 'fashion', 'elektronik', 'gadget', 'shopee', 'tokopedia', 'lazada', 'olshop', 'online shop']],
];

// Daftar induk kategori pengeluaran (untuk rincian periode di Analisa)
const PARENT_EXPENSE_CATS = EXPENSE_CATEGORY_RULES.map((r) => r[0]).concat(['Lainnya']);

// Aturan induk kategori untuk pemasukan
const INCOME_CATEGORY_RULES = [
  ['Gaji', ['gaji', 'salary', 'upah']],
  ['Bonus', ['bonus', 'thr', 'komisi', 'insentif']],
  ['Usaha', ['usaha', 'jualan', 'dagang', 'omzet', 'penjualan']],
  ['Investasi', ['investasi', 'dividen', 'bunga', 'saham', 'crypto', 'airdrop', 'staking', 'trading']],
  ['Freelance', ['freelance', 'proyek', 'project', 'fee', 'honor']],
];

function titleCase(str) {
  return String(str)
    .trim()
    .split(/\s+/)
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : ''))
    .join(' ');
}

// Satukan sinonim kategori menjadi satu induk kategori.
// Contoh: "makan", "makanan", "warung" -> "Makanan".
function matchKeyword(s, kw) {
  const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i').test(s);
}

function normalizeCategory(raw, type) {
  const s = String(raw || '').toLowerCase().trim();
  if (!s) return 'Lainnya';

  // Pemetaan custom dari user diprioritaskan (mode pribadi/single-tenant).
  if (!isMultiTenant()) {
    for (const [keyword, canonical] of customCategoryRules) {
      if (matchKeyword(s, keyword)) return canonical;
    }
  }

  const rules = type === 'pemasukan' ? INCOME_CATEGORY_RULES : EXPENSE_CATEGORY_RULES;

  for (const [canonical, keywords] of rules) {
    for (const kw of keywords) {
      if (matchKeyword(s, kw)) return canonical;
    }
  }

  return titleCase(raw);
}

function getTimezone() {
  return config.timezone || 'Asia/Jakarta';
}

function logInfo(message) {
  console.log(`[INFO] ${message}`);
}

function logError(message, err = null) {
  if (err) {
    console.error(`[ERROR] ${message}`, err);
  } else {
    console.error(`[ERROR] ${message}`);
  }
}

function getAllowedUserIds() {
  const ids = [];
  if (config.ownerUserId != null) ids.push(String(config.ownerUserId).trim());

  const extra = config.allowedUserIds;
  if (Array.isArray(extra)) {
    for (const id of extra) ids.push(String(id).trim());
  } else if (typeof extra === 'string') {
    for (const id of extra.split(',')) {
      const t = id.trim();
      if (t) ids.push(t);
    }
  }

  // Id dari pemetaan nama user (config.users) juga otomatis diizinkan.
  if (config.users && typeof config.users === 'object') {
    for (const id of Object.keys(config.users)) ids.push(String(id).trim());
  }

  return Array.from(new Set(ids.filter(Boolean)));
}

function getUserName(ctx) {
  const id = String(ctx.from?.id || '').trim();
  const users = config.users || {};
  if (users[id]) return String(users[id]);

  const fn = ctx.from?.first_name || '';
  const ln = ctx.from?.last_name || '';
  const name = `${fn} ${ln}`.trim();
  return name || ctx.from?.username || id || 'User';
}

function isOwner(ctx) {
  const userId = String(ctx.from?.id || '').trim();
  return getAllowedUserIds().includes(userId);
}

function getOwnerChatIds() {
  // Untuk pesan terjadwal (reminder/langganan) ke semua user yang diizinkan.
  return getAllowedUserIds();
}

function parseRupiahTextToNumber(text) {
  if (!text) return 0;

  let raw = String(text).trim();

  raw = raw.replace(/^rp\s*/i, '');
  raw = raw.replace(/\./g, '');
  raw = raw.replace(/,/g, '');
  raw = raw.replace(/\s+/g, '');

  const n = Number(raw);
  return isNaN(n) ? 0 : n;
}

function formatRupiah(n) {
  return 'Rp' + Number(n).toLocaleString('id-ID');
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

const SAVE_PHRASES = [
  'Sip, dicatat ya 👌',
  'Oke, sudah masuk catatan ✅',
  'Mantap, tercatat 📝',
  'Beres! Dicatat ya 🙌',
  'Noted 👍',
  'Siap, sudah kucatat ✨'
];

function buildProgressBar(pct) {
  const clamped = Math.max(0, Math.min(100, Math.round(pct)));
  const filled = Math.round(clamped / 10);
  return '[' + '█'.repeat(filled) + '░'.repeat(10 - filled) + `] ${clamped}%`;
}

function parseDateParts(dateText) {
  const m = String(dateText).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;

  return {
    day: Number(m[1]),
    month: Number(m[2]),
    year: Number(m[3]),
  };
}

async function getAllEntries() {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });
  const sheetName = getSheetName();

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: ssId(),
    range: `'${sheetName}'!A:J`,
  });

  const rows = res.data.values || [];
  // Baris 1 = judul, baris 2 = header, data mulai baris 3 (index 2).
  const dataRows = rows.slice(2);

  const entries = [];

  for (const row of dataRows) {
    const tanggal = row[0] || '';
    const item = row[1] || '';
    const kategori = row[2] || '';
    const toko = row[3] || '';
    const pemasukan = row[4] || '';
    const pengeluaran = row[5] || '';
    const catatan = row[6] || '';
    const pencatat = row[7] || '';
    const akun = (row[8] || '').trim() || 'Kas';
    const id = row[9] || '';

    const parsedDate = parseDateParts(tanggal);
    if (!parsedDate) continue;

    entries.push({
      tanggal,
      item,
      kategori,
      toko,
      pemasukan: parseRupiahTextToNumber(pemasukan),
      pengeluaran: parseRupiahTextToNumber(pengeluaran),
      catatan,
      pencatat,
      akun,
      id,
      parsedDate,
    });
  }

  return entries;
}

function summarizeEntries(entries) {
  let totalPemasukan = 0;
  let totalPengeluaran = 0;
  const items = [];

  for (const entry of entries) {
    totalPemasukan += entry.pemasukan;
    totalPengeluaran += entry.pengeluaran;
    items.push(entry);
  }

  return {
    totalPemasukan,
    totalPengeluaran,
    saldo: totalPemasukan - totalPengeluaran,
    items,
  };
}

async function getMonthlySummary(month, year) {
  const entries = await getAllEntries();
  const filtered = entries.filter(
    (e) => e.parsedDate.month === month && e.parsedDate.year === year
  );
  return summarizeEntries(filtered);
}

async function getDailySummary(day, month, year) {
  const entries = await getAllEntries();
  const filtered = entries.filter(
    (e) =>
      e.parsedDate.day === day &&
      e.parsedDate.month === month &&
      e.parsedDate.year === year
  );
  return summarizeEntries(filtered);
}

async function guardOwner(ctx) {
  // Mode multi-tenant: akses sudah diverifikasi oleh middleware tenant.
  if (isMultiTenant()) return true;
  if (!isOwner(ctx)) {
    logInfo(`Akses ditolak untuk userId=${ctx.from?.id || 'unknown'}`);
    await ctx.reply('Bot ini khusus pemilik.');
    return false;
  }
  return true;
}

const REKAP_TITLE = "Rekap Uang by Ikhsan Abdul Nafi'u";
const REKAP_HEADER = [
  'Tanggal', 'Item', 'Kategori', 'Toko', 'Pemasukan',
  'Pengeluaran', 'Catatan', 'Pencatat', 'Akun', 'ID'
];

function genTxnId() {
  return 'TRX-' + Date.now().toString(36).toUpperCase() +
    Math.random().toString(36).slice(2, 4).toUpperCase();
}

async function appendRow(values) {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });
  const sheetName = getSheetName();

  const row = values.slice();
  if (row.length < 10 || !row[9]) row[9] = genTxnId();

  // Append setelah header (baris 2); judul di baris 1 tidak terganggu.
  await sheets.spreadsheets.values.append({
    spreadsheetId: ssId(),
    range: `'${sheetName}'!A2:J`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values: [row],
    },
  });

  logInfo('Berhasil simpan ke spreadsheet.');
  return row[9];
}

async function ensureHeader() {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });
  const sheetName = getSheetName();

  // Pastikan tab transaksi ada (mis. salinan template memakai nama tab berbeda).
  await ensureSheetExists(sheetName);

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: ssId(),
    range: `'${sheetName}'!A1:J2`,
  });

  const values = res.data.values || [];
  const title = values[0] || [];
  const header = values[1] || [];

  // Deteksi layout lama: baris 1 berisi header ('Tanggal') tanpa baris judul.
  // Sisipkan satu baris di atas agar data transaksi tidak tertimpa.
  if (title[0] === 'Tanggal') {
    const sheetId = await getSheetIdByName(sheetName);
    if (sheetId != null) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: ssId(),
        requestBody: {
          requests: [{
            insertDimension: {
              range: { sheetId, dimension: 'ROWS', startIndex: 0, endIndex: 1 },
              inheritFromBefore: false
            }
          }]
        }
      });
    }
    await sheets.spreadsheets.values.update({
      spreadsheetId: ssId(),
      range: `'${sheetName}'!A1:J2`,
      valueInputOption: 'RAW',
      requestBody: { values: [[REKAP_TITLE], REKAP_HEADER] }
    });
    return;
  }

  const needsTitle = title[0] !== REKAP_TITLE;
  const needsHeader =
    header[0] !== 'Tanggal' ||
    header[1] !== 'Item' ||
    header[2] !== 'Kategori' ||
    header[5] !== 'Pengeluaran' ||
    header[8] !== 'Akun' ||
    header[9] !== 'ID';

  if (needsTitle || needsHeader) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: ssId(),
      range: `'${sheetName}'!A1:J2`,
      valueInputOption: 'RAW',
      requestBody: {
        values: [
          [REKAP_TITLE],
          REKAP_HEADER
        ]
      }
    });
  }
}

async function formatSheetLayout() {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });
  const sheetName = getSheetName();

  const meta = await sheets.spreadsheets.get({
    spreadsheetId: ssId(),
  });

  const targetSheet = meta.data.sheets.find(
    (sheet) => sheet.properties.title === sheetName
  );

  if (!targetSheet) {
    throw new Error(`Sheet "${sheetName}" tidak ditemukan`);
  }

  const sheetId = targetSheet.properties.sheetId;
  const valueRes = await sheets.spreadsheets.values.get({
    spreadsheetId: ssId(),
    range: `'${sheetName}'!A:J`,
  });
  const values = valueRes.data.values || [];
  const lastRow = Math.max(values.length, 2);
  const fontFam = getSheetFont();
  const blackBorder = { style: 'SOLID', width: 1, color: { red: 0, green: 0, blue: 0 } };

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: ssId(),
    requestBody: {
      requests: [
        { mergeCells: { range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 10 }, mergeType: 'MERGE_ALL' } },
        { repeatCell: {
          range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 10 },
          cell: { userEnteredFormat: { backgroundColor: { red: 0.18, green: 0.49, blue: 0.36 }, textFormat: { bold: true, fontSize: 14, foregroundColor: { red: 1, green: 1, blue: 1 }, fontFamily: fontFam }, horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE' } },
          fields: 'userEnteredFormat.backgroundColor,userEnteredFormat.textFormat,userEnteredFormat.horizontalAlignment,userEnteredFormat.verticalAlignment'
        } },
        { repeatCell: {
          range: { sheetId, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: 10 },
          cell: { userEnteredFormat: { backgroundColor: { red: 0.84, green: 0.93, blue: 0.88 }, textFormat: { bold: true, fontSize: 11, fontFamily: fontFam }, horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE' } },
          fields: 'userEnteredFormat.backgroundColor,userEnteredFormat.textFormat.bold,userEnteredFormat.textFormat.fontSize,userEnteredFormat.textFormat.fontFamily,userEnteredFormat.horizontalAlignment,userEnteredFormat.verticalAlignment'
        } },
        // Reset latar baris data ke PUTIH agar baris baru tidak ikut warna
        // judul/header (mis. saat baris baru mewarisi format header).
        { repeatCell: {
          range: { sheetId, startRowIndex: 2, endRowIndex: lastRow, startColumnIndex: 0, endColumnIndex: 10 },
          cell: { userEnteredFormat: { backgroundColor: { red: 1, green: 1, blue: 1 }, textFormat: { bold: false, foregroundColor: { red: 0.13, green: 0.15, blue: 0.18 } } } },
          fields: 'userEnteredFormat.backgroundColor,userEnteredFormat.textFormat.bold,userEnteredFormat.textFormat.foregroundColor'
        } },
        { repeatCell: {
          range: { sheetId, startRowIndex: 2, endRowIndex: lastRow, startColumnIndex: 0, endColumnIndex: 1 },
          cell: { userEnteredFormat: { textFormat: { fontSize: 11, fontFamily: fontFam }, horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE' } },
          fields: 'userEnteredFormat.textFormat.fontSize,userEnteredFormat.textFormat.fontFamily,userEnteredFormat.horizontalAlignment,userEnteredFormat.verticalAlignment'
        } },
        { repeatCell: {
          range: { sheetId, startRowIndex: 2, endRowIndex: lastRow, startColumnIndex: 1, endColumnIndex: 4 },
          cell: { userEnteredFormat: { textFormat: { fontSize: 11, fontFamily: fontFam }, horizontalAlignment: 'LEFT', verticalAlignment: 'MIDDLE' } },
          fields: 'userEnteredFormat.textFormat.fontSize,userEnteredFormat.textFormat.fontFamily,userEnteredFormat.horizontalAlignment,userEnteredFormat.verticalAlignment'
        } },
        { repeatCell: {
          range: { sheetId, startRowIndex: 2, endRowIndex: lastRow, startColumnIndex: 4, endColumnIndex: 6 },
          cell: { userEnteredFormat: { textFormat: { fontSize: 11, fontFamily: fontFam }, horizontalAlignment: 'RIGHT', verticalAlignment: 'MIDDLE' } },
          fields: 'userEnteredFormat.textFormat.fontSize,userEnteredFormat.textFormat.fontFamily,userEnteredFormat.horizontalAlignment,userEnteredFormat.verticalAlignment'
        } },
        { repeatCell: {
          range: { sheetId, startRowIndex: 2, endRowIndex: lastRow, startColumnIndex: 6, endColumnIndex: 10 },
          cell: { userEnteredFormat: { textFormat: { fontSize: 11, fontFamily: fontFam }, horizontalAlignment: 'LEFT', verticalAlignment: 'MIDDLE' } },
          fields: 'userEnteredFormat.textFormat.fontSize,userEnteredFormat.textFormat.fontFamily,userEnteredFormat.horizontalAlignment,userEnteredFormat.verticalAlignment'
        } },
        { updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: 2 } }, fields: 'gridProperties.frozenRowCount' } },
        { setBasicFilter: { filter: { range: { sheetId, startRowIndex: 1, endRowIndex: lastRow, startColumnIndex: 0, endColumnIndex: 10 } } } },
        { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: 1 }, properties: { pixelSize: 95 }, fields: 'pixelSize' } },
        { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 1, endIndex: 4 }, properties: { pixelSize: 130 }, fields: 'pixelSize' } },
        { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 4, endIndex: 6 }, properties: { pixelSize: 120 }, fields: 'pixelSize' } },
        { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 6, endIndex: 8 }, properties: { pixelSize: 140 }, fields: 'pixelSize' } },
        { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 8, endIndex: 9 }, properties: { pixelSize: 100 }, fields: 'pixelSize' } },
        { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 9, endIndex: 10 }, properties: { pixelSize: 130 }, fields: 'pixelSize' } },
        { updateBorders: {
          range: { sheetId, startRowIndex: 1, endRowIndex: lastRow, startColumnIndex: 0, endColumnIndex: 10 },
          top: blackBorder, bottom: blackBorder, left: blackBorder, right: blackBorder, innerHorizontal: blackBorder, innerVertical: blackBorder
        } }
      ]
    }
  });

  // Kolom bantu TERSEMBUNYI (K=bulan, L=tahun, M=pemNum, N=pengNum). Data mulai baris 3.
  try {
    const dataRows = values.slice(2);
    const helper = dataRows.map((r) => {
      const d = parseDateParts(r[0] || '');
      return [d ? d.month : '', d ? d.year : '', parseRupiahTextToNumber(r[4] || ''), parseRupiahTextToNumber(r[5] || '')];
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: ssId(),
      range: `'${sheetName}'!K2:N2`,
      valueInputOption: 'RAW',
      requestBody: { values: [['_bln', '_thn', '_pemNum', '_pengNum']] }
    });
    await sheets.spreadsheets.values.clear({
      spreadsheetId: ssId(),
      range: `'${sheetName}'!K3:N100000`
    });
    if (helper.length > 0) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: ssId(),
        range: `'${sheetName}'!K3`,
        valueInputOption: 'RAW',
        requestBody: { values: helper }
      });
    }
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: ssId(),
      requestBody: {
        requests: [{
          updateDimensionProperties: {
            range: { sheetId, dimension: 'COLUMNS', startIndex: 10, endIndex: 14 },
            properties: { hiddenByUser: true },
            fields: 'hiddenByUser'
          }
        }]
      }
    });
  } catch (e) {
    logError('Gagal menyiapkan kolom bantu periode.', e);
  }
}

async function ensureSheetExists(sheetName) {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });

  const meta = await sheets.spreadsheets.get({
    spreadsheetId: ssId(),
  });

  const existing = meta.data.sheets.find(
    (sheet) => sheet.properties.title === sheetName
  );

  if (existing) {
    return existing.properties.sheetId;
  }

  const res = await sheets.spreadsheets.batchUpdate({
    spreadsheetId: ssId(),
    requestBody: {
      requests: [
        {
          addSheet: {
            properties: { title: sheetName }
          }
        }
      ]
    }
  });

  return res.data.replies[0].addSheet.properties.sheetId;
}

function buildMonthLabel(month, year) {
  return new Date(year, month - 1, 1).toLocaleDateString('id-ID', {
    month: 'long',
    year: 'numeric'
  });
}

async function updateAnalisaSheet() {
  const sheetName = getAnalisaSheetName();
  const sheetId = await ensureSheetExists(sheetName);

  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });

  const entries = await getAllEntries();

  let totalPemasukan = 0;
  let totalPengeluaran = 0;
  let expenseCount = 0;
  const perKategori = {};
  const perToko = {};
  const perBulan = {};
  const perKategoriIncome = {};

  const perPencatat = {};

  for (const entry of entries) {
    totalPemasukan += entry.pemasukan;
    totalPengeluaran += entry.pengeluaran;

    if (entry.pemasukan > 0) {
      const kIn = normalizeCategory(entry.kategori, 'pemasukan');
      perKategoriIncome[kIn] = (perKategoriIncome[kIn] || 0) + entry.pemasukan;
    }

    if (entry.pengeluaran > 0) {
      expenseCount += 1;
      const kategori = normalizeCategory(entry.kategori, 'pengeluaran');
      perKategori[kategori] = (perKategori[kategori] || 0) + entry.pengeluaran;

      const toko = entry.toko || '(Tanpa Toko)';
      perToko[toko] = (perToko[toko] || 0) + entry.pengeluaran;

      const pencatat = entry.pencatat || '(Tanpa Nama)';
      perPencatat[pencatat] = (perPencatat[pencatat] || 0) + entry.pengeluaran;
    }

    const key = `${entry.parsedDate.year}-${String(entry.parsedDate.month).padStart(2, '0')}`;
    if (!perBulan[key]) {
      perBulan[key] = {
        month: entry.parsedDate.month,
        year: entry.parsedDate.year,
        pemasukan: 0,
        pengeluaran: 0
      };
    }
    perBulan[key].pemasukan += entry.pemasukan;
    perBulan[key].pengeluaran += entry.pengeluaran;
  }

  const saldo = totalPemasukan - totalPengeluaran;
  const avgExpense = expenseCount > 0 ? Math.round(totalPengeluaran / expenseCount) : 0;

  const sortByValueDesc = (obj) =>
    Object.entries(obj).sort((a, b) => b[1] - a[1]);

  const katSorted = sortByValueDesc(perKategori);
  const tokoSorted = sortByValueDesc(perToko);
  const pencatatSorted = sortByValueDesc(perPencatat);
  const katIncomeSorted = sortByValueDesc(perKategoriIncome);
  const bulanSorted = Object.values(perBulan).sort((a, b) => {
    if (a.year !== b.year) return a.year - b.year;
    return a.month - b.month;
  });

  const now = new Date();
  const generatedAt = now.toLocaleString('id-ID', { timeZone: getTimezone() });
  const pctOf = (v) => (totalPengeluaran > 0 ? v / totalPengeluaran : 0);
  const pctOfIncome = (v) => (totalPemasukan > 0 ? v / totalPemasukan : 0);

  // Sheet utama (sumber data + kolom bantu K..N) dan pemisah argumen rumus per locale.
  const mainSheet = getSheetName();
  const curMonthNow = Number(now.toLocaleDateString('en-US', { timeZone: getTimezone(), month: 'numeric' }));
  const curYearNow = Number(now.toLocaleDateString('en-US', { timeZone: getTimezone(), year: 'numeric' }));
  let formulaSep = ',';
  let selBulan = curMonthNow;
  let selTahun = curYearNow;
  try {
    const metaL = await sheets.spreadsheets.get({ spreadsheetId: ssId(), fields: 'properties.locale' });
    const loc = (metaL.data.properties && metaL.data.properties.locale) || 'en_US';
    if (!/^en/i.test(loc)) formulaSep = ';';
  } catch (e) {}
  try {
    const prev = await sheets.spreadsheets.values.get({ spreadsheetId: ssId(), range: `'${sheetName}'!B5:D5` });
    const pv = (prev.data.values && prev.data.values[0]) || [];
    const pb = Number(pv[0]); const py = Number(pv[2]);
    if (Number.isInteger(pb) && pb >= 1 && pb <= 12) selBulan = pb;
    if (Number.isInteger(py) && py >= 2000) selTahun = py;
  } catch (e) {}
  // tahun pilihan: dari data + tahun berjalan
  const yearSet = new Set([curYearNow, selTahun]);
  for (const k of Object.keys(perBulan)) yearSet.add(perBulan[k].year);
  const yearVals = Array.from(yearSet).filter((y) => y >= 2000).sort((a, b) => b - a);

  const S = formulaSep;
  const rng = (col) => `'${mainSheet}'!${col}3:${col}100000`;

  // Bangun baris sambil mencatat posisi (index 0-based) untuk acuan grafik.
  const rows = [];
  const boldRows = [];
  const at = () => rows.length; // index baris berikutnya

  rows.push(['ANALISA KEUANGAN']);
  rows.push([`Diperbarui: ${generatedAt}`]);
  rows.push(['']);

  // ----- PERIODE (dropdown bulan & tahun, terhitung live via rumus) -----
  boldRows.push(at()); rows.push(['PERIODE (pilih bulan & tahun)']);
  const periodeRowIdx = at(); rows.push(['Bulan', selBulan, 'Tahun', selTahun]);
  const pr = periodeRowIdx + 1; // nomor baris sheet untuk sel dropdown
  const pPemIdx = at();
  rows.push(['Pemasukan periode', `=SUMIFS(${rng('M')}${S}${rng('K')}${S}$B$${pr}${S}${rng('L')}${S}$D$${pr})`]);
  const pPengIdx = at();
  rows.push(['Pengeluaran periode', `=SUMIFS(${rng('N')}${S}${rng('K')}${S}$B$${pr}${S}${rng('L')}${S}$D$${pr})`]);
  const pSaldoIdx = at();
  rows.push(['Saldo periode', `=B${pPemIdx + 1}-B${pPengIdx + 1}`]);
  rows.push(['']);
  boldRows.push(at()); rows.push(['PENGELUARAN PER KATEGORI (periode)']);
  boldRows.push(at()); rows.push(['Kategori', 'Jumlah']);
  const periodeKatStart = at();
  for (const cat of PARENT_EXPENSE_CATS) {
    rows.push([cat, `=SUMIFS(${rng('N')}${S}${rng('K')}${S}$B$${pr}${S}${rng('L')}${S}$D$${pr}${S}${rng('C')}${S}"${cat}")`]);
  }
  const periodeKatEnd = at();
  rows.push(['']);

  boldRows.push(at()); rows.push(['RINGKASAN']);
  const sumIncomeRow = at(); rows.push(['Total Pemasukan', totalPemasukan]);
  const sumExpenseRow = at(); rows.push(['Total Pengeluaran', totalPengeluaran]);
  const sumSaldoRow = at(); rows.push(['Saldo', saldo]);
  const sumCountRow = at(); rows.push(['Jumlah Transaksi', entries.length]);
  const sumAvgRow = at(); rows.push(['Rata-rata Pengeluaran', avgExpense]);
  rows.push(['']);

  boldRows.push(at()); rows.push(['PENGELUARAN PER KATEGORI']);
  boldRows.push(at()); rows.push(['Kategori', 'Jumlah', 'Persentase']);
  const katDataStart = at();
  for (const [kategori, jumlah] of katSorted) {
    rows.push([kategori, jumlah, pctOf(jumlah)]);
  }
  const katDataEnd = at();
  rows.push(['']);

  boldRows.push(at()); rows.push(['PEMASUKAN PER KATEGORI']);
  boldRows.push(at()); rows.push(['Kategori', 'Jumlah', 'Persentase']);
  const katIncDataStart = at();
  for (const [kategori, jumlah] of katIncomeSorted) {
    rows.push([kategori, jumlah, pctOfIncome(jumlah)]);
  }
  const katIncDataEnd = at();
  rows.push(['']);

  boldRows.push(at()); rows.push(['PENGELUARAN PER TOKO']);
  boldRows.push(at()); rows.push(['Toko', 'Jumlah', 'Persentase']);
  const tokoDataStart = at();
  for (const [toko, jumlah] of tokoSorted) {
    rows.push([toko, jumlah, pctOf(jumlah)]);
  }
  const tokoDataEnd = at();
  rows.push(['']);

  boldRows.push(at()); rows.push(['PENGELUARAN PER PENCATAT']);
  boldRows.push(at()); rows.push(['Pencatat', 'Jumlah', 'Persentase']);
  const pencatatDataStart = at();
  for (const [nama, jumlah] of pencatatSorted) {
    rows.push([nama, jumlah, pctOf(jumlah)]);
  }
  const pencatatDataEnd = at();
  rows.push(['']);

  boldRows.push(at()); rows.push(['RINGKASAN PER BULAN']);
  const bulanHeaderRow = at(); rows.push(['Bulan', 'Pemasukan', 'Pengeluaran', 'Saldo']);
  boldRows.push(bulanHeaderRow);
  const bulanDataStart = at();
  for (const b of bulanSorted) {
    rows.push([
      buildMonthLabel(b.month, b.year),
      b.pemasukan,
      b.pengeluaran,
      b.pemasukan - b.pengeluaran
    ]);
  }
  const bulanDataEnd = at();

  // Ambil id grafik lama agar bisa dihapus (hindari grafik menumpuk).
  let existingChartIds = [];
  try {
    const meta = await sheets.spreadsheets.get({
      spreadsheetId: ssId(),
      fields: 'sheets(properties/sheetId,charts/chartId)'
    });
    const target = (meta.data.sheets || []).find(
      (s) => s.properties.sheetId === sheetId
    );
    existingChartIds = ((target && target.charts) || []).map((c) => c.chartId);
  } catch (e) {
    logError('Gagal membaca grafik lama.', e);
  }

  await sheets.spreadsheets.values.clear({
    spreadsheetId: ssId(),
    range: `'${sheetName}'!A1:Z1000`,
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId: ssId(),
    range: `'${sheetName}'!A1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: rows },
  });

  // Gambar ilustrasi opsional (di pojok kanan) bila diatur di config.
  if (config.analisaImageUrl) {
    try {
      await sheets.spreadsheets.values.update({
        spreadsheetId: ssId(),
        range: `'${sheetName}'!E1`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[`=IMAGE("${config.analisaImageUrl}")`]] }
      });
    } catch (e) {
      logError('Gagal memasang gambar ilustrasi analisa.', e);
    }
  }

  const currencyFmt = {
    userEnteredFormat: { numberFormat: { type: 'CURRENCY', pattern: '"Rp"#,##0' } }
  };
  const percentFmt = {
    userEnteredFormat: { numberFormat: { type: 'PERCENT', pattern: '0.0%' } }
  };

  const rangeCell = (sr, er, sc, ec) => ({
    sheetId,
    startRowIndex: sr,
    endRowIndex: er,
    startColumnIndex: sc,
    endColumnIndex: ec
  });
  const src = (sr, er, sc, ec) => ({
    sourceRange: { sources: [rangeCell(sr, er, sc, ec)] }
  });

  const requests = [];

  // Hapus grafik lama
  for (const id of existingChartIds) {
    requests.push({ deleteEmbeddedObject: { objectId: id } });
  }

  // Dropdown Bulan (B) & Tahun (D) pada baris periode
  requests.push({
    setDataValidation: {
      range: rangeCell(periodeRowIdx, periodeRowIdx + 1, 1, 2),
      rule: {
        condition: { type: 'ONE_OF_LIST', values: Array.from({ length: 12 }, (_, i) => ({ userEnteredValue: String(i + 1) })) },
        showCustomUi: true, strict: false
      }
    }
  });
  requests.push({
    setDataValidation: {
      range: rangeCell(periodeRowIdx, periodeRowIdx + 1, 3, 4),
      rule: {
        condition: { type: 'ONE_OF_LIST', values: yearVals.map((y) => ({ userEnteredValue: String(y) })) },
        showCustomUi: true, strict: false
      }
    }
  });
  // Format mata uang sel periode (Pemasukan/Pengeluaran/Saldo + rincian kategori)
  requests.push({
    repeatCell: {
      range: rangeCell(pPemIdx, pSaldoIdx + 1, 1, 2),
      cell: { userEnteredFormat: { numberFormat: { type: 'CURRENCY', pattern: '"Rp"#,##0' } } },
      fields: 'userEnteredFormat.numberFormat'
    }
  });
  if (periodeKatEnd > periodeKatStart) {
    requests.push({
      repeatCell: {
        range: rangeCell(periodeKatStart, periodeKatEnd, 1, 2),
        cell: { userEnteredFormat: { numberFormat: { type: 'CURRENCY', pattern: '"Rp"#,##0' } } },
        fields: 'userEnteredFormat.numberFormat'
      }
    });
  }
  // Tonjolkan sel dropdown + paksa format ANGKA biasa (hindari sisa format
  // mata uang dari layout lama yang membuat bulan tampil "Rp6").
  requests.push({
    repeatCell: {
      range: rangeCell(periodeRowIdx, periodeRowIdx + 1, 1, 2),
      cell: { userEnteredFormat: { backgroundColor: { red: 1, green: 0.97, blue: 0.8 }, textFormat: { bold: true }, numberFormat: { type: 'NUMBER', pattern: '0' } } },
      fields: 'userEnteredFormat.backgroundColor,userEnteredFormat.textFormat.bold,userEnteredFormat.numberFormat'
    }
  });
  requests.push({
    repeatCell: {
      range: rangeCell(periodeRowIdx, periodeRowIdx + 1, 3, 4),
      cell: { userEnteredFormat: { backgroundColor: { red: 1, green: 0.97, blue: 0.8 }, textFormat: { bold: true }, numberFormat: { type: 'NUMBER', pattern: '0' } } },
      fields: 'userEnteredFormat.backgroundColor,userEnteredFormat.textFormat.bold,userEnteredFormat.numberFormat'
    }
  });

  // Judul besar — teks putih di atas latar hijau
  requests.push({
    repeatCell: {
      range: rangeCell(0, 1, 0, 4),
      cell: {
        userEnteredFormat: {
          backgroundColor: { red: 0.18, green: 0.49, blue: 0.36 },
          textFormat: {
            bold: true,
            fontSize: 15,
            foregroundColor: { red: 1, green: 1, blue: 1 }
          }
        }
      },
      fields: 'userEnteredFormat.backgroundColor,userEnteredFormat.textFormat'
    }
  });

  // Baris "Diperbarui" dibuat miring & abu-abu lembut
  requests.push({
    repeatCell: {
      range: rangeCell(1, 2, 0, 4),
      cell: {
        userEnteredFormat: {
          textFormat: { italic: true, foregroundColor: { red: 0.45, green: 0.45, blue: 0.45 } }
        }
      },
      fields: 'userEnteredFormat.textFormat.italic,userEnteredFormat.textFormat.foregroundColor'
    }
  });

  // Header bagian/tabel: tebal + latar hijau muda
  for (const r of boldRows) {
    requests.push({
      repeatCell: {
        range: rangeCell(r, r + 1, 0, 4),
        cell: {
          userEnteredFormat: {
            backgroundColor: { red: 0.85, green: 0.93, blue: 0.87 },
            textFormat: { bold: true }
          }
        },
        fields: 'userEnteredFormat.backgroundColor,userEnteredFormat.textFormat.bold'
      }
    });
  }

  // Format mata uang ringkasan
  requests.push({
    repeatCell: {
      range: rangeCell(sumIncomeRow, sumSaldoRow + 1, 1, 2),
      cell: currencyFmt,
      fields: 'userEnteredFormat.numberFormat'
    }
  });
  requests.push({
    repeatCell: {
      range: rangeCell(sumAvgRow, sumAvgRow + 1, 1, 2),
      cell: currencyFmt,
      fields: 'userEnteredFormat.numberFormat'
    }
  });

  // Format tabel kategori & toko
  if (katDataEnd > katDataStart) {
    requests.push({
      repeatCell: {
        range: rangeCell(katDataStart, katDataEnd, 1, 2),
        cell: currencyFmt,
        fields: 'userEnteredFormat.numberFormat'
      }
    });
    requests.push({
      repeatCell: {
        range: rangeCell(katDataStart, katDataEnd, 2, 3),
        cell: percentFmt,
        fields: 'userEnteredFormat.numberFormat'
      }
    });
  }
  if (katIncDataEnd > katIncDataStart) {
    requests.push({
      repeatCell: {
        range: rangeCell(katIncDataStart, katIncDataEnd, 1, 2),
        cell: currencyFmt,
        fields: 'userEnteredFormat.numberFormat'
      }
    });
    requests.push({
      repeatCell: {
        range: rangeCell(katIncDataStart, katIncDataEnd, 2, 3),
        cell: percentFmt,
        fields: 'userEnteredFormat.numberFormat'
      }
    });
  }
  if (tokoDataEnd > tokoDataStart) {
    requests.push({
      repeatCell: {
        range: rangeCell(tokoDataStart, tokoDataEnd, 1, 2),
        cell: currencyFmt,
        fields: 'userEnteredFormat.numberFormat'
      }
    });
    requests.push({
      repeatCell: {
        range: rangeCell(tokoDataStart, tokoDataEnd, 2, 3),
        cell: percentFmt,
        fields: 'userEnteredFormat.numberFormat'
      }
    });
  }

  if (pencatatDataEnd > pencatatDataStart) {
    requests.push({
      repeatCell: {
        range: rangeCell(pencatatDataStart, pencatatDataEnd, 1, 2),
        cell: currencyFmt,
        fields: 'userEnteredFormat.numberFormat'
      }
    });
    requests.push({
      repeatCell: {
        range: rangeCell(pencatatDataStart, pencatatDataEnd, 2, 3),
        cell: percentFmt,
        fields: 'userEnteredFormat.numberFormat'
      }
    });
  }

  // Format tabel bulan (Pemasukan, Pengeluaran, Saldo)
  if (bulanDataEnd > bulanDataStart) {
    requests.push({
      repeatCell: {
        range: rangeCell(bulanDataStart, bulanDataEnd, 1, 4),
        cell: currencyFmt,
        fields: 'userEnteredFormat.numberFormat'
      }
    });
  }

  // Lebar kolom
  requests.push({
    updateDimensionProperties: {
      range: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: 1 },
      properties: { pixelSize: 200 },
      fields: 'pixelSize'
    }
  });
  requests.push({
    updateDimensionProperties: {
      range: { sheetId, dimension: 'COLUMNS', startIndex: 1, endIndex: 5 },
      properties: { pixelSize: 130 },
      fields: 'pixelSize'
    }
  });

  // Grafik
  const anchorChart = (rowIndex, spec) => ({
    addChart: {
      chart: {
        spec,
        position: {
          overlayPosition: {
            anchorCell: { sheetId, rowIndex, columnIndex: 5 },
            offsetXPixels: 10,
            offsetYPixels: 5,
            widthPixels: 460,
            heightPixels: 300
          }
        }
      }
    }
  });

  // Pie: Pemasukan vs Pengeluaran
  if (totalPemasukan > 0 || totalPengeluaran > 0) {
    requests.push(anchorChart(1, {
      title: 'Pemasukan vs Pengeluaran',
      pieChart: {
        legendPosition: 'RIGHT_LEGEND',
        pieHole: 0.4,
        domain: src(sumIncomeRow, sumExpenseRow + 1, 0, 1),
        series: src(sumIncomeRow, sumExpenseRow + 1, 1, 2)
      }
    }));
  }

  // Pie: Pengeluaran per Kategori
  if (katDataEnd > katDataStart) {
    requests.push(anchorChart(17, {
      title: 'Pengeluaran per Kategori',
      pieChart: {
        legendPosition: 'RIGHT_LEGEND',
        pieHole: 0.4,
        domain: src(katDataStart, katDataEnd, 0, 1),
        series: src(katDataStart, katDataEnd, 1, 2)
      }
    }));
  }

  // Pie: Pengeluaran per Toko
  if (tokoDataEnd > tokoDataStart) {
    requests.push(anchorChart(33, {
      title: 'Pengeluaran per Toko',
      pieChart: {
        legendPosition: 'RIGHT_LEGEND',
        pieHole: 0.4,
        domain: src(tokoDataStart, tokoDataEnd, 0, 1),
        series: src(tokoDataStart, tokoDataEnd, 1, 2)
      }
    }));
  }

  // Pie: Pengeluaran per Pencatat (siapa yang catat/belanja)
  if (pencatatDataEnd > pencatatDataStart) {
    requests.push(anchorChart(49, {
      title: 'Pengeluaran per Pencatat',
      pieChart: {
        legendPosition: 'RIGHT_LEGEND',
        pieHole: 0.4,
        domain: src(pencatatDataStart, pencatatDataEnd, 0, 1),
        series: src(pencatatDataStart, pencatatDataEnd, 1, 2)
      }
    }));
  }

  // Pie: Pemasukan per Kategori
  if (katIncDataEnd > katIncDataStart) {
    requests.push(anchorChart(65, {
      title: 'Pemasukan per Kategori',
      pieChart: {
        legendPosition: 'RIGHT_LEGEND',
        pieHole: 0.4,
        domain: src(katIncDataStart, katIncDataEnd, 0, 1),
        series: src(katIncDataStart, katIncDataEnd, 1, 2)
      }
    }));
  }

  // Bar: Pemasukan & Pengeluaran per Bulan
  if (bulanDataEnd > bulanDataStart) {
    requests.push(anchorChart(81, {
      title: 'Pemasukan & Pengeluaran per Bulan',
      basicChart: {
        chartType: 'COLUMN',
        legendPosition: 'BOTTOM_LEGEND',
        headerCount: 1,
        axis: [
          { position: 'BOTTOM_AXIS', title: 'Bulan' },
          { position: 'LEFT_AXIS', title: 'Rupiah' }
        ],
        domains: [{ domain: src(bulanHeaderRow, bulanDataEnd, 0, 1) }],
        series: [
          { series: src(bulanHeaderRow, bulanDataEnd, 1, 2), targetAxis: 'LEFT_AXIS' },
          { series: src(bulanHeaderRow, bulanDataEnd, 2, 3), targetAxis: 'LEFT_AXIS' }
        ]
      }
    }));
  }

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: ssId(),
    requestBody: { requests },
  });

  // Perbarui saldo tiap akun di Neraca (otomatis dari transaksi).
  try {
    await refreshAccounts(entries);
    await formatNeracaSheet();
  } catch (e) {
    logError('Gagal memperbarui Neraca.', e);
  }

  // Perbarui sheet Budget (Terpakai/Sisa + grafik) untuk bulan berjalan.
  try {
    const _tz = getTimezone();
    const _now = new Date();
    const _m = Number(_now.toLocaleDateString('en-US', { timeZone: _tz, month: 'numeric' }));
    const _y = Number(_now.toLocaleDateString('en-US', { timeZone: _tz, year: 'numeric' }));
    await refreshBudgetSheet(_m, _y);
  } catch (e) {
    logError('Gagal memperbarui Budget.', e);
  }

  return {
    totalPemasukan,
    totalPengeluaran,
    saldo,
    avgExpense,
    jumlahTransaksi: entries.length,
    perKategori: katSorted,
    perToko: tokoSorted,
    perPencatat: pencatatSorted,
  };
}

const RECEIPT_PROMPT =
  'Kamu adalah asisten pencatat keuangan yang membaca foto struk/nota/tiket. ' +
  'Ekstrak data berikut dari gambar dengan teliti:\n' +
  '- toko: nama toko/merchant sesuai logo atau tulisan paling atas pada struk ' +
  '(contoh: Indomaret, Alfamart, Warkop Agam, KAI, Starbucks). ' +
  'Kosongkan jika benar-benar tidak tertera.\n' +
  '- total: nominal AKHIR yang dibayar. Cari kata "Grand Total", "Total Belanja", ' +
  '"Total Bayar", atau "Total". Tulis sebagai ANGKA saja sesuai mata uang aslinya ' +
  '(boleh desimal seperti 8.71 untuk USD), tanpa simbol mata uang & tanpa pemisah ribuan.\n' +
  '- mata_uang: kode mata uang nominal pada struk. "USD" bila ada tanda $ atau tulisan ' +
  'USD/dollar, "IDR" bila Rupiah/Rp. Jika ragu pilih "IDR".\n' +
  '- tanggal: tanggal transaksi pada struk, format DD/MM/YYYY. Kosongkan jika tidak ada.\n' +
  '- item: nama/jenis singkat pembelian (mis. "Belanja harian", "Makan", "Bensin", "Tiket kereta").\n' +
  '- kategori: tentukan dari jenis pembelian. Pilih SALAH SATU (gunakan kata persis ini):\n' +
  '   "Makanan" -> makanan/restoran/warung/kafe/snack,\n' +
  '   "Minuman" -> minuman/kopi/teh/jus/air mineral,\n' +
  '   "Kebutuhan Pokok" -> minimarket/supermarket/sembako/Indomaret/Alfamart,\n' +
  '   "Transportasi" -> kereta/KAI/tiket/pesawat/bus/bensin/ojek/taksi/parkir/tol,\n' +
  '   "Kesehatan" -> apotek/obat/klinik/dokter/rumah sakit,\n' +
  '   "Hiburan" -> bioskop/game/streaming/wisata,\n' +
  '   "Tagihan" -> listrik/air/internet/pulsa/paket data,\n' +
  '   "Pendidikan" -> sekolah/kuliah/buku/kursus,\n' +
  '   "Belanja" -> pakaian/elektronik/gadget/online shop,\n' +
  '   "Lainnya" -> jika tidak cocok kategori di atas.\n' +
  '- items: daftar barang beserta harganya jika terbaca.\n' +
  '- is_receipt: true jika gambar adalah struk/nota/tiket pembayaran, selain itu false.\n' +
  'Jika sebagian teks buram, tetap tebak sebaik mungkin dari konteks.';

const RECEIPT_SCHEMA = {
  type: 'object',
  properties: {
    is_receipt: { type: 'boolean' },
    toko: { type: 'string' },
    tanggal: { type: 'string' },
    item: { type: 'string' },
    kategori: { type: 'string' },
    total: { type: 'number' },
    mata_uang: { type: 'string' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          nama: { type: 'string' },
          harga: { type: 'number' }
        },
        required: ['nama', 'harga'],
        additionalProperties: false
      }
    }
  },
  required: ['is_receipt', 'toko', 'tanggal', 'item', 'kategori', 'total', 'mata_uang', 'items'],
  additionalProperties: false
};

const RECEIPT_JSON_HINT =
  '\n\nKembalikan HANYA JSON valid (tanpa teks lain, tanpa markdown) dengan ' +
  'bentuk persis:\n' +
  '{"is_receipt": boolean, "toko": string, "tanggal": string, ' +
  '"item": string, "kategori": string, "total": number, "mata_uang": string, ' +
  '"items": [{"nama": string, "harga": number}]}';

function getLlmProvider() {
  if (config.llmProvider) return String(config.llmProvider).toLowerCase();
  if (config.openaiApiKey || process.env.OPENAI_API_KEY) return 'openai';
  return 'claude';
}

function isLlmConfigured() {
  if (getLlmProvider() === 'openai') {
    return !!(config.openaiApiKey || process.env.OPENAI_API_KEY);
  }
  return !!anthropic;
}

function coerceAmountNumber(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? Math.round(value) : 0;
  }
  if (typeof value === 'string') {
    const digits = value.replace(/[^\d]/g, '');
    return digits ? Number(digits) : 0;
  }
  return 0;
}

// Ambil nilai numerik APA ADANYA (boleh desimal), untuk konversi mata uang asing.
function coerceAmountFloat(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const n = parseLocalizedNumber(value.replace(/[^\d.,]/g, ''));
    return n || 0;
  }
  return 0;
}

function extractJsonObject(text) {
  if (!text) throw new Error('Respons LLM kosong');

  let cleaned = String(text).trim();
  // Buang pembungkus markdown ```json ... ``` jika ada
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  try {
    return JSON.parse(cleaned);
  } catch (_) {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
      return JSON.parse(cleaned.slice(start, end + 1));
    }
    throw new Error('Gagal mem-parse JSON dari respons LLM');
  }
}

async function parseReceiptWithClaude(base64Data, mediaType) {
  if (!anthropic) {
    throw new Error('anthropicApiKey di rekap.json belum diisi');
  }

  const response = await anthropic.messages.create({
    model: config.anthropicModel || 'claude-opus-4-8',
    max_tokens: 2048,
    output_config: {
      format: { type: 'json_schema', schema: RECEIPT_SCHEMA }
    },
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: mediaType,
              data: base64Data
            }
          },
          { type: 'text', text: RECEIPT_PROMPT }
        ]
      }
    ]
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock) {
    throw new Error('Tidak ada respons teks dari pembaca struk');
  }

  return extractJsonObject(textBlock.text);
}

async function parseReceiptWithOpenAI(base64Data, mediaType) {
  const apiKey = config.openaiApiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('openaiApiKey di rekap.json belum diisi');
  }

  const baseUrl = (config.openaiBaseUrl || 'https://api.openai.com/v1')
    .replace(/\/+$/, '');
  const model = config.openaiModel || 'gpt-4o';

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      max_tokens: 2048,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: RECEIPT_PROMPT + RECEIPT_JSON_HINT },
            {
              type: 'image_url',
              image_url: { url: `data:${mediaType};base64,${base64Data}` }
            }
          ]
        }
      ]
    })
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`LLM error ${res.status}: ${detail.slice(0, 200)}`);
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;

  if (typeof content === 'string') {
    return extractJsonObject(content);
  }

  // Sebagian provider mengembalikan content sebagai array blok
  if (Array.isArray(content)) {
    const textPart = content
      .map((c) => (typeof c === 'string' ? c : c?.text || ''))
      .join('');
    return extractJsonObject(textPart);
  }

  throw new Error('Format respons LLM tidak dikenali');
}

async function parseReceiptImage(base64Data, mediaType) {
  if (getLlmProvider() === 'openai') {
    return parseReceiptWithOpenAI(base64Data, mediaType);
  }
  return parseReceiptWithClaude(base64Data, mediaType);
}

// ---------------------------------------------------------------------------
// Helper umum untuk sheet tambahan (Budget, Langganan, Target)
// ---------------------------------------------------------------------------

async function getSheetIdByName(sheetName) {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: ssId(),
    fields: 'sheets(properties(sheetId,title))'
  });
  const t = (meta.data.sheets || []).find((s) => s.properties.title === sheetName);
  return t ? t.properties.sheetId : null;
}

async function ensureSheetWithHeader(sheetName, header) {
  await ensureSheetExists(sheetName);
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });
  const colEnd = String.fromCharCode(64 + header.length);
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: ssId(),
    range: `'${sheetName}'!A1:${colEnd}1`
  });
  const cur = (res.data.values && res.data.values[0]) || [];
  const needs = header.some((h, i) => cur[i] !== h);
  if (needs) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: ssId(),
      range: `'${sheetName}'!A1:${colEnd}1`,
      valueInputOption: 'RAW',
      requestBody: { values: [header] }
    });
  }
}

async function parseAmountToNumber(text) {
  const t = await parseMoneyText(text);
  if (!t) return 0;
  return parseRupiahTextToNumber(t);
}

// ----- Pemetaan kategori custom -----

async function loadCustomCategoryRules() {
  try {
    const sheetName = getKategoriMapSheetName();
    await ensureSheetWithHeader(sheetName, ['Kata Kunci', 'Kategori']);
    const client = await auth.getClient();
    const sheets = google.sheets({ version: 'v4', auth: client });
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: ssId(),
      range: `'${sheetName}'!A2:B`
    });
    const rows = res.data.values || [];
    customCategoryRules = rows
      .map((r) => [(r[0] || '').trim().toLowerCase(), (r[1] || '').trim()])
      .filter(([k, v]) => k && v);
    logInfo(`Pemetaan kategori custom: ${customCategoryRules.length} aturan.`);
  } catch (e) {
    logError('Gagal memuat pemetaan kategori custom.', e);
  }
}

async function addCategoryMap(keyword, kategori) {
  const sheetName = getKategoriMapSheetName();
  await ensureSheetWithHeader(sheetName, ['Kata Kunci', 'Kategori']);
  const kw = keyword.trim().toLowerCase();
  const kat = titleCase(kategori);
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: ssId(),
    range: `'${sheetName}'!A2:B`
  });
  const rows = res.data.values || [];
  let found = -1;
  for (let i = 0; i < rows.length; i++) {
    if ((rows[i][0] || '').trim().toLowerCase() === kw) { found = i; break; }
  }
  if (found >= 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: ssId(),
      range: `'${sheetName}'!A${found + 2}:B${found + 2}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[kw, kat]] }
    });
  } else {
    await sheets.spreadsheets.values.append({
      spreadsheetId: ssId(),
      range: `'${sheetName}'!A:B`,
      valueInputOption: 'RAW',
      requestBody: { values: [[kw, kat]] }
    });
  }
  await loadCustomCategoryRules();
  return { keyword: kw, kategori: kat };
}

async function removeCategoryMap(keyword) {
  const sheetName = getKategoriMapSheetName();
  const kw = keyword.trim().toLowerCase();
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: ssId(),
    range: `'${sheetName}'!A2:B`
  });
  const rows = res.data.values || [];
  let found = -1;
  for (let i = 0; i < rows.length; i++) {
    if ((rows[i][0] || '').trim().toLowerCase() === kw) { found = i; break; }
  }
  if (found < 0) return false;
  const sheetId = await getSheetIdByName(sheetName);
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: ssId(),
    requestBody: {
      requests: [{
        deleteDimension: {
          range: { sheetId, dimension: 'ROWS', startIndex: found + 1, endIndex: found + 2 }
        }
      }]
    }
  });
  await loadCustomCategoryRules();
  return true;
}

// ----- Bantuan LLM teks (untuk /tips) -----

async function askLlmText(prompt) {
  if (getLlmProvider() === 'openai') {
    const apiKey = config.openaiApiKey || process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('openaiApiKey belum diisi');
    const baseUrl = (config.openaiBaseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
    const model = config.openaiModel || 'gpt-4o';
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        max_tokens: 600,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    if (!res.ok) {
      const d = await res.text().catch(() => '');
      throw new Error(`LLM error ${res.status}: ${d.slice(0, 150)}`);
    }
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content === 'string') return content.trim();
    if (Array.isArray(content)) return content.map((c) => (typeof c === 'string' ? c : c?.text || '')).join('').trim();
    return '';
  }

  if (!anthropic) throw new Error('anthropicApiKey belum diisi');
  const response = await anthropic.messages.create({
    model: config.anthropicModel || 'claude-opus-4-8',
    max_tokens: 600,
    messages: [{ role: 'user', content: prompt }]
  });
  const textBlock = response.content.find((b) => b.type === 'text');
  return textBlock ? textBlock.text.trim() : '';
}

// ----- Budget -----

async function getBudgets() {
  const sheetName = getBudgetSheetName();
  await ensureSheetWithHeader(sheetName, ['Kategori', 'Budget Bulanan']);
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: ssId(),
    range: `'${sheetName}'!A2:B`
  });
  const rows = res.data.values || [];
  const map = {};
  for (const r of rows) {
    const kat = (r[0] || '').trim();
    if (!kat) continue;
    map[normalizeCategory(kat, 'pengeluaran')] = parseRupiahTextToNumber(r[1] || '');
  }
  return map;
}

async function setBudget(kategori, amount) {
  const sheetName = getBudgetSheetName();
  await ensureSheetWithHeader(sheetName, ['Kategori', 'Budget Bulanan']);
  const canon = normalizeCategory(kategori, 'pengeluaran');
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: ssId(),
    range: `'${sheetName}'!A2:B`
  });
  const rows = res.data.values || [];
  let foundRow = -1;
  for (let i = 0; i < rows.length; i++) {
    if (normalizeCategory((rows[i][0] || '').trim(), 'pengeluaran') === canon) {
      foundRow = i;
      break;
    }
  }
  if (foundRow >= 0) {
    const rowNum = foundRow + 2;
    await sheets.spreadsheets.values.update({
      spreadsheetId: ssId(),
      range: `'${sheetName}'!A${rowNum}:B${rowNum}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[canon, amount]] }
    });
  } else {
    await sheets.spreadsheets.values.append({
      spreadsheetId: ssId(),
      range: `'${sheetName}'!A:B`,
      valueInputOption: 'RAW',
      requestBody: { values: [[canon, amount]] }
    });
  }
  return canon;
}

// Hitung ulang kolom Terpakai/Sisa, percantik, dan tambah grafik di sheet Budget.
async function refreshBudgetSheet(month, year) {
  const sheetName = getBudgetSheetName();
  await ensureSheetWithHeader(sheetName, ['Kategori', 'Budget Bulanan']);
  const sheetId = await getSheetIdByName(sheetName);
  if (sheetId == null) return;
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: ssId(),
    range: `'${sheetName}'!A2:B`
  });
  const rows = res.data.values || [];
  const dataRows = rows.filter((r) => (r[0] || '').trim());
  if (dataRows.length === 0) return;

  // Sheet sumber data (Rekap) + pemisah argumen rumus mengikuti locale.
  const mainSheet = getSheetName();
  const now = new Date();
  const curMonthNow = Number(now.toLocaleDateString('en-US', { timeZone: getTimezone(), month: 'numeric' }));
  const curYearNow = Number(now.toLocaleDateString('en-US', { timeZone: getTimezone(), year: 'numeric' }));
  let formulaSep = ',';
  let selBulan = Number.isInteger(month) ? month : curMonthNow;
  let selTahun = Number.isInteger(year) ? year : curYearNow;
  try {
    const metaL = await sheets.spreadsheets.get({ spreadsheetId: ssId(), fields: 'properties.locale' });
    const loc = (metaL.data.properties && metaL.data.properties.locale) || 'en_US';
    if (!/^en/i.test(loc)) formulaSep = ';';
  } catch (e) {}
  // Pertahankan pilihan periode sebelumnya (F2 = bulan, H2 = tahun).
  try {
    const prev = await sheets.spreadsheets.values.get({ spreadsheetId: ssId(), range: `'${sheetName}'!F2:H2` });
    const pv = (prev.data.values && prev.data.values[0]) || [];
    const pb = Number(pv[0]); const py = Number(pv[2]);
    if (Number.isInteger(pb) && pb >= 1 && pb <= 12) selBulan = pb;
    if (Number.isInteger(py) && py >= 2000) selTahun = py;
  } catch (e) {}
  // Daftar tahun untuk dropdown: dari data + tahun berjalan.
  const entries = await getAllEntries();
  const yearSet = new Set([curYearNow, selTahun]);
  for (const e of entries) { if (e.parsedDate && e.parsedDate.year >= 2000) yearSet.add(e.parsedDate.year); }
  const yearVals = Array.from(yearSet).filter((y) => y >= 2000).sort((a, b) => b - a);

  const S = formulaSep;
  const rng = (col) => `'${mainSheet}'!${col}3:${col}100000`;

  // Terpakai (C) & Sisa (D) sebagai rumus live mengikuti dropdown periode + kolom bantu Rekap.
  const cd = dataRows.map((_r, i) => {
    const r = i + 2; // baris sheet (data mulai baris 2)
    return [
      `=SUMIFS(${rng('N')}${S}${rng('K')}${S}$F$2${S}${rng('L')}${S}$H$2${S}${rng('C')}${S}$A${r})`,
      `=B${r}-C${r}`
    ];
  });

  // Header C1:D1 + rumus C2:D
  await sheets.spreadsheets.values.update({
    spreadsheetId: ssId(),
    range: `'${sheetName}'!C1:D1`,
    valueInputOption: 'RAW',
    requestBody: { values: [['Terpakai (periode)', 'Sisa']] }
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId: ssId(),
    range: `'${sheetName}'!C2:D${dataRows.length + 1}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: cd }
  });
  // Panel periode di samping (E1:H2) agar tabel A:D tidak bergeser.
  await sheets.spreadsheets.values.update({
    spreadsheetId: ssId(),
    range: `'${sheetName}'!E1:H2`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [['PERIODE (pilih bulan & tahun)', '', '', ''], ['Bulan', selBulan, 'Tahun', selTahun]] }
  });

  const lastRow = dataRows.length + 1;
  const font = getSheetFont();
  const currency = { numberFormat: { type: 'CURRENCY', pattern: '"Rp"#,##0' } };
  const existing = await getChartIds(sheets, sheetId);
  const requests = [];

  for (const id of existing) requests.push({ deleteEmbeddedObject: { objectId: id } });

  requests.push({
    repeatCell: {
      range: { sheetId, startRowIndex: 0, endRowIndex: lastRow, startColumnIndex: 0, endColumnIndex: 4 },
      cell: { userEnteredFormat: { textFormat: { fontFamily: font } } },
      fields: 'userEnteredFormat.textFormat.fontFamily'
    }
  });
  requests.push({
    repeatCell: {
      range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 4 },
      cell: {
        userEnteredFormat: {
          backgroundColor: { red: 0.18, green: 0.49, blue: 0.36 },
          textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 }, fontFamily: font },
          horizontalAlignment: 'CENTER'
        }
      },
      fields: 'userEnteredFormat.backgroundColor,userEnteredFormat.textFormat,userEnteredFormat.horizontalAlignment'
    }
  });
  requests.push({
    repeatCell: {
      range: { sheetId, startRowIndex: 1, endRowIndex: lastRow, startColumnIndex: 1, endColumnIndex: 4 },
      cell: { userEnteredFormat: currency },
      fields: 'userEnteredFormat.numberFormat'
    }
  });
  requests.push({
    updateSheetProperties: {
      properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
      fields: 'gridProperties.frozenRowCount'
    }
  });
  requests.push({ updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: 1 }, properties: { pixelSize: 150 }, fields: 'pixelSize' } });
  requests.push({ updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 1, endIndex: 4 }, properties: { pixelSize: 140 }, fields: 'pixelSize' } });

  // ----- Panel periode (dropdown bulan & tahun) di E1:H2 -----
  // Judul panel E1:H1
  requests.push({
    repeatCell: {
      range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 4, endColumnIndex: 8 },
      cell: {
        userEnteredFormat: {
          backgroundColor: { red: 0.18, green: 0.49, blue: 0.36 },
          textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 }, fontFamily: font }
        }
      },
      fields: 'userEnteredFormat.backgroundColor,userEnteredFormat.textFormat'
    }
  });
  requests.push({ mergeCells: { range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 4, endColumnIndex: 8 }, mergeType: 'MERGE_ALL' } });
  // Label "Bulan" (E2) & "Tahun" (G2)
  requests.push({
    repeatCell: {
      range: { sheetId, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 4, endColumnIndex: 5 },
      cell: { userEnteredFormat: { textFormat: { bold: true, fontFamily: font } } },
      fields: 'userEnteredFormat.textFormat'
    }
  });
  requests.push({
    repeatCell: {
      range: { sheetId, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 6, endColumnIndex: 7 },
      cell: { userEnteredFormat: { textFormat: { bold: true, fontFamily: font } } },
      fields: 'userEnteredFormat.textFormat'
    }
  });
  // Dropdown Bulan (F2)
  requests.push({
    setDataValidation: {
      range: { sheetId, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 5, endColumnIndex: 6 },
      rule: {
        condition: { type: 'ONE_OF_LIST', values: Array.from({ length: 12 }, (_, i) => ({ userEnteredValue: String(i + 1) })) },
        showCustomUi: true, strict: false
      }
    }
  });
  // Dropdown Tahun (H2)
  requests.push({
    setDataValidation: {
      range: { sheetId, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 7, endColumnIndex: 8 },
      rule: {
        condition: { type: 'ONE_OF_LIST', values: yearVals.map((y) => ({ userEnteredValue: String(y) })) },
        showCustomUi: true, strict: false
      }
    }
  });
  // Tonjolkan sel dropdown F2 & H2 + paksa format ANGKA biasa (bukan mata uang)
  requests.push({
    repeatCell: {
      range: { sheetId, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 5, endColumnIndex: 6 },
      cell: { userEnteredFormat: { backgroundColor: { red: 1, green: 0.97, blue: 0.8 }, textFormat: { bold: true, fontFamily: font }, horizontalAlignment: 'CENTER', numberFormat: { type: 'NUMBER', pattern: '0' } } },
      fields: 'userEnteredFormat.backgroundColor,userEnteredFormat.textFormat,userEnteredFormat.horizontalAlignment,userEnteredFormat.numberFormat'
    }
  });
  requests.push({
    repeatCell: {
      range: { sheetId, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 7, endColumnIndex: 8 },
      cell: { userEnteredFormat: { backgroundColor: { red: 1, green: 0.97, blue: 0.8 }, textFormat: { bold: true, fontFamily: font }, horizontalAlignment: 'CENTER', numberFormat: { type: 'NUMBER', pattern: '0' } } },
      fields: 'userEnteredFormat.backgroundColor,userEnteredFormat.textFormat,userEnteredFormat.horizontalAlignment,userEnteredFormat.numberFormat'
    }
  });

  // Grafik kolom: Budget vs Terpakai per kategori
  requests.push({
    addChart: {
      chart: {
        spec: {
          title: 'Budget vs Terpakai',
          basicChart: {
            chartType: 'COLUMN',
            legendPosition: 'BOTTOM_LEGEND',
            headerCount: 1,
            domains: [{ domain: { sourceRange: { sources: [{ sheetId, startRowIndex: 0, endRowIndex: lastRow, startColumnIndex: 0, endColumnIndex: 1 }] } } }],
            series: [
              { series: { sourceRange: { sources: [{ sheetId, startRowIndex: 0, endRowIndex: lastRow, startColumnIndex: 1, endColumnIndex: 2 }] } } },
              { series: { sourceRange: { sources: [{ sheetId, startRowIndex: 0, endRowIndex: lastRow, startColumnIndex: 2, endColumnIndex: 3 }] } } }
            ]
          }
        },
        position: {
          overlayPosition: {
            anchorCell: { sheetId, rowIndex: 3, columnIndex: 4 },
            offsetXPixels: 5, offsetYPixels: 10, widthPixels: 480, heightPixels: 300
          }
        }
      }
    }
  });

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: ssId(),
    requestBody: { requests }
  });

  if (config.budgetImageUrl) {
    try {
      await sheets.spreadsheets.values.update({
        spreadsheetId: ssId(),
        range: `'${sheetName}'!I1`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[`=IMAGE("${config.budgetImageUrl}")`]] }
      });
    } catch (e) { logError('Gagal pasang gambar budget.', e); }
  }
}

async function deleteBudget(kategori) {
  const sheetName = getBudgetSheetName();
  const canon = normalizeCategory(kategori, 'pengeluaran');
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: ssId(),
    range: `'${sheetName}'!A2:B`
  });
  const rows = res.data.values || [];
  let foundRow = -1;
  for (let i = 0; i < rows.length; i++) {
    if (normalizeCategory((rows[i][0] || '').trim(), 'pengeluaran') === canon) {
      foundRow = i;
      break;
    }
  }
  if (foundRow < 0) return false;
  const sheetId = await getSheetIdByName(sheetName);
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: ssId(),
    requestBody: {
      requests: [{
        deleteDimension: {
          range: { sheetId, dimension: 'ROWS', startIndex: foundRow + 1, endIndex: foundRow + 2 }
        }
      }]
    }
  });
  return true;
}

async function getMonthlyCategoryTotal(kategoriCanon, month, year) {
  const entries = await getAllEntries();
  let sum = 0;
  for (const e of entries) {
    if (e.pengeluaran <= 0) continue;
    if (e.parsedDate.month !== month || e.parsedDate.year !== year) continue;
    if (normalizeCategory(e.kategori, 'pengeluaran') === kategoriCanon) sum += e.pengeluaran;
  }
  return sum;
}

async function checkBudgetAlert(kategoriCanon, month, year) {
  const budgets = await getBudgets();
  const budget = budgets[kategoriCanon];
  if (!budget || budget <= 0) return null;
  const spent = await getMonthlyCategoryTotal(kategoriCanon, month, year);
  const ratio = spent / budget;
  const pct = Math.round(ratio * 100);
  if (ratio >= 1) {
    return `⚠️ Budget ${kategoriCanon} TERLAMPAUI: ${formatRupiah(spent)} / ${formatRupiah(budget)} (${pct}%)`;
  }
  if (ratio >= 0.8) {
    return `⚠️ Budget ${kategoriCanon} hampir habis: ${formatRupiah(spent)} / ${formatRupiah(budget)} (${pct}%)`;
  }
  return null;
}

// ----- Target tabungan -----

async function getTargets() {
  const sheetName = getTargetSheetName();
  await ensureSheetWithHeader(sheetName, ['Nama', 'Target', 'Terkumpul']);
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: ssId(),
    range: `'${sheetName}'!A2:C`
  });
  const rows = res.data.values || [];
  const list = [];
  rows.forEach((r, i) => {
    const nama = (r[0] || '').trim();
    if (!nama) return;
    list.push({
      nama,
      target: parseRupiahTextToNumber(r[1] || ''),
      terkumpul: parseRupiahTextToNumber(r[2] || ''),
      rowNum: i + 2
    });
  });
  return list;
}

async function setTarget(nama, target) {
  const sheetName = getTargetSheetName();
  const list = await getTargets();
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });
  const found = list.find((t) => t.nama.toLowerCase() === nama.toLowerCase());
  if (found) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: ssId(),
      range: `'${sheetName}'!A${found.rowNum}:C${found.rowNum}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[found.nama, target, found.terkumpul]] }
    });
    return { ...found, target };
  }
  await sheets.spreadsheets.values.append({
    spreadsheetId: ssId(),
    range: `'${sheetName}'!A:C`,
    valueInputOption: 'RAW',
    requestBody: { values: [[nama, target, 0]] }
  });
  return { nama, target, terkumpul: 0 };
}

async function addNabung(nama, amount) {
  const sheetName = getTargetSheetName();
  const list = await getTargets();
  const found = list.find((t) => t.nama.toLowerCase() === nama.toLowerCase());
  if (!found) return null;
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });
  const terkumpul = found.terkumpul + amount;
  await sheets.spreadsheets.values.update({
    spreadsheetId: ssId(),
    range: `'${sheetName}'!A${found.rowNum}:C${found.rowNum}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[found.nama, found.target, terkumpul]] }
  });
  return { ...found, terkumpul };
}

async function deleteTarget(nama) {
  const sheetName = getTargetSheetName();
  const list = await getTargets();
  const found = list.find((t) => t.nama.toLowerCase() === nama.toLowerCase());
  if (!found) return false;
  const sheetId = await getSheetIdByName(sheetName);
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: ssId(),
    requestBody: {
      requests: [{
        deleteDimension: {
          range: { sheetId, dimension: 'ROWS', startIndex: found.rowNum - 1, endIndex: found.rowNum }
        }
      }]
    }
  });
  return true;
}

// ----- Langganan / recurring -----

const LANGGANAN_HEADER = [
  'Nama', 'Kategori', 'Toko', 'Nominal', 'Tanggal Tagih', 'Catatan', 'Jenis'
];

async function getLangganan() {
  const sheetName = getLanggananSheetName();
  await ensureSheetWithHeader(sheetName, LANGGANAN_HEADER);
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: ssId(),
    range: `'${sheetName}'!A2:G`
  });
  const rows = res.data.values || [];
  const list = [];
  rows.forEach((r, i) => {
    const nama = (r[0] || '').trim();
    if (!nama) return;
    const jenisRaw = (r[6] || '').trim().toLowerCase();
    const jenis = /masuk|income|pemasukan/.test(jenisRaw) ? 'pemasukan' : 'pengeluaran';
    list.push({
      nama,
      kategori: (r[1] || '').trim(),
      toko: (r[2] || '').trim(),
      nominal: parseRupiahTextToNumber(r[3] || ''),
      hari: Number(r[4]) || 0,
      catatan: (r[5] || '').trim(),
      jenis,
      rowNum: i + 2
    });
  });
  return list;
}

async function addLangganan(obj) {
  const sheetName = getLanggananSheetName();
  await ensureSheetWithHeader(sheetName, LANGGANAN_HEADER);
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });
  const jenis = obj.jenis === 'pemasukan' ? 'pemasukan' : 'pengeluaran';
  await sheets.spreadsheets.values.append({
    spreadsheetId: ssId(),
    range: `'${sheetName}'!A:G`,
    valueInputOption: 'RAW',
    requestBody: {
      values: [[
        obj.nama,
        normalizeCategory(obj.kategori, jenis),
        jenis === 'pemasukan' ? '' : (obj.toko || 'Lainnya'),
        obj.nominal,
        obj.hari,
        obj.catatan || '',
        jenis
      ]]
    }
  });
}

async function deleteLangganan(nama) {
  const sheetName = getLanggananSheetName();
  const list = await getLangganan();
  const found = list.find((l) => l.nama.toLowerCase() === nama.toLowerCase());
  if (!found) return false;
  const sheetId = await getSheetIdByName(sheetName);
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: ssId(),
    requestBody: {
      requests: [{
        deleteDimension: {
          range: {
            sheetId,
            dimension: 'ROWS',
            startIndex: found.rowNum - 1,
            endIndex: found.rowNum
          }
        }
      }]
    }
  });
  return true;
}

// Percantik tampilan sheet Langganan (header hijau, mata uang, border, dll).
async function formatLanggananSheet() {
  const sheetName = getLanggananSheetName();
  await ensureSheetWithHeader(sheetName, LANGGANAN_HEADER);
  const sheetId = await getSheetIdByName(sheetName);
  if (sheetId == null) return;
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });

  const valueRes = await sheets.spreadsheets.values.get({
    spreadsheetId: ssId(),
    range: `'${sheetName}'!A2:G`
  });
  const dataCount = (valueRes.data.values || []).filter((r) => (r[0] || '').trim()).length;
  const lastRow = Math.max(dataCount + 1, 2);
  const font = getSheetFont();
  const blackBorder = { style: 'SOLID', width: 1, color: { red: 0, green: 0, blue: 0 } };
  const requests = [];

  // Font ke seluruh area
  requests.push({
    repeatCell: {
      range: { sheetId, startRowIndex: 0, endRowIndex: lastRow, startColumnIndex: 0, endColumnIndex: 7 },
      cell: { userEnteredFormat: { textFormat: { fontFamily: font, fontSize: 11 }, verticalAlignment: 'MIDDLE' } },
      fields: 'userEnteredFormat.textFormat.fontFamily,userEnteredFormat.textFormat.fontSize,userEnteredFormat.verticalAlignment'
    }
  });
  // Header A1:G1 — latar hijau, teks putih, tebal, rata tengah
  requests.push({
    repeatCell: {
      range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 7 },
      cell: {
        userEnteredFormat: {
          backgroundColor: { red: 0.18, green: 0.49, blue: 0.36 },
          textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 }, fontFamily: font },
          horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE'
        }
      },
      fields: 'userEnteredFormat.backgroundColor,userEnteredFormat.textFormat,userEnteredFormat.horizontalAlignment,userEnteredFormat.verticalAlignment'
    }
  });
  // Nominal (kolom D) — format mata uang, rata kanan
  requests.push({
    repeatCell: {
      range: { sheetId, startRowIndex: 1, endRowIndex: lastRow, startColumnIndex: 3, endColumnIndex: 4 },
      cell: { userEnteredFormat: { numberFormat: { type: 'CURRENCY', pattern: '"Rp"#,##0' }, horizontalAlignment: 'RIGHT' } },
      fields: 'userEnteredFormat.numberFormat,userEnteredFormat.horizontalAlignment'
    }
  });
  // Tanggal Tagih (kolom E) & Jenis (kolom G) — rata tengah
  requests.push({
    repeatCell: {
      range: { sheetId, startRowIndex: 1, endRowIndex: lastRow, startColumnIndex: 4, endColumnIndex: 5 },
      cell: { userEnteredFormat: { horizontalAlignment: 'CENTER' } },
      fields: 'userEnteredFormat.horizontalAlignment'
    }
  });
  requests.push({
    repeatCell: {
      range: { sheetId, startRowIndex: 1, endRowIndex: lastRow, startColumnIndex: 6, endColumnIndex: 7 },
      cell: { userEnteredFormat: { horizontalAlignment: 'CENTER', textFormat: { bold: true, fontFamily: font } } },
      fields: 'userEnteredFormat.horizontalAlignment,userEnteredFormat.textFormat'
    }
  });
  // Freeze header + filter
  requests.push({
    updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' }
  });
  requests.push({ setBasicFilter: { filter: { range: { sheetId, startRowIndex: 0, endRowIndex: lastRow, startColumnIndex: 0, endColumnIndex: 7 } } } });
  // Lebar kolom
  requests.push({ updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: 1 }, properties: { pixelSize: 160 }, fields: 'pixelSize' } });
  requests.push({ updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 1, endIndex: 3 }, properties: { pixelSize: 130 }, fields: 'pixelSize' } });
  requests.push({ updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 3, endIndex: 4 }, properties: { pixelSize: 130 }, fields: 'pixelSize' } });
  requests.push({ updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 4, endIndex: 5 }, properties: { pixelSize: 120 }, fields: 'pixelSize' } });
  requests.push({ updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 5, endIndex: 6 }, properties: { pixelSize: 170 }, fields: 'pixelSize' } });
  requests.push({ updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 6, endIndex: 7 }, properties: { pixelSize: 120 }, fields: 'pixelSize' } });
  // Border seluruh tabel
  requests.push({
    updateBorders: {
      range: { sheetId, startRowIndex: 0, endRowIndex: lastRow, startColumnIndex: 0, endColumnIndex: 7 },
      top: blackBorder, bottom: blackBorder, left: blackBorder, right: blackBorder, innerHorizontal: blackBorder, innerVertical: blackBorder
    }
  });

  try {
    await sheets.spreadsheets.batchUpdate({ spreadsheetId: ssId(), requestBody: { requests } });
  } catch (e) {
    logError('Gagal mempercantik sheet Langganan.', e);
  }
}

async function runDueLangganan(day, month, year) {
  const list = await getLangganan();
  const due = list.filter((l) => l.hari === day && l.nominal > 0);
  const posted = [];
  if (due.length === 0) return posted;

  await ensureHeader();
  const entries = await getAllEntries();

  for (const l of due) {
    const tag = `Langganan: ${l.nama}`;
    const exists = entries.some(
      (e) =>
        e.catatan &&
        e.catatan.toLowerCase() === tag.toLowerCase() &&
        e.parsedDate.month === month &&
        e.parsedDate.year === year
    );
    if (exists) continue;

    const tanggal = `${day}/${month}/${year}`;
    const nominalStr = 'Rp' + Math.round(l.nominal).toLocaleString('id-ID');
    const isIncome = l.jenis === 'pemasukan';
    await appendRow([
      tanggal,
      l.nama,
      normalizeCategory(l.kategori, l.jenis),
      isIncome ? '' : (l.toko || 'Lainnya'),
      isIncome ? nominalStr : '',
      isIncome ? '' : nominalStr,
      tag,
      'Langganan',
      'Kas'
    ]);
    posted.push(l);
  }

  if (posted.length > 0) {
    await formatSheetLayout();
    await updateAnalisaSheet();
  }
  return posted;
}

// ----- Hapus transaksi terakhir -----

async function deleteLastTransaction() {
  const sheetName = getSheetName();
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: ssId(),
    range: `'${sheetName}'!A:J`
  });
  const rows = res.data.values || [];
  if (rows.length <= 2) return null; // hanya judul + header
  const lastIndex = rows.length - 1;
  const last = rows[lastIndex];
  const sheetId = await getSheetIdByName(sheetName);
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: ssId(),
    requestBody: {
      requests: [{
        deleteDimension: {
          range: { sheetId, dimension: 'ROWS', startIndex: lastIndex, endIndex: lastIndex + 1 }
        }
      }]
    }
  });
  return {
    raw: last,
    tanggal: last[0] || '',
    item: last[1] || '',
    kategori: last[2] || '',
    toko: last[3] || '',
    pemasukan: parseRupiahTextToNumber(last[4] || ''),
    pengeluaran: parseRupiahTextToNumber(last[5] || ''),
    catatan: last[6] || '',
    id: last[9] || ''
  };
}

async function editLastTransaction(field, rawValue) {
  const sheetName = getSheetName();
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: ssId(),
    range: `'${sheetName}'!A:J`
  });
  const rows = res.data.values || [];
  if (rows.length <= 2) return null;

  const rowNum = rows.length; // baris terakhir (judul=1, header=2)
  const last = rows[rows.length - 1];
  const isIncome = parseRupiahTextToNumber(last[4] || '') > 0;
  const type = isIncome ? 'pemasukan' : 'pengeluaran';

  let col = null;
  let value = rawValue;

  if (/^item$/i.test(field)) {
    col = 'B';
    value = rawValue;
  } else if (/^kategori$/i.test(field)) {
    col = 'C';
    value = normalizeCategory(rawValue, type);
  } else if (/^toko$/i.test(field)) {
    col = 'D';
    value = rawValue;
  } else if (/^(nominal|jumlah|nilai)$/i.test(field)) {
    const amt = await parseMoneyText(rawValue);
    if (!amt) return { error: 'Nominal tidak valid.' };
    col = isIncome ? 'E' : 'F';
    value = amt;
  } else if (/^(catatan|note)$/i.test(field)) {
    col = 'G';
    value = rawValue;
  } else if (/^(akun|dompet)$/i.test(field)) {
    col = 'I';
    value = titleCase(rawValue);
  } else {
    return { error: 'Field tidak dikenal. Pilih: item / kategori / toko / nominal / catatan / akun.' };
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId: ssId(),
    range: `'${sheetName}'!${col}${rowNum}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[value]] }
  });

  return { field, value };
}

// ----- Hutang / Piutang -----

async function getHutang() {
  const sheetName = getHutangSheetName();
  await ensureSheetWithHeader(sheetName, ['Nama', 'Jenis', 'Nominal', 'Catatan', 'Tanggal']);
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: ssId(),
    range: `'${sheetName}'!A2:E`
  });
  const rows = res.data.values || [];
  const list = [];
  rows.forEach((r, i) => {
    const nama = (r[0] || '').trim();
    if (!nama) return;
    list.push({
      nama,
      jenis: (r[1] || '').trim(),
      nominal: parseRupiahTextToNumber(r[2] || ''),
      catatan: (r[3] || '').trim(),
      tanggal: (r[4] || '').trim(),
      rowNum: i + 2
    });
  });
  return list;
}

async function addHutang(jenis, nama, nominal, catatan) {
  const sheetName = getHutangSheetName();
  await ensureSheetWithHeader(sheetName, ['Nama', 'Jenis', 'Nominal', 'Catatan', 'Tanggal']);
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });
  const tanggal = new Date().toLocaleDateString('id-ID', { timeZone: getTimezone() });
  await sheets.spreadsheets.values.append({
    spreadsheetId: ssId(),
    range: `'${sheetName}'!A:E`,
    valueInputOption: 'RAW',
    requestBody: { values: [[nama, jenis, nominal, catatan || '', tanggal]] }
  });
}

async function deleteHutangByName(nama) {
  const sheetName = getHutangSheetName();
  const list = await getHutang();
  const matched = list.filter((h) => h.nama.toLowerCase() === nama.toLowerCase());
  if (matched.length === 0) return 0;
  const sheetId = await getSheetIdByName(sheetName);
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });
  // Hapus dari baris terbawah agar index tidak bergeser.
  const requests = matched
    .sort((a, b) => b.rowNum - a.rowNum)
    .map((h) => ({
      deleteDimension: {
        range: { sheetId, dimension: 'ROWS', startIndex: h.rowNum - 1, endIndex: h.rowNum }
      }
    }));
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: ssId(),
    requestBody: { requests }
  });
  return matched.length;
}

// ----- Neraca (balance sheet): aset & liabilitas + akun otomatis -----

const NERACA_HEADER = ['Tipe', 'Nama', 'Nilai', 'Sumber'];

function neracaTipeOf(raw) {
  return /liab|kewajiban|utang|hutang/.test(String(raw || '').toLowerCase())
    ? 'Liabilitas'
    : 'Aset';
}

async function getNeraca() {
  const sheetName = getNeracaSheetName();
  await ensureSheetWithHeader(sheetName, NERACA_HEADER);
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: ssId(),
    range: `'${sheetName}'!A2:D`
  });
  const rows = res.data.values || [];
  const list = [];
  rows.forEach((r, i) => {
    const nama = (r[1] || '').trim();
    if (!nama) return;
    list.push({
      tipe: neracaTipeOf(r[0]),
      nama,
      nilai: parseRupiahTextToNumber(r[2] || ''),
      sumber: (r[3] || '').trim().toLowerCase() === 'auto' ? 'auto' : 'manual',
      rowNum: i + 2
    });
  });
  return list;
}

// Perbarui saldo tiap akun (otomatis) sebagai aset; baris manual dipertahankan.
async function refreshAccounts(entries) {
  const sheetName = getNeracaSheetName();
  await ensureSheetWithHeader(sheetName, NERACA_HEADER);
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });

  const net = {};
  for (const e of entries) {
    const a = e.akun || 'Kas';
    net[a] = (net[a] || 0) + e.pemasukan - e.pengeluaran;
  }
  if (!('Kas' in net)) net['Kas'] = 0;

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: ssId(),
    range: `'${sheetName}'!A2:D`
  });
  const rows = res.data.values || [];

  const accNamesLower = new Set(Object.keys(net).map((n) => n.toLowerCase()));
  const manualRows = rows
    .filter((r) => (r[1] || '').trim())
    .filter((r) => (r[3] || '').trim().toLowerCase() !== 'auto')
    .filter((r) => !accNamesLower.has((r[1] || '').trim().toLowerCase()))
    .map((r) => [neracaTipeOf(r[0]), (r[1] || '').trim(), parseRupiahTextToNumber(r[2] || ''), 'manual']);

  const autoRows = Object.keys(net)
    .sort((a, b) => (a === 'Kas' ? -1 : b === 'Kas' ? 1 : a.localeCompare(b)))
    .map((acc) => ['Aset', acc, Math.round(net[acc]), 'auto']);

  const newData = [...autoRows, ...manualRows];

  await sheets.spreadsheets.values.clear({
    spreadsheetId: ssId(),
    range: `'${sheetName}'!A2:D1000`
  });
  if (newData.length > 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: ssId(),
      range: `'${sheetName}'!A2`,
      valueInputOption: 'RAW',
      requestBody: { values: newData }
    });
  }
}

async function addNeracaItem(tipe, nama, nilai) {
  const sheetName = getNeracaSheetName();
  await ensureSheetWithHeader(sheetName, NERACA_HEADER);
  const canonTipe = tipe === 'Liabilitas' ? 'Liabilitas' : 'Aset';
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: ssId(),
    range: `'${sheetName}'!A2:D`
  });
  const rows = res.data.values || [];
  let foundRow = -1;
  for (let i = 0; i < rows.length; i++) {
    if (
      neracaTipeOf(rows[i][0]) === canonTipe &&
      (rows[i][1] || '').trim().toLowerCase() === nama.toLowerCase() &&
      (rows[i][3] || '').trim().toLowerCase() !== 'auto'
    ) {
      foundRow = i;
      break;
    }
  }
  if (foundRow >= 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: ssId(),
      range: `'${sheetName}'!A${foundRow + 2}:D${foundRow + 2}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[canonTipe, nama, Math.round(nilai), 'manual']] }
    });
  } else {
    await sheets.spreadsheets.values.append({
      spreadsheetId: ssId(),
      range: `'${sheetName}'!A:D`,
      valueInputOption: 'RAW',
      requestBody: { values: [[canonTipe, nama, Math.round(nilai), 'manual']] }
    });
  }
  return canonTipe;
}

async function deleteNeracaItem(tipe, nama) {
  const sheetName = getNeracaSheetName();
  const canonTipe = tipe === 'Liabilitas' ? 'Liabilitas' : 'Aset';
  const list = await getNeraca();
  const found = list.find(
    (x) => x.tipe === canonTipe && x.nama.toLowerCase() === nama.toLowerCase() && x.sumber !== 'auto'
  );
  if (!found) return false;
  const sheetId = await getSheetIdByName(sheetName);
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: ssId(),
    requestBody: {
      requests: [{
        deleteDimension: {
          range: { sheetId, dimension: 'ROWS', startIndex: found.rowNum - 1, endIndex: found.rowNum }
        }
      }]
    }
  });
  return true;
}

async function getChartIds(sheets, sheetId) {
  try {
    const meta = await sheets.spreadsheets.get({
      spreadsheetId: ssId(),
      fields: 'sheets(properties/sheetId,charts/chartId)'
    });
    const t = (meta.data.sheets || []).find((s) => s.properties.sheetId === sheetId);
    return ((t && t.charts) || []).map((c) => c.chartId);
  } catch (e) {
    logError('Gagal baca chart.', e);
    return [];
  }
}

function getSheetFont() {
  return config.sheetFont || 'Roboto';
}

// Percantik sheet Neraca + grafik Aset/Liabilitas/Ekuitas.
async function formatNeracaSheet() {
  const sheetName = getNeracaSheetName();
  const sheetId = await getSheetIdByName(sheetName);
  if (sheetId == null) return;
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });

  const list = await getNeraca();
  const lastRow = Math.max(list.length + 1, 2);
  let totalAset = 0;
  let totalLiab = 0;
  for (const x of list) {
    if (x.tipe === 'Liabilitas') totalLiab += x.nilai;
    else totalAset += x.nilai;
  }
  const ekuitas = totalAset - totalLiab;

  // Blok ringkasan di kanan (F1:G4) sebagai sumber grafik.
  await sheets.spreadsheets.values.update({
    spreadsheetId: ssId(),
    range: `'${sheetName}'!F1:G4`,
    valueInputOption: 'RAW',
    requestBody: {
      values: [
        ['Ringkasan', ''],
        ['Total Aset', Math.round(totalAset)],
        ['Total Liabilitas', Math.round(totalLiab)],
        ['Ekuitas', Math.round(ekuitas)]
      ]
    }
  });

  const font = getSheetFont();
  const currency = { numberFormat: { type: 'CURRENCY', pattern: '"Rp"#,##0' } };
  const existing = await getChartIds(sheets, sheetId);
  const requests = [];

  for (const id of existing) requests.push({ deleteEmbeddedObject: { objectId: id } });

  // Font ke seluruh area
  requests.push({
    repeatCell: {
      range: { sheetId, startRowIndex: 0, endRowIndex: lastRow, startColumnIndex: 0, endColumnIndex: 7 },
      cell: { userEnteredFormat: { textFormat: { fontFamily: font } } },
      fields: 'userEnteredFormat.textFormat.fontFamily'
    }
  });
  // Header A1:D1
  requests.push({
    repeatCell: {
      range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 4 },
      cell: {
        userEnteredFormat: {
          backgroundColor: { red: 0.18, green: 0.49, blue: 0.36 },
          textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 }, fontFamily: font },
          horizontalAlignment: 'CENTER'
        }
      },
      fields: 'userEnteredFormat.backgroundColor,userEnteredFormat.textFormat,userEnteredFormat.horizontalAlignment'
    }
  });
  // Ringkasan F1 header style
  requests.push({
    repeatCell: {
      range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 5, endColumnIndex: 7 },
      cell: {
        userEnteredFormat: {
          backgroundColor: { red: 0.85, green: 0.93, blue: 0.87 },
          textFormat: { bold: true, fontFamily: font }
        }
      },
      fields: 'userEnteredFormat.backgroundColor,userEnteredFormat.textFormat'
    }
  });
  // Currency: kolom C (nilai) & G (ringkasan)
  requests.push({
    repeatCell: {
      range: { sheetId, startRowIndex: 1, endRowIndex: lastRow, startColumnIndex: 2, endColumnIndex: 3 },
      cell: { userEnteredFormat: currency },
      fields: 'userEnteredFormat.numberFormat'
    }
  });
  requests.push({
    repeatCell: {
      range: { sheetId, startRowIndex: 1, endRowIndex: 4, startColumnIndex: 6, endColumnIndex: 7 },
      cell: { userEnteredFormat: currency },
      fields: 'userEnteredFormat.numberFormat'
    }
  });
  // Freeze header + lebar kolom
  requests.push({
    updateSheetProperties: {
      properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
      fields: 'gridProperties.frozenRowCount'
    }
  });
  requests.push({ updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: 1 }, properties: { pixelSize: 110 }, fields: 'pixelSize' } });
  requests.push({ updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 1, endIndex: 2 }, properties: { pixelSize: 170 }, fields: 'pixelSize' } });
  requests.push({ updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 2, endIndex: 3 }, properties: { pixelSize: 140 }, fields: 'pixelSize' } });
  requests.push({ updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 5, endIndex: 7 }, properties: { pixelSize: 140 }, fields: 'pixelSize' } });

  // Grafik kolom: Aset vs Liabilitas vs Ekuitas
  requests.push({
    addChart: {
      chart: {
        spec: {
          title: 'Aset vs Liabilitas vs Ekuitas',
          basicChart: {
            chartType: 'COLUMN',
            legendPosition: 'NO_LEGEND',
            domains: [{ domain: { sourceRange: { sources: [{ sheetId, startRowIndex: 1, endRowIndex: 4, startColumnIndex: 5, endColumnIndex: 6 }] } } }],
            series: [{ series: { sourceRange: { sources: [{ sheetId, startRowIndex: 1, endRowIndex: 4, startColumnIndex: 6, endColumnIndex: 7 }] } } }]
          }
        },
        position: {
          overlayPosition: {
            anchorCell: { sheetId, rowIndex: 5, columnIndex: 5 },
            offsetXPixels: 5, offsetYPixels: 5, widthPixels: 460, heightPixels: 300
          }
        }
      }
    }
  });

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: ssId(),
    requestBody: { requests }
  });

  if (config.neracaImageUrl) {
    try {
      await sheets.spreadsheets.values.update({
        spreadsheetId: ssId(),
        range: `'${sheetName}'!I1`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[`=IMAGE("${config.neracaImageUrl}")`]] }
      });
    } catch (e) { logError('Gagal pasang gambar neraca.', e); }
  }
}

// ----- Laporan bulanan (perbandingan, proyeksi, top, anomali) -----

async function buildMonthlyReport(month, year) {
  const entries = await getAllEntries();
  const monthEntries = entries.filter(
    (e) => e.parsedDate.month === month && e.parsedDate.year === year
  );

  let income = 0;
  let expense = 0;
  const perKat = {};
  const perDay = {};
  for (const e of monthEntries) {
    income += e.pemasukan;
    expense += e.pengeluaran;
    if (e.pengeluaran > 0) {
      const k = normalizeCategory(e.kategori, 'pengeluaran');
      perKat[k] = (perKat[k] || 0) + e.pengeluaran;
      perDay[e.parsedDate.day] = (perDay[e.parsedDate.day] || 0) + e.pengeluaran;
    }
  }

  let lm = month - 1;
  let ly = year;
  if (lm < 1) { lm = 12; ly -= 1; }
  const lastExpense = entries
    .filter((e) => e.parsedDate.month === lm && e.parsedDate.year === ly)
    .reduce((s, e) => s + e.pengeluaran, 0);

  const top = Object.entries(perKat).sort((a, b) => b[1] - a[1]).slice(0, 3);

  const tz = getTimezone();
  const now = new Date();
  const curMonth = Number(now.toLocaleDateString('en-US', { timeZone: tz, month: 'numeric' }));
  const curYear = Number(now.toLocaleDateString('en-US', { timeZone: tz, year: 'numeric' }));
  const curDay = Number(now.toLocaleDateString('en-US', { timeZone: tz, day: 'numeric' }));
  const daysInMonth = new Date(year, month, 0).getDate();
  const isCurrentMonth = month === curMonth && year === curYear;

  let projection = null;
  if (isCurrentMonth && curDay > 0) {
    projection = Math.round((expense / curDay) * daysInMonth);
  }

  let anomaly = null;
  const activeDays = Object.keys(perDay).length || 1;
  const avgDaily = expense / activeDays;
  if (isCurrentMonth) {
    const todaySpent = perDay[curDay] || 0;
    if (avgDaily > 0 && todaySpent > avgDaily * 2) {
      anomaly = `Pengeluaran hari ini (${formatRupiah(todaySpent)}) sekitar ${(todaySpent / avgDaily).toFixed(1)}x rata-rata harian.`;
    }
  }

  return {
    income,
    expense,
    saldo: income - expense,
    perKat,
    top,
    lastExpense,
    projection,
    anomaly,
    count: monthEntries.length
  };
}

function quickChartUrl(chartConfig) {
  return (
    'https://quickchart.io/chart?w=500&h=320&bkg=white&c=' +
    encodeURIComponent(JSON.stringify(chartConfig))
  );
}

// ----- Transkripsi suara (voice note) -> teks -----

async function transcribeAudio(buffer, filename) {
  const apiKey = config.openaiApiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('Transkripsi suara butuh openaiApiKey di rekap.json');
  }
  const baseUrl = (config.openaiBaseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const model = config.sttModel || 'whisper-1';

  const form = new FormData();
  form.append('file', new Blob([buffer]), filename);
  form.append('model', model);

  const res = await fetch(`${baseUrl}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`STT error ${res.status}: ${detail.slice(0, 200)}`);
  }

  const data = await res.json();
  return (data && data.text) || '';
}

async function getUsdtToIdrRate() {
  const res = await fetch(
    'https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=idr'
  );

  if (!res.ok) {
    throw new Error('Gagal ambil kurs USDT ke IDR');
  }

  const data = await res.json();
  const rate = data?.tether?.idr;

  if (!rate) {
    throw new Error('Kurs USDT ke IDR tidak ditemukan');
  }

  return Number(rate);
}

async function getUsdToIdrRate() {
  const res = await fetch(
    'https://api.coingecko.com/api/v3/simple/price?ids=usd-coin&vs_currencies=idr'
  );

  if (!res.ok) {
    throw new Error('Gagal ambil kurs USD ke IDR');
  }

  const data = await res.json();
  const rate = data?.['usd-coin']?.idr;

  if (!rate) {
    throw new Error('Kurs USD ke IDR tidak ditemukan');
  }

  return Number(rate);
}

function parseLocalizedNumber(input) {
  let raw = String(input).trim();

  const hasComma = raw.includes(',');
  const hasDot = raw.includes('.');

  if (hasComma && hasDot) {
    if (raw.lastIndexOf(',') > raw.lastIndexOf('.')) {
      raw = raw.replace(/\./g, '').replace(',', '.');
    } else {
      raw = raw.replace(/,/g, '');
    }
  } else if (hasComma) {
    if (/^\d+,\d+$/.test(raw)) {
      raw = raw.replace(',', '.');
    } else {
      raw = raw.replace(/,/g, '');
    }
  } else if (hasDot) {
    if (/^\d{1,3}(\.\d{3})+$/.test(raw)) {
      raw = raw.replace(/\./g, '');
    }
  }

  const n = Number(raw);
  if (isNaN(n) || n <= 0) return null;
  return n;
}

async function parseMoneyText(input) {
  let s = String(input).trim().replace(/\s+/g, ' ');
  let lower = s.toLowerCase();

  if (lower.includes('usdt')) {
    const cleaned = s.replace(/usdt/ig, '').trim();
    const amount = parseLocalizedNumber(cleaned);
    if (!amount) return null;

    const rate = await getUsdtToIdrRate();
    const converted = Math.round(amount * rate);

    return 'Rp' + converted.toLocaleString('id-ID');
  }

  if (lower.includes('usd')) {
    const cleaned = s.replace(/usd/ig, '').trim();
    const amount = parseLocalizedNumber(cleaned);
    if (!amount) return null;

    const rate = await getUsdToIdrRate();
    const converted = Math.round(amount * rate);

    return 'Rp' + converted.toLocaleString('id-ID');
  }

  if (s.includes('$')) {
    const cleaned = s.replace(/\$/g, '').trim();
    const amount = parseLocalizedNumber(cleaned);
    if (!amount) return null;

    const rate = await getUsdToIdrRate();
    const converted = Math.round(amount * rate);

    return 'Rp' + converted.toLocaleString('id-ID');
  }

  if (/^rp\s*/i.test(s) || /\bidr\b/i.test(lower)) {
    s = s.replace(/\bidr\b/ig, '').replace(/^rp\s*/i, '').trim();
  }

  let raw = s.toLowerCase();
  let multiplier = 1;

  if (raw.endsWith(' juta')) {
    multiplier = 1000000;
    raw = raw.replace(/ juta$/, '');
  } else if (raw.endsWith('jt')) {
    multiplier = 1000000;
    raw = raw.replace(/jt$/, '');
  } else if (raw.endsWith(' ribu')) {
    multiplier = 1000;
    raw = raw.replace(/ ribu$/, '');
  } else if (raw.endsWith('rb')) {
    multiplier = 1000;
    raw = raw.replace(/rb$/, '');
  } else if (raw.endsWith('k')) {
    multiplier = 1000;
    raw = raw.replace(/k$/, '');
  }

  const n = parseLocalizedNumber(raw);
  if (!n) return null;

  const finalAmount = Math.round(n * multiplier);
  return 'Rp' + finalAmount.toLocaleString('id-ID');
}

function extractLabeledField(text, key) {
  // Ambil nilai "key=..." (atau "key:...") sampai ketemu label lain atau akhir.
  const re = new RegExp(
    `\\b${key}\\s*[:=]\\s*(.+?)(?=\\s+(?:toko|kategori)\\s*[:=]|$)`,
    'i'
  );
  const m = text.match(re);
  return m ? m[1].trim() : '';
}

function extractAkunToken(text) {
  // Mendukung "pakai gopay", "pake bank bca", "akun=ovo", "dompet kas"
  const re = /\b(?:pakai|pake|dompet|akun)\s*[:=]?\s*(.+?)(?=\s+di\s+|$)/i;
  const m = text.match(re);
  if (!m || !m[1].trim()) return { akun: '', rest: text };
  const akun = titleCase(m[1].trim());
  const rest = (text.slice(0, m.index) + ' ' + text.slice(m.index + m[0].length))
    .replace(/\s+/g, ' ')
    .trim();
  return { akun, rest };
}

function extractDateToken(text) {
  // Mendukung "tgl 5", "tgl 5/6", "tanggal 5/6/2026"
  const re = /\b(?:tgl|tanggal)\s+(\d{1,2})(?:[\/-](\d{1,2}))?(?:[\/-](\d{2,4}))?\b/i;
  const m = text.match(re);
  if (!m) return { dateStr: '', rest: text };

  const tz = getTimezone();
  const now = new Date();
  const curMonth = Number(now.toLocaleDateString('en-US', { timeZone: tz, month: 'numeric' }));
  const curYear = Number(now.toLocaleDateString('en-US', { timeZone: tz, year: 'numeric' }));

  const d = Number(m[1]);
  const mo = m[2] ? Number(m[2]) : curMonth;
  let y = m[3] ? Number(m[3]) : curYear;
  if (y < 100) y += 2000;

  if (d < 1 || d > 31 || mo < 1 || mo > 12) return { dateStr: '', rest: text };

  const dateStr = `${d}/${mo}/${y}`;
  const rest = (text.slice(0, m.index) + ' ' + text.slice(m.index + m[0].length))
    .replace(/\s+/g, ' ')
    .trim();
  return { dateStr, rest };
}

async function parseTransaction(text) {
  let raw = text.replace(/\s+/g, ' ').trim();

  // Ekstrak catatan opsional setelah tanda '#'
  let catatan = '';
  const noteIdx = raw.indexOf('#');
  if (noteIdx !== -1) {
    catatan = raw.slice(noteIdx + 1).trim();
    raw = raw.slice(0, noteIdx).trim();
  }

  // Ekstrak akun/dompet opsional ("pakai gopay", "akun=bank bca")
  const akunInfo = extractAkunToken(raw);
  const akun = akunInfo.akun;
  raw = akunInfo.rest;

  // Ekstrak tanggal opsional ("tgl 5", "tanggal 5/6/2026")
  const dateInfo = extractDateToken(raw);
  const tanggal = dateInfo.dateStr;
  raw = dateInfo.rest;

  const typeMatch = raw.match(/^(masuk|keluar)\b\s*/i);
  if (!typeMatch) return null;

  const type =
    typeMatch[1].toLowerCase() === 'masuk' ? 'pemasukan' : 'pengeluaran';
  const body = raw.slice(typeMatch[0].length).trim();

  if (!body) return null;

  // Format berlabel: "keluar toko=warung Agam kategori=makan 318000"
  if (/\b(?:toko|kategori)\s*[:=]/i.test(body)) {
    const amountRe =
      /\s+((?:rp\s*)?\$?\d[\d.,]*\s*(?:k|rb|ribu|jt|juta|idr|rp|usd|usdt)?)\s*$/i;
    const amountMatch = body.match(amountRe);
    if (!amountMatch) return null;

    const amountText = await parseMoneyText(amountMatch[1].trim());
    if (!amountText) return null;

    const fields = body.slice(0, amountMatch.index).trim();
    const toko = extractLabeledField(fields, 'toko');
    const category = extractLabeledField(fields, 'kategori');

    if (!category && !toko) return null;

    return {
      type,
      item: (category || '').trim(),
      category: normalizeCategory(category, type),
      toko: type === 'pemasukan' ? '' : (toko || 'Lainnya'),
      catatan,
      tanggal,
      akun,
      amountText
    };
  }

  // Format sederhana / posisi:
  // "keluar makan 100000"               -> kategori=makan, toko=Lainnya
  // "keluar makan 100000 di warung agam" -> kategori=makan, toko=warung agam
  // "keluar 29k rokok"                  -> kategori=rokok, toko=Lainnya (format lama)
  const AMOUNT =
    '(?:rp\\s*)?\\$?[\\d.,]+(?:\\s*(?:k|rb|ribu|jt|juta|idr|rp|usd|usdt))?';

  // Kategori dulu, lalu nominal, opsional "di <toko>"
  const categoryFirst = new RegExp(
    `^(.+?)\\s+(${AMOUNT})(?:\\s+di\\s+(.+))?$`,
    'i'
  );
  // Nominal dulu, lalu kategori (format lama)
  const amountFirst = new RegExp(`^(${AMOUNT})\\s+(.+)$`, 'i');

  let category = '';
  let toko = '';
  let amountTextRaw = '';

  const m1 = body.match(categoryFirst);
  if (m1) {
    category = m1[1].trim();
    amountTextRaw = m1[2].trim();
    toko = (m1[3] || '').trim();
  } else {
    const m2 = body.match(amountFirst);
    if (!m2) return null;
    amountTextRaw = m2[1].trim();
    category = m2[2].trim();
  }

  const amountText = await parseMoneyText(amountTextRaw);
  if (!category || !amountText) return null;

  return {
    type,
    item: category.trim(),
    category: normalizeCategory(category, type),
    toko: type === 'pemasukan' ? '' : (toko || 'Lainnya'),
    catatan,
    tanggal,
    akun,
    amountText
  };
}

// ===========================================================================
// MULTI-TENANT: pemetaan user -> spreadsheet, masa aktif, & perintah admin
// ===========================================================================

const DEFAULT_GROUP_LINK = 'https://t.me/+D5IRzFMN2mM5NzM1';
const PELANGGAN_HEADER = [
  'Telegram ID', 'Nama', 'Email', 'Spreadsheet ID', 'Sheet Name', 'Paket', 'Aktif Sampai'
];
const _tenantCache = new Map(); // userId -> { tenant, ts }
const TENANT_TTL_MS = 60 * 1000;

function masterSheetName() {
  return config.pelangganSheetName || 'Pelanggan';
}

function getAdminIds() {
  const ids = [];
  if (config.ownerUserId != null) ids.push(String(config.ownerUserId).trim());
  const a = config.adminUserIds;
  if (Array.isArray(a)) for (const x of a) ids.push(String(x).trim());
  else if (typeof a === 'string') for (const x of a.split(',')) { const t = x.trim(); if (t) ids.push(t); }
  return Array.from(new Set(ids.filter(Boolean)));
}

function isAdmin(ctx) {
  return getAdminIds().includes(String(ctx.from?.id || '').trim());
}

function groupLink() {
  return config.groupLink || DEFAULT_GROUP_LINK;
}

async function ensureMasterPelanggan() {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });
  const name = masterSheetName();
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: masterId(),
    fields: 'sheets(properties(title))'
  });
  const exists = (meta.data.sheets || []).some((s) => s.properties.title === name);
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: masterId(),
      requestBody: { requests: [{ addSheet: { properties: { title: name } } }] }
    });
  }
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: masterId(),
    range: `'${name}'!A1:G1`
  });
  const cur = (res.data.values && res.data.values[0]) || [];
  if (PELANGGAN_HEADER.some((h, i) => cur[i] !== h)) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: masterId(),
      range: `'${name}'!A1:G1`,
      valueInputOption: 'RAW',
      requestBody: { values: [PELANGGAN_HEADER] }
    });
  }
}

async function readPelanggan() {
  await ensureMasterPelanggan();
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: masterId(),
    range: `'${masterSheetName()}'!A2:G`
  });
  const rows = res.data.values || [];
  const list = [];
  rows.forEach((r, i) => {
    const id = (r[0] || '').trim();
    if (!id) return;
    list.push({
      userId: id,
      nama: (r[1] || '').trim(),
      email: (r[2] || '').trim(),
      spreadsheetId: (r[3] || '').trim(),
      sheetName: (r[4] || '').trim() || config.sheetName || 'Sheet1',
      paket: (r[5] || '').trim(),
      aktifSampai: (r[6] || '').trim(),
      rowNum: i + 2
    });
  });
  return list;
}

function isLifetime(s) {
  return /lifetime|seumur|selamanya|unlimited/i.test(String(s || '')) || String(s || '').trim() === '-';
}

function tenantActive(t) {
  if (!t || !t.spreadsheetId) return false;
  if (isLifetime(t.aktifSampai)) return true;
  const raw = (t.aktifSampai || '').trim();
  let exp = null;
  let m = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) exp = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  else if ((m = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) exp = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
  if (!exp) return false;
  const tz = getTimezone();
  const now = new Date();
  const td = new Date(
    Number(now.toLocaleDateString('en-US', { timeZone: tz, year: 'numeric' })),
    Number(now.toLocaleDateString('en-US', { timeZone: tz, month: 'numeric' })) - 1,
    Number(now.toLocaleDateString('en-US', { timeZone: tz, day: 'numeric' }))
  );
  return exp >= td;
}

async function resolveTenant(userId) {
  const cached = _tenantCache.get(userId);
  if (cached && Date.now() - cached.ts < TENANT_TTL_MS) return cached.tenant;
  const list = await readPelanggan();
  const found = list.find((x) => x.userId === userId) || null;
  _tenantCache.set(userId, { tenant: found, ts: Date.now() });
  return found;
}

async function getActiveTenants() {
  const list = await readPelanggan();
  return list.filter(tenantActive);
}

async function upsertPelanggan(obj) {
  await ensureMasterPelanggan();
  const list = await readPelanggan();
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });
  const found = list.find((x) => x.userId === String(obj.userId).trim());
  const row = [
    String(obj.userId).trim(),
    obj.nama || '',
    obj.email || '',
    obj.spreadsheetId || '',
    obj.sheetName || (config.sheetName || 'Sheet1'),
    obj.paket || '',
    obj.aktifSampai || 'lifetime'
  ];
  if (found) {
    // Pertahankan nilai lama bila field baru kosong.
    row[1] = obj.nama || found.nama;
    row[2] = obj.email || found.email;
    row[3] = obj.spreadsheetId || found.spreadsheetId;
    row[4] = obj.sheetName || found.sheetName;
    row[5] = obj.paket || found.paket;
    row[6] = obj.aktifSampai || found.aktifSampai;
    await sheets.spreadsheets.values.update({
      spreadsheetId: masterId(),
      range: `'${masterSheetName()}'!A${found.rowNum}:G${found.rowNum}`,
      valueInputOption: 'RAW',
      requestBody: { values: [row] }
    });
  } else {
    await sheets.spreadsheets.values.append({
      spreadsheetId: masterId(),
      range: `'${masterSheetName()}'!A:G`,
      valueInputOption: 'RAW',
      requestBody: { values: [row] }
    });
  }
  _tenantCache.delete(String(obj.userId).trim());
  return !!found;
}

async function deletePelanggan(userId) {
  const list = await readPelanggan();
  const found = list.find((x) => x.userId === String(userId).trim());
  if (!found) return false;
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: masterId(),
    fields: 'sheets(properties(sheetId,title))'
  });
  const sh = (meta.data.sheets || []).find((s) => s.properties.title === masterSheetName());
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: masterId(),
    requestBody: {
      requests: [{
        deleteDimension: {
          range: { sheetId: sh.properties.sheetId, dimension: 'ROWS', startIndex: found.rowNum - 1, endIndex: found.rowNum }
        }
      }]
    }
  });
  _tenantCache.delete(String(userId).trim());
  return true;
}

// ---- Perintah admin (hanya untuk getAdminIds) ----

// Tampilkan email service account — yang HARUS di-share (Editor) ke tiap
// spreadsheet (master, template, & sheet pelanggan).
bot.command('saemail', async (ctx) => {
  try {
    if (!isAdmin(ctx)) return;
    const credFile = config.credentialsFile || './rekap-credentials.json';
    let email = '(tidak terbaca)';
    try { email = JSON.parse(fs.readFileSync(credFile, 'utf8')).client_email || email; } catch (_) {}
    return ctx.reply(
      '🔑 Email service account:\n' + email + '\n\n' +
      'Pastikan email ini sudah di-Share sebagai *Editor* di:\n' +
      '• Spreadsheet master\n• Spreadsheet template\n• Tiap spreadsheet pelanggan\n\n' +
      'Error 403 "caller does not have permission" = email ini belum jadi Editor ' +
      'di spreadsheet yang diakses.',
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    logError('Gagal /saemail.', err);
    return ctx.reply('Gagal membaca email service account.');
  }
});

bot.command('daftar', async (ctx) => {
  try {
    if (!isAdmin(ctx)) return;
    const arg = (ctx.message.text || '').replace(/^\/daftar(@\S+)?\s*/i, '').trim();
    const p = arg.split(';').map((s) => s.trim());
    if (p.length < 4) {
      return ctx.reply(
        'Format:\n/daftar TelegramID; Nama; Email; SpreadsheetID; [AktifSampai]; [SheetName]\n\n' +
        'Contoh:\n/daftar 356841296; Budi; budi@gmail.com; 1AbC...XyZ; 31/12/2026; Rekap\n' +
        '(AktifSampai kosong = lifetime)'
      );
    }
    await upsertPelanggan({
      userId: p[0], nama: p[1], email: p[2], spreadsheetId: p[3],
      aktifSampai: p[4] || 'lifetime', sheetName: p[5] || ''
    });
    return ctx.reply(`Pelanggan tersimpan ✅\n${p[1]} (${p[0]})\nAktif: ${p[4] || 'lifetime'}`);
  } catch (err) {
    logError('Gagal /daftar.', err);
    return ctx.reply('Gagal mendaftarkan pelanggan.');
  }
});

// Onboarding OTOMATIS: buat spreadsheet pelanggan dari template, bagikan ke
// email-nya, lalu daftarkan ke sheet Pelanggan — semua dalam satu perintah.
bot.command('buatkan', async (ctx) => {
  try {
    if (!isAdmin(ctx)) return;
    const arg = (ctx.message.text || '').replace(/^\/buatkan(@\S+)?\s*/i, '').trim();
    const p = arg.split(';').map((s) => s.trim());
    if (p.length < 3 || !p[0] || !p[1] || !p[2]) {
      return ctx.reply(
        'Format:\n/buatkan TelegramID; Nama; Email; [AktifSampai]; [SheetName]\n\n' +
        'Contoh:\n/buatkan 356841296; Budi; budi@gmail.com; 31/12/2026\n' +
        '(AktifSampai kosong = lifetime)\n\n' +
        'Bot akan otomatis menyalin spreadsheet template, membagikannya ke email ' +
        'pelanggan, lalu mendaftarkannya. Pastikan templateSpreadsheetId sudah ' +
        'diisi di rekap.json & Google Drive API aktif.'
      );
    }
    const templateId = config.templateSpreadsheetId;
    if (!templateId) {
      return ctx.reply(
        '⚠️ templateSpreadsheetId belum diisi di rekap.json.\n\n' +
        'Isi dengan ID spreadsheet TEMPLATE (yang sudah berisi sheet Rekap dll), ' +
        'dan jadikan service account sebagai Editor di template itu. ' +
        'Atau pakai cara manual: /daftar.'
      );
    }

    const userId = p[0];
    const nama = p[1];
    const email = p[2];
    const aktifSampai = p[3] || 'lifetime';
    let sheetName = p[4] || ''; // bila kosong, dideteksi dari template setelah disalin

    await ctx.reply('⏳ Membuat spreadsheet & membagikan ke ' + email + ' ...');

    const dClient = await driveAuth.getClient();
    const drive = google.drive({ version: 'v3', auth: dClient });

    // 1) Salin template → spreadsheet baru (nama file = nama lengkap user).
    const copyBody = { name: nama };
    if (config.sharedDriveId) copyBody.parents = [config.sharedDriveId];
    const copy = await drive.files.copy({
      fileId: templateId,
      supportsAllDrives: true,
      requestBody: copyBody,
    });
    const newId = copy.data.id;

    // 1b) Tentukan nama tab transaksi agar cocok dengan isi template.
    if (!sheetName) {
      try {
        const sClient = await auth.getClient();
        const sApi = google.sheets({ version: 'v4', auth: sClient });
        const sMeta = await sApi.spreadsheets.get({ spreadsheetId: newId, fields: 'sheets(properties(title,index))' });
        const titles = (sMeta.data.sheets || []).map((s) => s.properties.title);
        const preferred = config.sheetName || 'Rekap';
        sheetName = titles.includes(preferred) ? preferred : (titles[0] || preferred);
      } catch (e) {
        sheetName = config.sheetName || 'Rekap';
      }
    }

    // 2) Bagikan ke email pelanggan sebagai Editor.
    await drive.permissions.create({
      fileId: newId,
      sendNotificationEmail: true,
      supportsAllDrives: true,
      requestBody: { type: 'user', role: 'writer', emailAddress: email },
    });

    // 3) Daftarkan ke sheet Pelanggan.
    await upsertPelanggan({ userId, nama, email, spreadsheetId: newId, aktifSampai, sheetName });

    const link = 'https://docs.google.com/spreadsheets/d/' + newId + '/edit';
    return ctx.reply(
      'Beres! ✅ Pelanggan siap pakai.\n\n' +
      `👤 ${nama} (${userId})\n` +
      `📧 ${email} (diundang sebagai Editor)\n` +
      `📊 Sheet: ${link}\n` +
      `🗓️ Aktif: ${aktifSampai}\n\n` +
      'Minta pelanggan buka bot ini lalu ketik /start. Kalau mereka belum ' +
      'pernah chat, ID Telegram-nya bisa dicek saat mereka kirim pesan pertama.'
    );
  } catch (err) {
    logError('Gagal /buatkan.', err);
    // Ambil pesan error asli dari Google API (paling informatif untuk diagnosa).
    let detail = String((err && err.message) || '');
    try {
      const apiErr = err && err.response && err.response.data && err.response.data.error;
      if (apiErr && apiErr.message) detail = apiErr.message;
      else if (err && Array.isArray(err.errors) && err.errors[0] && err.errors[0].message) detail = err.errors[0].message;
    } catch (_) {}
    const detailLine = detail ? `\n\n🔎 Detail: ${detail.slice(0, 300)}` : '';

    if (/storageQuota/i.test(detail)) {
      return ctx.reply(
        '❌ Gagal: service account kena limit penyimpanan Drive ' +
        '(storageQuotaExceeded).\n\nSolusi:\n' +
        '• Isi sharedDriveId di rekap.json (pakai Shared Drive), ATAU\n' +
        '• Salin template manual di Google Drive, share ke email pelanggan, ' +
        'lalu daftarkan dengan /daftar.' + detailLine
      );
    }
    if (/has not been used in project|accessNotConfigured|SERVICE_DISABLED|Drive API/i.test(detail)) {
      return ctx.reply(
        '❌ Google Drive API belum aktif untuk project service account-mu.\n\n' +
        'Aktifkan di Google Cloud Console:\n' +
        'APIs & Services → Library → cari "Google Drive API" → Enable.\n' +
        '(Tunggu 1-2 menit setelah Enable, lalu coba lagi.)' + detailLine
      );
    }
    if (/File not found|notFound/i.test(detail)) {
      return ctx.reply(
        '❌ Template tidak ditemukan. Pastikan templateSpreadsheetId di rekap.json ' +
        'benar (ID dari URL spreadsheet template, bukan link lengkap).' + detailLine
      );
    }
    if (/permission|insufficientPermissions|forbidden|caller does not have/i.test(detail)) {
      return ctx.reply(
        '❌ Service account belum punya akses ke template. Buka spreadsheet ' +
        'template → Share → tambahkan email service account (lihat client_email di ' +
        'rekap-credentials.json) sebagai Editor.' + detailLine
      );
    }
    return ctx.reply('Gagal membuat pelanggan otomatis.' + detailLine);
  }
});

bot.command('pelanggan', async (ctx) => {
  try {
    if (!isAdmin(ctx)) return;
    const list = await readPelanggan();
    if (list.length === 0) return ctx.reply('Belum ada pelanggan.');
    const lines = [`Daftar Pelanggan (${list.length})`, ''];
    for (const t of list) {
      const aktif = tenantActive(t) ? '🟢' : '🔴';
      lines.push(`${aktif} ${t.nama || '-'} (${t.userId}) — ${t.paket || '-'} — s/d ${t.aktifSampai || '-'}`);
    }
    return ctx.reply(lines.join('\n'));
  } catch (err) {
    logError('Gagal /pelanggan.', err);
    return ctx.reply('Gagal menampilkan pelanggan.');
  }
});

bot.command('perpanjang', async (ctx) => {
  try {
    if (!isAdmin(ctx)) return;
    const arg = (ctx.message.text || '').replace(/^\/perpanjang(@\S+)?\s*/i, '').trim();
    const parts = arg.split(/\s+/);
    if (parts.length < 2) {
      return ctx.reply('Format: /perpanjang <TelegramID> <DD/MM/YYYY | lifetime>');
    }
    const ok = await upsertPelanggan({ userId: parts[0], aktifSampai: parts.slice(1).join(' ') });
    return ctx.reply(ok ? `Masa aktif ${parts[0]} diperbarui ✅` : `Pelanggan ${parts[0]} belum ada, dibuat baru.`);
  } catch (err) {
    logError('Gagal /perpanjang.', err);
    return ctx.reply('Gagal memperpanjang.');
  }
});

bot.command('hapususer', async (ctx) => {
  try {
    if (!isAdmin(ctx)) return;
    const id = (ctx.message.text || '').replace(/^\/hapususer(@\S+)?\s*/i, '').trim();
    if (!id) return ctx.reply('Format: /hapususer <TelegramID>');
    const ok = await deletePelanggan(id);
    return ctx.reply(ok ? `Pelanggan ${id} dihapus.` : `Pelanggan ${id} tidak ditemukan.`);
  } catch (err) {
    logError('Gagal /hapususer.', err);
    return ctx.reply('Gagal menghapus pelanggan.');
  }
});

// ---- Middleware gerbang tenant (berlaku untuk semua handler di bawah) ----

bot.use(async (ctx, next) => {
  if (!isMultiTenant()) {
    return tenantStore.run(
      { spreadsheetId: config.spreadsheetId, sheetName: config.sheetName },
      () => next()
    );
  }

  const userId = String(ctx.from?.id || '').trim();
  if (!userId) return;

  let tenant = null;
  try {
    tenant = await resolveTenant(userId);
  } catch (e) {
    logError('Gagal resolve tenant.', e);
  }

  if (!tenant) {
    if (isAdmin(ctx)) {
      return tenantStore.run(
        { spreadsheetId: config.spreadsheetId || masterId(), sheetName: config.sheetName },
        () => next()
      );
    }
    return ctx.reply(
      'Halo! 👋 Kamu belum terdaftar.\n' +
      'Untuk mulai memakai bot ini, daftar dulu via Instagram @rekapuang.id ' +
      'atau gabung grup: ' + groupLink()
    );
  }

  if (!tenantActive(tenant)) {
    return ctx.reply(
      'Masa aktif kamu sudah berakhir ⏳\n' +
      'Yuk perpanjang lewat @rekapuang.id supaya bisa lanjut mencatat. Terima kasih! 🙏'
    );
  }

  return tenantStore.run(
    { spreadsheetId: tenant.spreadsheetId, sheetName: tenant.sheetName, nama: tenant.nama },
    () => next()
  );
});

// Paksa rapikan format sheet (judul/header/warna baris). Tanpa input transaksi.
// /rapikan            -> rapikan sheet milik sendiri
// /rapikan <TelegramID> -> (admin) rapikan sheet pelanggan tertentu
bot.command('rapikan', async (ctx) => {
  try {
    if (!(await guardOwner(ctx))) return;
    const arg = (ctx.message.text || '').replace(/^\/rapikan(@\S+)?\s*/i, '').trim();

    let targetSs = ssId();
    let targetSheet = getSheetName();
    let label = 'sheet kamu';

    if (arg) {
      if (!isMultiTenant() || !isAdmin(ctx)) {
        return ctx.reply('Cukup ketik /rapikan (tanpa argumen) untuk merapikan sheet kamu.');
      }
      const t = await resolveTenant(arg);
      if (!t || !t.spreadsheetId) {
        return ctx.reply(`Pelanggan ${arg} tidak ditemukan atau belum punya spreadsheet.`);
      }
      targetSs = t.spreadsheetId;
      targetSheet = t.sheetName;
      label = t.nama || arg;
    }

    await ctx.reply(`⏳ Merapikan ${label} ...`);
    await tenantStore.run({ spreadsheetId: targetSs, sheetName: targetSheet }, async () => {
      await ensureHeader();
      await formatSheetLayout();
      try { await updateAnalisaSheet(); } catch (e) { logError('Rapikan: analisa gagal.', e); }
      try { await formatLanggananSheet(); } catch (e) { logError('Rapikan: langganan gagal.', e); }
    });
    return ctx.reply(`Beres! ✅ Format ${label} sudah dirapikan.`);
  } catch (err) {
    logError('Gagal /rapikan.', err);
    return ctx.reply('Gagal merapikan sheet. Cek log server.');
  }
});

bot.start(async (ctx) => {
  if (!(await guardOwner(ctx))) return;

  return ctx.reply(
    '👋 Selamat datang di Bot Rekap Uang!\n' +
    'Catat pemasukan & pengeluaran langsung dari chat, otomatis masuk Google Sheets.\n' +
    '\n' +
    '✍️ CARA MENGISI (paling mudah):\n' +
    'keluar <kategori> <nominal>\n' +
    'masuk <kategori> <nominal>\n' +
    '\n' +
    'Contoh:\n' +
    '• keluar makan 25000\n' +
    '• keluar makan 25000 di warung agam\n' +
    '• keluar bensin 50rb di SPBU #isi full\n' +
    '• masuk gaji 5jt\n' +
    '\n' +
    'Keterangan:\n' +
    '• "di <toko>" → mengisi kolom Toko (opsional)\n' +
    '• "pakai <akun>" → pilih dompet/akun, mis. pakai gopay (opsional)\n' +
    '• "#catatan" → menambah catatan (opsional)\n' +
    '• Nominal bisa: 25000, 25rb, 1,5jt, 20 usdt, $10\n' +
    '• Kategori otomatis dirapikan (makan/makanan → Makanan)\n' +
    '\n' +
    '🧾 STRUK & 🎙️ SUARA:\n' +
    '• Kirim foto struk → bot baca otomatis, lalu konfirmasi via tombol\n' +
    '• Kirim pesan suara → diketik ulang & dicatat\n' +
    '\n' +
    '💰 BUDGET & TARGET:\n' +
    '• budget makanan 1jt → batas bulanan (bot ingatkan jika hampir/lewat)\n' +
    '• target liburan 5jt → buat target nabung\n' +
    '• nabung liburan 500k → tambah tabungan\n' +
    '\n' +
    '🔁 LANGGANAN (tagihan rutin):\n' +
    '• /langganan tambah Netflix; Hiburan; 54000; 1\n' +
    '\n' +
    '📊 LIHAT LAPORAN:\n' +
    '/hari · /bulan · /laporan · /analisa\n' +
    '\n' +
    'Tekan tombol di bawah atau ketik /help untuk panduan lengkap. 👇',
    mainKeyboard
  );
});

bot.command('menu', async (ctx) => {
  if (!(await guardOwner(ctx))) return;
  return ctx.reply('Menu pintasan 👇', mainKeyboard);
});

bot.command('help', async (ctx) => {
  if (!(await guardOwner(ctx))) return;

  return ctx.reply(
    'Cara catat transaksi:\n' +
    'keluar <item> <nominal>\n' +
    'keluar <item> <nominal> di <toko>\n' +
    'masuk <item> <nominal>\n' +
    '\n' +
    'Item = nama/jenis (mis. bensin). Bot otomatis mengelompokkan ke\n' +
    'kategori induk (bensin -> Transportasi, makan -> Makanan).\n' +
    'Kalau toko tidak ditulis, otomatis jadi "Lainnya".\n' +
    '\n' +
    'Contoh:\n' +
    '- keluar bensin 50000\n' +
    '   → item=bensin, kategori=Transportasi\n' +
    '- keluar makan 100000 di warung agam\n' +
    '   → item=makan, kategori=Makanan, toko=warung agam\n' +
    '- keluar wifi 150000\n' +
    '- masuk gaji 5jt\n' +
    '- masuk airdrop 20 usdt\n' +
    '- masuk $10 freelance\n' +
    '\n' +
    'Format label (urutan bebas) juga didukung:\n' +
    '- keluar toko=warung Agam kategori=makan 318000\n' +
    '\n' +
    'Catatan opsional pakai #:\n' +
    '- keluar makan 50000 di warteg #makan siang\n' +
    '\n' +
    'Catat untuk tanggal lampau (backdate):\n' +
    '- keluar makan 50000 tgl 5\n' +
    '- keluar bensin 50rb tgl 3/6/2026\n' +
    '\n' +
    'Input lain:\n' +
    '- Foto/upload struk → dibaca AI, konfirmasi via tombol\n' +
    '- Pesan suara → ditranskripsi lalu dicatat\n' +
    '\n' +
    'Budget & target:\n' +
    'budget <kategori> <nominal>   (mis: budget makanan 1jt)\n' +
    'budget hapus <kategori>\n' +
    'target <nama> <nominal>       (mis: target liburan 5jt)\n' +
    'target hapus <nama>\n' +
    'nabung <nama> <nominal>       (mis: nabung liburan 500k)\n' +
    '\n' +
    'Hutang & piutang:\n' +
    'hutang <nama> <nominal>       (kamu pinjam uang)\n' +
    'piutang <nama> <nominal>      (orang pinjam ke kamu)\n' +
    'lunas <nama>                  (tandai lunas)\n' +
    '\n' +
    'Neraca (aset & liabilitas):\n' +
    'aset <nama> <nominal>         (mis: aset Bank BCA 5jt)\n' +
    'liabilitas <nama> <nominal>   (mis: liabilitas KPR 100jt)\n' +
    'aset hapus <nama> / liabilitas hapus <nama>\n' +
    '(Kas terisi otomatis dari transaksi)\n' +
    '\n' +
    'Atur kategori sendiri:\n' +
    'kategori map <kata> <Induk>   (mis: kategori map rokok Pribadi)\n' +
    'kategori unmap <kata>         (hapus pemetaan)\n' +
    '\n' +
    'Perintah:\n' +
    '/ringkasan - dashboard keuangan\n' +
    '/saldo - saldo total & bulan ini\n' +
    '/hari [DD MM YYYY] - rekap harian\n' +
    '/minggu - rekap 7 hari terakhir\n' +
    '/bulan [MM YYYY] - rekap bulanan\n' +
    '/laporan [MM YYYY] - laporan + grafik + proyeksi\n' +
    '/analisa - analisa lengkap + grafik di Sheet\n' +
    '/kategori - rincian item per kategori bulan ini\n' +
    '/tips - saran hemat dari AI\n' +
    '/budget - lihat budget & pemakaian\n' +
    '/target - lihat target tabungan\n' +
    '/langganan - kelola tagihan rutin\n' +
    '   /langganan tambah Nama; Kategori; Nominal; Hari\n' +
    '   /langganan jalan | /langganan hapus <nama>\n' +
    '/hutang - catatan hutang & piutang\n' +
    '/neraca - aset, liabilitas, ekuitas (akun otomatis)\n' +
    '/akun - saldo per akun/dompet\n' +
    '/cari <kata> - cari transaksi\n' +
    '/export [MM YYYY] - unduh data CSV (semua / per bulan)\n' +
    '/edit - edit transaksi terakhir (item/kategori/toko/nominal/catatan)\n' +
    '/hapus - hapus transaksi terakhir\n' +
    '/batal - kembalikan transaksi yang baru dihapus\n' +
    '/migrasi - rapikan data lama (normalisasi kategori & isi item)'
  );
});

bot.command('bulan', async (ctx) => {
  try {
    if (!(await guardOwner(ctx))) return;

    const text = (ctx.message.text || '').trim();
    const parts = text.split(/\s+/).filter(Boolean);

    const now = new Date();
    let month = Number(
      now.toLocaleDateString('en-US', {
        timeZone: getTimezone(),
        month: 'numeric'
      })
    );

    let year = Number(
      now.toLocaleDateString('en-US', {
        timeZone: getTimezone(),
        year: 'numeric'
      })
    );

    if (parts.length >= 3) {
      const inputMonth = Number(parts[1]);
      const inputYear = Number(parts[2]);

      if (
        !Number.isInteger(inputMonth) ||
        !Number.isInteger(inputYear) ||
        inputMonth < 1 ||
        inputMonth > 12 ||
        inputYear < 2000
      ) {
        return ctx.reply('Format salah.\nContoh:\n/bulan\n/bulan 5 2026');
      }

      month = inputMonth;
      year = inputYear;
    }

    const summary = await getMonthlySummary(month, year);

    if (summary.items.length === 0) {
      return ctx.reply(`Tidak ada transaksi untuk ${month}/${year}.`);
    }

    const monthLabel = new Date(year, month - 1, 1).toLocaleDateString('id-ID', {
      month: 'long',
      year: 'numeric'
    });

    const pemasukanItems = summary.items.filter(item => item.pemasukan > 0);
    const pengeluaranItems = summary.items.filter(item => item.pengeluaran > 0);

    const lines = [];
    lines.push(`Rekap bulan ${monthLabel}`);
    lines.push('');

    lines.push('Pemasukan');
    if (pemasukanItems.length > 0) {
      for (const item of pemasukanItems) {
        lines.push(`${item.tanggal} | ${item.kategori} | ${formatRupiah(item.pemasukan)}`);
      }
    } else {
      lines.push('-');
    }

    lines.push('');
    lines.push('Pengeluaran');
    if (pengeluaranItems.length > 0) {
      for (const item of pengeluaranItems) {
        lines.push(`${item.tanggal} | ${item.kategori} | ${formatRupiah(item.pengeluaran)}`);
      }
    } else {
      lines.push('-');
    }

    lines.push('');
    lines.push(`Total Pemasukan: ${formatRupiah(summary.totalPemasukan)}`);
    lines.push(`Total Pengeluaran: ${formatRupiah(summary.totalPengeluaran)}`);

    return ctx.reply(lines.join('\n'));
  } catch (err) {
    logError('Gagal mengambil rekap bulanan.', err);
    return ctx.reply('Gagal mengambil rekap bulanan.');
  }
});

bot.command('hari', async (ctx) => {
  try {
    if (!(await guardOwner(ctx))) return;

    const text = (ctx.message.text || '').trim();
    const parts = text.split(/\s+/).filter(Boolean);

    const now = new Date();
    let day = Number(
      now.toLocaleDateString('en-US', {
        timeZone: getTimezone(),
        day: 'numeric'
      })
    );
    let month = Number(
      now.toLocaleDateString('en-US', {
        timeZone: getTimezone(),
        month: 'numeric'
      })
    );
    let year = Number(
      now.toLocaleDateString('en-US', {
        timeZone: getTimezone(),
        year: 'numeric'
      })
    );

    if (parts.length >= 4) {
      const inputDay = Number(parts[1]);
      const inputMonth = Number(parts[2]);
      const inputYear = Number(parts[3]);

      if (
        !Number.isInteger(inputDay) ||
        !Number.isInteger(inputMonth) ||
        !Number.isInteger(inputYear) ||
        inputDay < 1 ||
        inputDay > 31 ||
        inputMonth < 1 ||
        inputMonth > 12 ||
        inputYear < 2000
      ) {
        return ctx.reply('Format salah.\nContoh:\n/hari\n/hari 5 6 2026');
      }

      day = inputDay;
      month = inputMonth;
      year = inputYear;
    }

    const summary = await getDailySummary(day, month, year);

    const dateLabel = new Date(year, month - 1, day).toLocaleDateString('id-ID', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric'
    });

    if (summary.items.length === 0) {
      return ctx.reply(`Tidak ada transaksi untuk ${dateLabel}.`);
    }

    const pemasukanItems = summary.items.filter(item => item.pemasukan > 0);
    const pengeluaranItems = summary.items.filter(item => item.pengeluaran > 0);

    const lines = [];
    lines.push(`Rekap harian ${dateLabel}`);
    lines.push('');

    lines.push('Pemasukan');
    if (pemasukanItems.length > 0) {
      for (const item of pemasukanItems) {
        lines.push(`${item.kategori} | ${formatRupiah(item.pemasukan)}`);
      }
    } else {
      lines.push('-');
    }

    lines.push('');
    lines.push('Pengeluaran');
    if (pengeluaranItems.length > 0) {
      for (const item of pengeluaranItems) {
        const toko = item.toko ? ` (${item.toko})` : '';
        lines.push(`${item.kategori}${toko} | ${formatRupiah(item.pengeluaran)}`);
      }
    } else {
      lines.push('-');
    }

    lines.push('');
    lines.push(`Total Pemasukan: ${formatRupiah(summary.totalPemasukan)}`);
    lines.push(`Total Pengeluaran: ${formatRupiah(summary.totalPengeluaran)}`);
    lines.push(`Saldo: ${formatRupiah(summary.saldo)}`);

    return ctx.reply(lines.join('\n'));
  } catch (err) {
    logError('Gagal mengambil rekap harian.', err);
    return ctx.reply('Gagal mengambil rekap harian.');
  }
});

bot.command('analisa', async (ctx) => {
  try {
    if (!(await guardOwner(ctx))) return;

    await ctx.reply('Menyusun analisa...');

    const analisa = await updateAnalisaSheet();

    const lines = [];
    lines.push('Analisa Keuangan 📊');
    lines.push('');
    lines.push(`Total Pemasukan: ${formatRupiah(analisa.totalPemasukan)}`);
    lines.push(`Total Pengeluaran: ${formatRupiah(analisa.totalPengeluaran)}`);
    lines.push(`Saldo: ${formatRupiah(analisa.saldo)}`);
    lines.push(`Jumlah Transaksi: ${analisa.jumlahTransaksi}`);
    lines.push(`Rata-rata Pengeluaran: ${formatRupiah(analisa.avgExpense)}`);

    if (analisa.perKategori.length > 0) {
      lines.push('');
      lines.push('Top Pengeluaran per Kategori:');
      for (const [kategori, jumlah] of analisa.perKategori.slice(0, 5)) {
        lines.push(`- ${kategori}: ${formatRupiah(jumlah)}`);
      }
    }

    if (analisa.perToko.length > 0) {
      lines.push('');
      lines.push('Top Pengeluaran per Toko:');
      for (const [toko, jumlah] of analisa.perToko.slice(0, 5)) {
        lines.push(`- ${toko}: ${formatRupiah(jumlah)}`);
      }
    }

    if (analisa.perPencatat && analisa.perPencatat.length > 1) {
      lines.push('');
      lines.push('Pengeluaran per Pencatat:');
      for (const [nama, jumlah] of analisa.perPencatat) {
        lines.push(`- ${nama}: ${formatRupiah(jumlah)}`);
      }
    }

    lines.push('');
    lines.push(`Detail lengkap ada di sheet "${getAnalisaSheetName()}".`);

    return ctx.reply(lines.join('\n'));
  } catch (err) {
    logError('Gagal membuat analisa.', err);
    return ctx.reply('Gagal membuat analisa.');
  }
});

bot.command('hapus', async (ctx) => {
  try {
    if (!(await guardOwner(ctx))) return;

    const entries = await getAllEntries();
    if (entries.length === 0) {
      return ctx.reply('Tidak ada transaksi untuk dihapus.');
    }
    const last = entries[entries.length - 1];
    const nilai = last.pengeluaran > 0
      ? `-${formatRupiah(last.pengeluaran)}`
      : `+${formatRupiah(last.pemasukan)}`;
    const tokoLabel = last.toko ? ` | ${last.toko}` : '';

    return ctx.reply(
      'Hapus transaksi terakhir ini?\n' +
      `${last.tanggal} | ${last.kategori}${tokoLabel} | ${nilai}`,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: '🗑️ Ya, hapus', callback_data: 'del|yes' },
            { text: 'Batal', callback_data: 'del|no' }
          ]]
        }
      }
    );
  } catch (err) {
    logError('Gagal menyiapkan hapus.', err);
    return ctx.reply('Gagal menyiapkan hapus.');
  }
});

bot.command('edit', async (ctx) => {
  try {
    if (!(await guardOwner(ctx))) return;

    const arg = (ctx.message.text || '').replace(/^\/edit(@\S+)?\s*/i, '').trim();
    const m = arg.match(/^(kategori|toko|nominal|jumlah|nilai|catatan|note)\s+(.+)$/i);

    if (!m) {
      const entries = await getAllEntries();
      let info = '';
      if (entries.length > 0) {
        const last = entries[entries.length - 1];
        const nilai = last.pengeluaran > 0
          ? formatRupiah(last.pengeluaran)
          : formatRupiah(last.pemasukan);
        info = `\n\nTransaksi terakhir:\n${last.tanggal} | ${last.kategori}` +
          `${last.toko ? ' | ' + last.toko : ''} | ${nilai}` +
          `${last.catatan ? ' | #' + last.catatan : ''}`;
      }
      return ctx.reply(
        'Edit transaksi terakhir. Format:\n' +
        '/edit kategori <baru>\n' +
        '/edit toko <baru>\n' +
        '/edit nominal <baru>\n' +
        '/edit catatan <baru>' + info
      );
    }

    const result = await editLastTransaction(m[1], m[2].trim());
    if (!result) {
      return ctx.reply('Tidak ada transaksi untuk diedit.');
    }
    if (result.error) {
      return ctx.reply(result.error);
    }

    await formatSheetLayout();
    try { await updateAnalisaSheet(); } catch (e) { logError('Gagal update analisa.', e); }

    return ctx.reply(`Sip, sudah diupdate 👌\n${m[1].toLowerCase()} → ${result.value}`);
  } catch (err) {
    logError('Gagal mengedit transaksi.', err);
    return ctx.reply('Gagal mengedit transaksi.');
  }
});

bot.command('hutang', async (ctx) => {
  try {
    if (!(await guardOwner(ctx))) return;

    const list = await getHutang();
    if (list.length === 0) {
      return ctx.reply(
        'Belum ada catatan hutang/piutang.\n\n' +
        'Catat dengan:\n' +
        'hutang <nama> <nominal>   (kamu pinjam uang)\n' +
        'piutang <nama> <nominal>  (orang pinjam ke kamu)\n' +
        'Lunas: lunas <nama>'
      );
    }

    let totalHutang = 0;
    let totalPiutang = 0;
    const hutangLines = [];
    const piutangLines = [];
    for (const h of list) {
      if (/piutang/i.test(h.jenis)) {
        totalPiutang += h.nominal;
        piutangLines.push(`- ${h.nama}: ${formatRupiah(h.nominal)}${h.catatan ? ' (' + h.catatan + ')' : ''}`);
      } else {
        totalHutang += h.nominal;
        hutangLines.push(`- ${h.nama}: ${formatRupiah(h.nominal)}${h.catatan ? ' (' + h.catatan + ')' : ''}`);
      }
    }

    const lines = ['Hutang & Piutang 🧾', ''];
    lines.push('Hutang (kamu pinjam):');
    lines.push(hutangLines.length ? hutangLines.join('\n') : '- tidak ada');
    lines.push(`Total hutang: ${formatRupiah(totalHutang)}`);
    lines.push('');
    lines.push('Piutang (dipinjam orang):');
    lines.push(piutangLines.length ? piutangLines.join('\n') : '- tidak ada');
    lines.push(`Total piutang: ${formatRupiah(totalPiutang)}`);
    lines.push('');
    lines.push(`Posisi bersih: ${formatRupiah(totalPiutang - totalHutang)}`);
    lines.push('Lunas: lunas <nama>');

    return ctx.reply(lines.join('\n'));
  } catch (err) {
    logError('Gagal menampilkan hutang.', err);
    return ctx.reply('Gagal menampilkan hutang.');
  }
});

bot.command('budget', async (ctx) => {
  try {
    if (!(await guardOwner(ctx))) return;

    const tz = getTimezone();
    const now = new Date();
    const month = Number(now.toLocaleDateString('en-US', { timeZone: tz, month: 'numeric' }));
    const year = Number(now.toLocaleDateString('en-US', { timeZone: tz, year: 'numeric' }));

    const budgets = await getBudgets();
    const kats = Object.keys(budgets);
    if (kats.length === 0) {
      return ctx.reply(
        'Belum ada budget.\nAtur dengan: budget <kategori> <nominal>\nContoh: budget makanan 1jt'
      );
    }

    try { await refreshBudgetSheet(month, year); } catch (e) { logError('Gagal percantik budget.', e); }

    const lines = [`Budget bulan ${buildMonthLabel(month, year)} 💰`, ''];
    for (const kat of kats) {
      const budget = budgets[kat];
      const spent = await getMonthlyCategoryTotal(kat, month, year);
      const pct = budget > 0 ? Math.round((spent / budget) * 100) : 0;
      const bar = buildProgressBar(pct);
      lines.push(`${kat}: ${formatRupiah(spent)} / ${formatRupiah(budget)} (${pct}%)`);
      lines.push(bar);
    }

    return ctx.reply(lines.join('\n'));
  } catch (err) {
    logError('Gagal menampilkan budget.', err);
    return ctx.reply('Gagal menampilkan budget.');
  }
});

bot.command('kategori', async (ctx) => {
  try {
    if (!(await guardOwner(ctx))) return;

    const tz = getTimezone();
    const now = new Date();
    const month = Number(now.toLocaleDateString('en-US', { timeZone: tz, month: 'numeric' }));
    const year = Number(now.toLocaleDateString('en-US', { timeZone: tz, year: 'numeric' }));

    const entries = await getAllEntries();
    const monthEntries = entries.filter(
      (e) => e.parsedDate.month === month && e.parsedDate.year === year && e.pengeluaran > 0
    );

    if (monthEntries.length === 0) {
      return ctx.reply(`Belum ada pengeluaran di ${buildMonthLabel(month, year)}.`);
    }

    // kategori -> { total, items: {item: total} }
    const groups = {};
    let grand = 0;
    for (const e of monthEntries) {
      const kat = normalizeCategory(e.kategori, 'pengeluaran');
      if (!groups[kat]) groups[kat] = { total: 0, items: {} };
      groups[kat].total += e.pengeluaran;
      const it = e.item || '(tanpa item)';
      groups[kat].items[it] = (groups[kat].items[it] || 0) + e.pengeluaran;
      grand += e.pengeluaran;
    }

    const lines = [`Pengeluaran per Kategori — ${buildMonthLabel(month, year)} 🗂️`, ''];
    const katSorted = Object.entries(groups).sort((a, b) => b[1].total - a[1].total);
    for (const [kat, data] of katSorted) {
      const pct = grand > 0 ? Math.round((data.total / grand) * 100) : 0;
      lines.push(`▸ ${kat}: ${formatRupiah(data.total)} (${pct}%)`);
      const itemsSorted = Object.entries(data.items).sort((a, b) => b[1] - a[1]).slice(0, 8);
      for (const [it, v] of itemsSorted) {
        lines.push(`   • ${it}: ${formatRupiah(v)}`);
      }
    }
    lines.push('');
    lines.push(`Total: ${formatRupiah(grand)}`);

    return ctx.reply(lines.join('\n'));
  } catch (err) {
    logError('Gagal menampilkan kategori.', err);
    return ctx.reply('Gagal menampilkan rincian kategori.');
  }
});

bot.command('tips', async (ctx) => {
  try {
    if (!(await guardOwner(ctx))) return;

    if (!isLlmConfigured()) {
      return ctx.reply(
        'Fitur tips AI belum aktif. Isi API key LLM di rekap.json ' +
        '(anthropicApiKey atau openaiApiKey).'
      );
    }

    const tz = getTimezone();
    const now = new Date();
    const month = Number(now.toLocaleDateString('en-US', { timeZone: tz, month: 'numeric' }));
    const year = Number(now.toLocaleDateString('en-US', { timeZone: tz, year: 'numeric' }));

    const rep = await buildMonthlyReport(month, year);
    if (rep.count === 0) {
      return ctx.reply('Belum ada transaksi bulan ini untuk dianalisis.');
    }

    await ctx.reply('Menganalisis keuanganmu... 🤔');

    const katText = Object.entries(rep.perKat)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}: ${formatRupiah(v)}`)
      .join(', ');

    const prompt =
      'Kamu penasihat keuangan pribadi. Berdasarkan data bulan ' +
      `${buildMonthLabel(month, year)} berikut, beri 3-4 saran hemat yang ` +
      'spesifik, praktis, dan ramah dalam Bahasa Indonesia. Singkat, pakai poin. ' +
      'Jangan mengulang angka mentah terlalu banyak.\n\n' +
      `Pemasukan: ${formatRupiah(rep.income)}\n` +
      `Pengeluaran: ${formatRupiah(rep.expense)}\n` +
      `Saldo: ${formatRupiah(rep.saldo)}\n` +
      `Pengeluaran per kategori: ${katText}\n` +
      (rep.lastExpense > 0 ? `Pengeluaran bulan lalu: ${formatRupiah(rep.lastExpense)}\n` : '');

    let tips = '';
    try {
      tips = await askLlmText(prompt);
    } catch (e) {
      logError('Gagal minta tips ke LLM.', e);
      return ctx.reply('Gagal mengambil tips dari AI. Coba lagi nanti.');
    }

    if (!tips) return ctx.reply('AI tidak memberi jawaban. Coba lagi nanti.');
    return ctx.reply('💡 Tips hemat bulan ini:\n\n' + tips);
  } catch (err) {
    logError('Gagal membuat tips.', err);
    return ctx.reply('Gagal membuat tips.');
  }
});

bot.command('target', async (ctx) => {
  try {
    if (!(await guardOwner(ctx))) return;

    const targets = await getTargets();
    if (targets.length === 0) {
      return ctx.reply(
        'Belum ada target tabungan.\nBuat dengan: target <nama> <nominal>\nContoh: target liburan 5jt'
      );
    }

    const lines = ['Target Tabungan 🎯', ''];
    for (const t of targets) {
      const pct = t.target > 0 ? Math.min(100, Math.round((t.terkumpul / t.target) * 100)) : 0;
      lines.push(`${t.nama}: ${formatRupiah(t.terkumpul)} / ${formatRupiah(t.target)} (${pct}%)`);
      lines.push(buildProgressBar(pct));
    }
    lines.push('');
    lines.push('Tabung: nabung <nama> <nominal>');

    return ctx.reply(lines.join('\n'));
  } catch (err) {
    logError('Gagal menampilkan target.', err);
    return ctx.reply('Gagal menampilkan target.');
  }
});

bot.command('langganan', async (ctx) => {
  try {
    if (!(await guardOwner(ctx))) return;

    const text = (ctx.message.text || '').trim();
    const arg = text.replace(/^\/langganan(@\S+)?\s*/i, '').trim();

    // /langganan tambah Nama; Kategori; Nominal; Hari[; Toko]
    if (/^tambah\b/i.test(arg)) {
      const body = arg.replace(/^tambah\s*/i, '').trim();
      const parts = body.split(';').map((s) => s.trim());
      if (parts.length < 4) {
        return ctx.reply(
          'Format: /langganan tambah Nama; Kategori; Nominal; Hari; [Toko]; [masuk/keluar]\n' +
          'Contoh keluar: /langganan tambah Netflix; Hiburan; 54000; 1\n' +
          'Contoh masuk: /langganan tambah Gaji; Gaji; 5jt; 25; ; masuk'
        );
      }
      const nominal = await parseAmountToNumber(parts[2]);
      const hari = Number(parts[3]);
      if (!nominal || !Number.isInteger(hari) || hari < 1 || hari > 31) {
        return ctx.reply('Nominal/Hari tidak valid (Hari = 1-31).');
      }
      const jenisRaw = (parts[5] || '').toLowerCase();
      const jenis = /masuk|income|pemasukan/.test(jenisRaw) ? 'pemasukan' : 'pengeluaran';
      await addLangganan({
        nama: parts[0],
        kategori: parts[1],
        nominal,
        hari,
        toko: parts[4] || 'Lainnya',
        catatan: '',
        jenis
      });
      try { await formatLanggananSheet(); } catch (e) { logError('Gagal percantik langganan.', e); }
      const label = jenis === 'pemasukan' ? 'Pemasukan rutin' : 'Langganan';
      return ctx.reply(
        `${label} "${parts[0]}" ditambahkan: ${formatRupiah(nominal)} setiap tanggal ${hari}.`
      );
    }

    // /langganan hapus Nama
    if (/^hapus\b/i.test(arg)) {
      const nama = arg.replace(/^hapus\s*/i, '').trim();
      if (!nama) return ctx.reply('Format: /langganan hapus <nama>');
      const ok = await deleteLangganan(nama);
      if (ok) { try { await formatLanggananSheet(); } catch (e) { logError('Gagal percantik langganan.', e); } }
      return ctx.reply(ok ? `Langganan "${nama}" dihapus.` : `Langganan "${nama}" tidak ditemukan.`);
    }

    // /langganan jalan -> proses yang jatuh tempo hari ini
    if (/^jalan\b/i.test(arg)) {
      const tz = getTimezone();
      const now = new Date();
      const day = Number(now.toLocaleDateString('en-US', { timeZone: tz, day: 'numeric' }));
      const month = Number(now.toLocaleDateString('en-US', { timeZone: tz, month: 'numeric' }));
      const year = Number(now.toLocaleDateString('en-US', { timeZone: tz, year: 'numeric' }));
      const posted = await runDueLangganan(day, month, year);
      if (posted.length === 0) return ctx.reply('Tidak ada langganan jatuh tempo hari ini.');
      return ctx.reply(
        'Langganan dicatat ✅\n' +
        posted.map((l) => `- ${l.nama}: ${formatRupiah(l.nominal)}`).join('\n')
      );
    }

    // Default: daftar langganan
    try { await formatLanggananSheet(); } catch (e) { logError('Gagal percantik langganan.', e); }
    const list = await getLangganan();
    if (list.length === 0) {
      return ctx.reply(
        'Belum ada langganan.\n' +
        'Tambah: /langganan tambah Nama; Kategori; Nominal; Hari; [Toko]\n' +
        'Contoh: /langganan tambah Netflix; Hiburan; 54000; 1\n' +
        'Hapus: /langganan hapus <nama>\n' +
        'Jalankan jatuh tempo hari ini: /langganan jalan'
      );
    }

    const lines = ['Langganan / Rutin 🔁', ''];
    for (const l of list) {
      const tanda = l.jenis === 'pemasukan' ? '🟢 masuk' : '🔴 keluar';
      lines.push(`- ${l.nama} (${l.kategori}) ${tanda}: ${formatRupiah(l.nominal)} tiap tgl ${l.hari}`);
    }
    lines.push('');
    lines.push('Tambah: /langganan tambah Nama; Kategori; Nominal; Hari; [Toko]; [masuk/keluar]');
    lines.push('Hapus: /langganan hapus <nama>');
    return ctx.reply(lines.join('\n'));
  } catch (err) {
    logError('Gagal memproses langganan.', err);
    return ctx.reply('Gagal memproses langganan.');
  }
});

bot.command('laporan', async (ctx) => {
  try {
    if (!(await guardOwner(ctx))) return;

    const text = (ctx.message.text || '').trim();
    const parts = text.split(/\s+/).filter(Boolean);

    const tz = getTimezone();
    const now = new Date();
    let month = Number(now.toLocaleDateString('en-US', { timeZone: tz, month: 'numeric' }));
    let year = Number(now.toLocaleDateString('en-US', { timeZone: tz, year: 'numeric' }));

    if (parts.length >= 3) {
      const im = Number(parts[1]);
      const iy = Number(parts[2]);
      if (Number.isInteger(im) && im >= 1 && im <= 12 && Number.isInteger(iy) && iy >= 2000) {
        month = im;
        year = iy;
      }
    }

    const rep = await buildMonthlyReport(month, year);
    const monthLabel = buildMonthLabel(month, year);

    const lines = [`Laporan ${monthLabel} 📊`, ''];
    lines.push(`Pemasukan: ${formatRupiah(rep.income)}`);
    lines.push(`Pengeluaran: ${formatRupiah(rep.expense)}`);
    lines.push(`Saldo: ${formatRupiah(rep.saldo)}`);
    lines.push(`Jumlah transaksi: ${rep.count}`);

    if (rep.lastExpense > 0) {
      const diff = rep.expense - rep.lastExpense;
      const pct = Math.round((diff / rep.lastExpense) * 100);
      const arrow = diff > 0 ? '🔺' : (diff < 0 ? '🔻' : '➖');
      lines.push('');
      lines.push(
        `Vs bulan lalu: ${arrow} ${formatRupiah(Math.abs(diff))} (${pct > 0 ? '+' : ''}${pct}%)`
      );
    }

    if (rep.projection != null) {
      lines.push(`Proyeksi akhir bulan: ${formatRupiah(rep.projection)}`);
    }

    if (rep.top.length > 0) {
      lines.push('');
      lines.push('Top pengeluaran:');
      rep.top.forEach(([k, v], i) => {
        lines.push(`${i + 1}. ${k}: ${formatRupiah(v)}`);
      });
    }

    if (rep.anomaly) {
      lines.push('');
      lines.push(`⚠️ ${rep.anomaly}`);
    }

    await ctx.reply(lines.join('\n'));

    // Kirim grafik (QuickChart) jika ada pengeluaran
    const catLabels = Object.keys(rep.perKat);
    if (catLabels.length > 0) {
      const chartConfig = {
        type: 'pie',
        data: {
          labels: catLabels,
          datasets: [{ data: catLabels.map((l) => rep.perKat[l]) }]
        },
        options: {
          plugins: {
            legend: { position: 'right' },
            title: { display: true, text: `Pengeluaran ${monthLabel}` }
          }
        }
      };
      try {
        await ctx.replyWithPhoto({ url: quickChartUrl(chartConfig) });
      } catch (e) {
        logError('Gagal kirim grafik.', e);
      }
    }
  } catch (err) {
    logError('Gagal membuat laporan.', err);
    return ctx.reply('Gagal membuat laporan.');
  }
});

bot.command('saldo', async (ctx) => {
  try {
    if (!(await guardOwner(ctx))) return;

    const entries = await getAllEntries();
    const tz = getTimezone();
    const now = new Date();
    const month = Number(now.toLocaleDateString('en-US', { timeZone: tz, month: 'numeric' }));
    const year = Number(now.toLocaleDateString('en-US', { timeZone: tz, year: 'numeric' }));

    let inc = 0;
    let exp = 0;
    let mInc = 0;
    let mExp = 0;
    for (const e of entries) {
      inc += e.pemasukan;
      exp += e.pengeluaran;
      if (e.parsedDate.month === month && e.parsedDate.year === year) {
        mInc += e.pemasukan;
        mExp += e.pengeluaran;
      }
    }

    const lines = ['Saldo 💵', ''];
    lines.push(`Saldo total: ${formatRupiah(inc - exp)}`);
    lines.push(`Total pemasukan: ${formatRupiah(inc)}`);
    lines.push(`Total pengeluaran: ${formatRupiah(exp)}`);
    lines.push('');
    lines.push(`Bulan ${buildMonthLabel(month, year)}:`);
    lines.push(`  Masuk: ${formatRupiah(mInc)}`);
    lines.push(`  Keluar: ${formatRupiah(mExp)}`);
    lines.push(`  Selisih: ${formatRupiah(mInc - mExp)}`);

    return ctx.reply(lines.join('\n'));
  } catch (err) {
    logError('Gagal menampilkan saldo.', err);
    return ctx.reply('Gagal menampilkan saldo.');
  }
});

bot.command('minggu', async (ctx) => {
  try {
    if (!(await guardOwner(ctx))) return;

    const tz = getTimezone();
    const now = new Date();
    const day = Number(now.toLocaleDateString('en-US', { timeZone: tz, day: 'numeric' }));
    const month = Number(now.toLocaleDateString('en-US', { timeZone: tz, month: 'numeric' }));
    const year = Number(now.toLocaleDateString('en-US', { timeZone: tz, year: 'numeric' }));
    const todayNum = Date.UTC(year, month - 1, day);
    const startNum = todayNum - 6 * 86400000;

    const entries = await getAllEntries();
    let inc = 0;
    let exp = 0;
    const perKat = {};
    for (const e of entries) {
      const eNum = Date.UTC(e.parsedDate.year, e.parsedDate.month - 1, e.parsedDate.day);
      if (eNum < startNum || eNum > todayNum) continue;
      inc += e.pemasukan;
      exp += e.pengeluaran;
      if (e.pengeluaran > 0) {
        const k = normalizeCategory(e.kategori, 'pengeluaran');
        perKat[k] = (perKat[k] || 0) + e.pengeluaran;
      }
    }

    const lines = ['Rekap 7 Hari Terakhir 📅', ''];
    lines.push(`Pemasukan: ${formatRupiah(inc)}`);
    lines.push(`Pengeluaran: ${formatRupiah(exp)}`);
    lines.push(`Selisih: ${formatRupiah(inc - exp)}`);

    const top = Object.entries(perKat).sort((a, b) => b[1] - a[1]).slice(0, 5);
    if (top.length > 0) {
      lines.push('');
      lines.push('Pengeluaran per kategori:');
      for (const [k, v] of top) lines.push(`- ${k}: ${formatRupiah(v)}`);
    }

    return ctx.reply(lines.join('\n'));
  } catch (err) {
    logError('Gagal membuat rekap mingguan.', err);
    return ctx.reply('Gagal membuat rekap mingguan.');
  }
});

bot.command('cari', async (ctx) => {
  try {
    if (!(await guardOwner(ctx))) return;

    const q = (ctx.message.text || '').replace(/^\/cari(@\S+)?\s*/i, '').trim().toLowerCase();
    if (!q) {
      return ctx.reply('Format: /cari <kata>\nContoh: /cari indomaret');
    }

    const entries = await getAllEntries();
    const matches = entries.filter((e) =>
      [e.item, e.kategori, e.toko, e.catatan, e.pencatat]
        .join(' ')
        .toLowerCase()
        .includes(q)
    );

    if (matches.length === 0) {
      return ctx.reply(`Tidak ada transaksi yang cocok dengan "${q}".`);
    }

    let totalExp = 0;
    let totalInc = 0;
    for (const e of matches) {
      totalExp += e.pengeluaran;
      totalInc += e.pemasukan;
    }

    const last = matches.slice(-15);
    const lines = [`Hasil pencarian "${q}" (${matches.length} transaksi):`, ''];
    for (const e of last) {
      const nilai = e.pengeluaran > 0
        ? `-${formatRupiah(e.pengeluaran)}`
        : `+${formatRupiah(e.pemasukan)}`;
      const itemLabel = e.item ? `${e.item} | ` : '';
      const tokoLabel = e.toko ? ` | ${e.toko}` : '';
      lines.push(`${e.tanggal} | ${itemLabel}${e.kategori}${tokoLabel} | ${nilai}`);
    }
    if (matches.length > last.length) {
      lines.push(`...(${matches.length - last.length} lainnya)`);
    }
    lines.push('');
    if (totalExp > 0) lines.push(`Total pengeluaran: ${formatRupiah(totalExp)}`);
    if (totalInc > 0) lines.push(`Total pemasukan: ${formatRupiah(totalInc)}`);

    return ctx.reply(lines.join('\n'));
  } catch (err) {
    logError('Gagal mencari transaksi.', err);
    return ctx.reply('Gagal mencari transaksi.');
  }
});

bot.command('export', async (ctx) => {
  try {
    if (!(await guardOwner(ctx))) return;

    const parts = (ctx.message.text || '').trim().split(/\s+/).filter(Boolean);
    let month = null;
    let year = null;
    if (parts.length >= 3) {
      const im = Number(parts[1]);
      const iy = Number(parts[2]);
      if (Number.isInteger(im) && im >= 1 && im <= 12 && Number.isInteger(iy) && iy >= 2000) {
        month = im;
        year = iy;
      } else {
        return ctx.reply('Format: /export atau /export MM YYYY\nContoh: /export 6 2026');
      }
    }

    const client = await auth.getClient();
    const sheets = google.sheets({ version: 'v4', auth: client });
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: ssId(),
      range: `'${getSheetName()}'!A:J`
    });
    const rows = res.data.values || [];
    if (rows.length <= 2) {
      return ctx.reply('Belum ada data untuk diekspor.');
    }

    // Baris 1 = judul, baris 2 = header, data mulai baris 3.
    const header = rows[1];
    let outRows = rows.slice(1); // header + semua data
    if (month && year) {
      const filtered = rows.slice(2).filter((r) => {
        const d = parseDateParts(r[0] || '');
        return d && d.month === month && d.year === year;
      });
      if (filtered.length === 0) {
        return ctx.reply(`Tidak ada transaksi untuk ${buildMonthLabel(month, year)}.`);
      }
      outRows = [header, ...filtered];
    }

    const esc = (v) => {
      const s = String(v == null ? '' : v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const csv = outRows.map((r) => r.map(esc).join(',')).join('\n');
    const buffer = Buffer.from('﻿' + csv, 'utf8');

    const tz = getTimezone();
    const stamp = month && year
      ? `${year}-${String(month).padStart(2, '0')}`
      : new Date().toLocaleDateString('en-CA', { timeZone: tz });

    return ctx.replyWithDocument({
      source: buffer,
      filename: `rekap-keuangan-${stamp}.csv`
    });
  } catch (err) {
    logError('Gagal ekspor data.', err);
    return ctx.reply('Gagal ekspor data.');
  }
});

bot.command('batal', async (ctx) => {
  try {
    if (!(await guardOwner(ctx))) return;

    if (!lastDeletedRow) {
      return ctx.reply('Tidak ada transaksi yang baru dihapus untuk dikembalikan.');
    }

    await ensureHeader();
    await appendRow(lastDeletedRow);
    await formatSheetLayout();
    try { await updateAnalisaSheet(); } catch (e) { logError('Gagal update analisa.', e); }

    const r = lastDeletedRow;
    lastDeletedRow = null;
    const nilai = parseRupiahTextToNumber(r[5] || '') > 0
      ? `-${formatRupiah(parseRupiahTextToNumber(r[5] || ''))}`
      : `+${formatRupiah(parseRupiahTextToNumber(r[4] || ''))}`;
    const itemLabel = r[1] ? `${r[1]} | ` : '';
    return ctx.reply(
      'Transaksi dikembalikan ✅\n' +
      `${r[0] || ''} | ${itemLabel}${r[2] || ''} | ${nilai}`
    );
  } catch (err) {
    logError('Gagal mengembalikan transaksi.', err);
    return ctx.reply('Gagal mengembalikan transaksi.');
  }
});

bot.command('migrasi', async (ctx) => {
  try {
    if (!(await guardOwner(ctx))) return;

    const entries = await getAllEntries();
    if (entries.length === 0) {
      return ctx.reply('Belum ada data untuk dirapikan.');
    }

    return ctx.reply(
      'Rapikan data lama? Tindakan ini akan:\n' +
      '• Normalisasi kolom Kategori (gabungkan duplikat, mis. makan/makanan → Makanan)\n' +
      '• Isi kolom Item yang kosong dari kategori asli\n' +
      `\nTotal ${entries.length} baris akan diperiksa. Data nominal tidak diubah.`,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ Ya, rapikan', callback_data: 'migr|yes' },
            { text: 'Batal', callback_data: 'migr|no' }
          ]]
        }
      }
    );
  } catch (err) {
    logError('Gagal menyiapkan migrasi.', err);
    return ctx.reply('Gagal menyiapkan migrasi.');
  }
});

async function runMigration() {
  const sheetName = getSheetName();
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: ssId(),
    range: `'${sheetName}'!A:J`
  });
  const rows = res.data.values || [];
  if (rows.length <= 2) return 0;

  const bcValues = [];
  let changed = 0;
  for (let i = 2; i < rows.length; i++) {
    const r = rows[i];
    const origItem = (r[1] || '').trim();
    const origKat = (r[2] || '').trim();
    const isIncome = parseRupiahTextToNumber(r[4] || '') > 0;
    const newKat = normalizeCategory(origKat, isIncome ? 'pemasukan' : 'pengeluaran');
    const newItem = origItem || origKat;
    if (newItem !== origItem || newKat !== origKat) changed += 1;
    bcValues.push([newItem, newKat]);
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId: ssId(),
    range: `'${sheetName}'!B3:C${rows.length}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: bcValues }
  });

  return changed;
}

bot.command('neraca', async (ctx) => {
  try {
    if (!(await guardOwner(ctx))) return;

    // Perbarui saldo tiap akun dulu, lalu percantik + grafik.
    try {
      const entries = await getAllEntries();
      await refreshAccounts(entries);
      await formatNeracaSheet();
    } catch (e) {
      logError('Gagal menyiapkan neraca.', e);
    }

    const list = await getNeraca();
    const akunRows = list.filter((x) => x.tipe === 'Aset' && x.sumber === 'auto');
    const asetManual = list.filter((x) => x.tipe === 'Aset' && x.sumber !== 'auto');
    const liab = list.filter((x) => x.tipe === 'Liabilitas');
    const totalAset = list.filter((x) => x.tipe === 'Aset').reduce((s, x) => s + x.nilai, 0);
    const totalLiab = liab.reduce((s, x) => s + x.nilai, 0);
    const ekuitas = totalAset - totalLiab;

    const lines = ['🏦 NERACA (Balance Sheet)', ''];
    lines.push('💳 AKUN/DOMPET (otomatis)');
    if (akunRows.length === 0) {
      lines.push('- (belum ada transaksi)');
    } else {
      for (const x of akunRows) lines.push(`- ${x.nama}: ${formatRupiah(x.nilai)}`);
    }
    if (asetManual.length > 0) {
      lines.push('');
      lines.push('💰 ASET LAIN');
      for (const x of asetManual) lines.push(`- ${x.nama}: ${formatRupiah(x.nilai)}`);
    }
    lines.push(`\nTotal Aset: ${formatRupiah(totalAset)}`);
    lines.push('');
    lines.push('📕 LIABILITAS');
    if (liab.length === 0) {
      lines.push('- (belum ada)');
    } else {
      for (const x of liab) lines.push(`- ${x.nama}: ${formatRupiah(x.nilai)}`);
    }
    lines.push(`Total Liabilitas: ${formatRupiah(totalLiab)}`);
    lines.push('');
    lines.push(`💎 EKUITAS (kekayaan bersih): ${formatRupiah(ekuitas)}`);
    lines.push('');
    lines.push('Saldo akun terisi otomatis dari transaksi (mis. "keluar ... pakai gopay").');
    lines.push('Tambah aset lain: aset <nama> <nominal> · liabilitas <nama> <nominal>');

    return ctx.reply(lines.join('\n'));
  } catch (err) {
    logError('Gagal menampilkan neraca.', err);
    return ctx.reply('Gagal menampilkan neraca.');
  }
});

bot.command('akun', async (ctx) => {
  try {
    if (!(await guardOwner(ctx))) return;

    const entries = await getAllEntries();
    const net = {};
    for (const e of entries) {
      const a = e.akun || 'Kas';
      net[a] = (net[a] || 0) + e.pemasukan - e.pengeluaran;
    }
    if (!('Kas' in net)) net['Kas'] = 0;

    const sorted = Object.keys(net).sort((a, b) =>
      a === 'Kas' ? -1 : b === 'Kas' ? 1 : a.localeCompare(b)
    );
    const total = Object.values(net).reduce((s, v) => s + v, 0);

    const lines = ['💳 Saldo per Akun/Dompet', ''];
    for (const a of sorted) lines.push(`- ${a}: ${formatRupiah(Math.round(net[a]))}`);
    lines.push('');
    lines.push(`Total: ${formatRupiah(Math.round(total))}`);
    lines.push('');
    lines.push('Pakai akun saat catat: "keluar makan 25rb pakai gopay"');

    return ctx.reply(lines.join('\n'));
  } catch (err) {
    logError('Gagal menampilkan akun.', err);
    return ctx.reply('Gagal menampilkan akun.');
  }
});

bot.command('ringkasan', async (ctx) => {
  try {
    if (!(await guardOwner(ctx))) return;

    const tz = getTimezone();
    const now = new Date();
    const month = Number(now.toLocaleDateString('en-US', { timeZone: tz, month: 'numeric' }));
    const year = Number(now.toLocaleDateString('en-US', { timeZone: tz, year: 'numeric' }));

    const entries = await getAllEntries();
    let allInc = 0;
    let allExp = 0;
    let mInc = 0;
    let mExp = 0;
    const perKat = {};
    for (const e of entries) {
      allInc += e.pemasukan;
      allExp += e.pengeluaran;
      if (e.parsedDate.month === month && e.parsedDate.year === year) {
        mInc += e.pemasukan;
        mExp += e.pengeluaran;
        if (e.pengeluaran > 0) {
          const k = normalizeCategory(e.kategori, 'pengeluaran');
          perKat[k] = (perKat[k] || 0) + e.pengeluaran;
        }
      }
    }

    const lines = [`📋 Ringkasan — ${buildMonthLabel(month, year)}`, ''];
    lines.push(`Saldo total: ${formatRupiah(allInc - allExp)}`);
    lines.push(`Bulan ini: masuk ${formatRupiah(mInc)} | keluar ${formatRupiah(mExp)}`);
    lines.push(`Selisih bulan ini: ${formatRupiah(mInc - mExp)}`);

    const top = Object.entries(perKat).sort((a, b) => b[1] - a[1]).slice(0, 3);
    if (top.length > 0) {
      lines.push('');
      lines.push('Top pengeluaran:');
      top.forEach(([k, v], i) => lines.push(`${i + 1}. ${k}: ${formatRupiah(v)}`));
    }

    // Status budget
    try {
      const budgets = await getBudgets();
      const warn = [];
      for (const kat of Object.keys(budgets)) {
        const spent = await getMonthlyCategoryTotal(kat, month, year);
        const b = budgets[kat];
        if (b > 0 && spent / b >= 0.8) {
          warn.push(`- ${kat}: ${formatRupiah(spent)}/${formatRupiah(b)} (${Math.round(spent / b * 100)}%)`);
        }
      }
      if (warn.length > 0) {
        lines.push('');
        lines.push('⚠️ Budget perlu perhatian:');
        lines.push(warn.join('\n'));
      }
    } catch (e) { logError('Ringkasan: budget.', e); }

    // Target
    try {
      const targets = await getTargets();
      if (targets.length > 0) {
        lines.push('');
        lines.push('🎯 Target:');
        for (const t of targets.slice(0, 5)) {
          const pct = t.target > 0 ? Math.min(100, Math.round(t.terkumpul / t.target * 100)) : 0;
          lines.push(`- ${t.nama}: ${pct}% (${formatRupiah(t.terkumpul)}/${formatRupiah(t.target)})`);
        }
      }
    } catch (e) { logError('Ringkasan: target.', e); }

    // Hutang/piutang
    try {
      const hutang = await getHutang();
      if (hutang.length > 0) {
        let th = 0;
        let tp = 0;
        for (const h of hutang) {
          if (/piutang/i.test(h.jenis)) tp += h.nominal; else th += h.nominal;
        }
        lines.push('');
        lines.push(`🧾 Hutang ${formatRupiah(th)} | Piutang ${formatRupiah(tp)} | Bersih ${formatRupiah(tp - th)}`);
      }
    } catch (e) { logError('Ringkasan: hutang.', e); }

    return ctx.reply(lines.join('\n'));
  } catch (err) {
    logError('Gagal membuat ringkasan.', err);
    return ctx.reply('Gagal membuat ringkasan.');
  }
});

bot.on(['photo', 'document'], async (ctx) => {
  try {
    if (!(await guardOwner(ctx))) return;

    if (!isLlmConfigured()) {
      return ctx.reply(
        'Fitur baca struk belum aktif. Isi API key LLM di rekap.json ' +
        '(anthropicApiKey untuk Claude, atau openaiApiKey untuk LLM lain).'
      );
    }

    let fileId = null;
    let mediaType = 'image/jpeg';

    if (ctx.message.photo && ctx.message.photo.length > 0) {
      const photo = ctx.message.photo[ctx.message.photo.length - 1];
      fileId = photo.file_id;
      mediaType = 'image/jpeg';
    } else if (ctx.message.document) {
      const doc = ctx.message.document;
      const mime = doc.mime_type || '';
      if (!mime.startsWith('image/')) {
        return ctx.reply('Kirim foto struk (format gambar) ya.');
      }
      fileId = doc.file_id;
      mediaType = mime;
    }

    if (!fileId) {
      return ctx.reply('Tidak ada gambar yang bisa dibaca.');
    }

    await ctx.reply('Sebentar ya, lagi baca strukmu 🧾...');

    const link = await ctx.telegram.getFileLink(fileId);
    const res = await fetch(link.href);
    if (!res.ok) {
      throw new Error('Gagal mengunduh gambar dari Telegram');
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    const base64Data = buffer.toString('base64');

    const parsed = await parseReceiptImage(base64Data, mediaType);
    logInfo('Hasil baca struk: ' + JSON.stringify(parsed));

    // Deteksi mata uang. Bila USD ($), konversi ke Rupiah (samakan dgn teks "$"/usd/usdt).
    const curRaw = (parsed && parsed.mata_uang ? String(parsed.mata_uang) : '').toUpperCase();
    const totalRaw = String(parsed && parsed.total != null ? parsed.total : '');
    const isUsd = /USD|DOLLAR|\$/.test(curRaw) || /\$|usd/i.test(totalRaw);

    let total = 0;
    let totalNote = '';
    let usdRate = 0;
    if (parsed) {
      if (isUsd) {
        const amt = coerceAmountFloat(parsed.total);
        if (amt > 0) {
          usdRate = await getUsdToIdrRate();
          total = Math.round(amt * usdRate);
          totalNote = '$' + amt.toLocaleString('en-US', { maximumFractionDigits: 2 });
        }
      } else {
        total = coerceAmountNumber(parsed.total);
      }
    }

    // Jika total terbaca, anggap struk valid (model benar-benar "melihat" gambar).
    if (!total || total <= 0) {
      return ctx.reply(
        'Tidak bisa membaca total dari struk.\n' +
        'Cek dua hal:\n' +
        '1) Pastikan foto struk jelas (tidak buram/gelap).\n' +
        '2) Pastikan model AI mendukung input gambar (vision). ' +
        'Model teks biasa (mis. MiniMax teks) tidak bisa membaca foto.\n' +
        'Rekomendasi model vision: gemini-2.0-flash, gpt-4o-mini, atau Claude.'
      );
    }

    let tanggal;
    const parsedDate = parseDateParts(parsed.tanggal || '');
    if (parsedDate) {
      tanggal = `${parsedDate.day}/${parsedDate.month}/${parsedDate.year}`;
    } else {
      tanggal = new Date().toLocaleDateString('id-ID', { timeZone: getTimezone() });
    }

    let items = Array.isArray(parsed.items) ? parsed.items : [];
    if (isUsd && usdRate > 0) {
      items = items.map((it) => ({
        nama: it && it.nama,
        harga: Math.round(coerceAmountFloat(it && it.harga) * usdRate)
      }));
    }

    const pending = {
      tanggal,
      item: (parsed.item || '').trim() || (parsed.toko || '').trim() || 'Belanja',
      kategori: normalizeCategory(parsed.kategori || '', 'pengeluaran'),
      toko: (parsed.toko || '').trim(),
      total: Math.round(total),
      totalNote,
      items,
      pencatat: getUserName(ctx)
    };

    const id = Math.random().toString(36).slice(2, 8);
    pendingReceipts.set(id, pending);

    return ctx.reply(
      buildReceiptSummary(pending) +
        '\n\nKategorinya pas? Kalau perlu ganti dulu, terus tekan Simpan ya 👇',
      { reply_markup: receiptKeyboard(id, pending.kategori) }
    );
  } catch (err) {
    logError('Gagal membaca struk.', err);
    return ctx.reply('Gagal membaca struk. Coba lagi atau foto lebih jelas.');
  }
});

async function processTransactionText(ctx, text) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) return 'Pesan kosong.';

  await ensureHeader();

  const tz = getTimezone();
  const now = new Date();
  const todayStr = now.toLocaleDateString('id-ID', { timeZone: tz });
  const curMonth = Number(now.toLocaleDateString('en-US', { timeZone: tz, month: 'numeric' }));
  const curYear = Number(now.toLocaleDateString('en-US', { timeZone: tz, year: 'numeric' }));
  const pencatat = getUserName(ctx);

  const successLines = [];
  const failedLines = [];
  const expenseCats = new Set();

  for (const line of lines) {
    const parsed = await parseTransaction(line);
    if (!parsed) {
      failedLines.push(line);
      continue;
    }

    const pemasukan = parsed.type === 'pemasukan' ? parsed.amountText : '';
    const pengeluaran = parsed.type === 'pengeluaran' ? parsed.amountText : '';
    const toko = parsed.toko || '';
    const item = parsed.item || '';
    const akun = parsed.akun || 'Kas';
    const tglRow = parsed.tanggal || todayStr;

    const txnId = await appendRow([
      tglRow,
      item,
      parsed.category,
      toko,
      pemasukan,
      pengeluaran,
      parsed.catatan || '',
      pencatat,
      akun
    ]);

    if (parsed.type === 'pengeluaran') expenseCats.add(parsed.category);

    const itemLabel = item ? `${item} → ` : '';
    const tokoLabel = toko ? ` | toko: ${toko}` : '';
    const akunLabel = akun && akun !== 'Kas' ? ` | 💳 ${akun}` : '';
    const noteLabel = parsed.catatan ? ` | #${parsed.catatan}` : '';
    const idLabel = txnId ? ` | 🆔 ${txnId}` : '';
    successLines.push(
      `${parsed.type} | ${itemLabel}${parsed.category}${tokoLabel}${akunLabel} | ${parsed.amountText}${noteLabel}${idLabel}`
    );
  }

  if (successLines.length > 0) {
    await formatSheetLayout();
    try {
      await updateAnalisaSheet();
    } catch (analisaErr) {
      logError('Gagal memperbarui sheet analisa.', analisaErr);
    }
  }

  let reply = '';
  if (successLines.length > 0) {
    reply += pick(SAVE_PHRASES) + '\n' + successLines.join('\n');
  }

  // Peringatan budget
  const alerts = [];
  for (const cat of expenseCats) {
    try {
      const a = await checkBudgetAlert(cat, curMonth, curYear);
      if (a) alerts.push(a);
    } catch (e) {
      logError('Gagal cek budget.', e);
    }
  }
  if (alerts.length > 0) reply += '\n\n' + alerts.join('\n');

  if (failedLines.length > 0) {
    if (reply) reply += '\n\n';
    reply +=
      'Hmm, baris ini belum kebaca 🤔:\n' +
      failedLines.map((line) => `- ${line}`).join('\n');
  }

  if (!reply) {
    reply =
      'Waduh, formatnya belum kebaca 🙏\n' +
      'Coba kayak gini:\n' +
      '- keluar makan 100000\n' +
      '- keluar makan 100000 di warung agam\n' +
      '- masuk gaji 5jt';
  }

  return reply;
}

async function handleKeywordText(ctx, text) {
  // kategori map <kata> <Induk>  |  kategori unmap <kata>  |  kategori map (lihat)
  if (/^kategori\s+(map|unmap)\b/i.test(text)) {
    const isUnmap = /^kategori\s+unmap\b/i.test(text);
    const rest = text.replace(/^kategori\s+(map|unmap)\s*/i, '').trim();

    if (isUnmap) {
      if (!rest) {
        await ctx.reply('Format: kategori unmap <kata>\nContoh: kategori unmap rokok');
        return true;
      }
      const ok = await removeCategoryMap(rest);
      await ctx.reply(ok ? `Pemetaan "${rest}" dihapus.` : `Pemetaan "${rest}" tidak ditemukan.`);
      return true;
    }

    if (!rest) {
      // tampilkan daftar pemetaan
      if (customCategoryRules.length === 0) {
        await ctx.reply(
          'Belum ada pemetaan kategori custom.\n' +
          'Tambah: kategori map <kata> <Induk>\n' +
          'Contoh: kategori map rokok Pribadi'
        );
      } else {
        const lines = ['Pemetaan kategori custom:', ''];
        for (const [k, v] of customCategoryRules) lines.push(`- ${k} → ${v}`);
        lines.push('');
        lines.push('Hapus: kategori unmap <kata>');
        await ctx.reply(lines.join('\n'));
      }
      return true;
    }

    const m = rest.match(/^(.+)\s+(\S+)$/);
    if (!m) {
      await ctx.reply('Format: kategori map <kata> <Induk>\nContoh: kategori map rokok Pribadi');
      return true;
    }
    const r = await addCategoryMap(m[1].trim(), m[2].trim());
    await ctx.reply(
      `Tersimpan: item mengandung "${r.keyword}" → kategori ${r.kategori}.\n` +
      'Berlaku untuk transaksi berikutnya.'
    );
    return true;
  }

  // budget <kategori> <nominal>  |  budget hapus <kategori>
  if (/^budget\s+/i.test(text)) {
    const rest = text.replace(/^budget\s+/i, '').trim();
    if (/^hapus\s+/i.test(rest)) {
      const kat = rest.replace(/^hapus\s+/i, '').trim();
      const ok = await deleteBudget(kat);
      await ctx.reply(ok ? `Budget ${normalizeCategory(kat, 'pengeluaran')} dihapus.` : 'Budget kategori itu tidak ditemukan.');
      return true;
    }
    const m = rest.match(/^(.+?)\s+(\S+)$/);
    if (!m) {
      await ctx.reply('Format: budget <kategori> <nominal>\nContoh: budget makanan 1jt\nHapus: budget hapus makanan');
      return true;
    }
    const amount = await parseAmountToNumber(m[2]);
    if (!amount) {
      await ctx.reply('Nominal budget tidak valid.');
      return true;
    }
    const canon = await setBudget(m[1].trim(), amount);
    try {
      const tz = getTimezone();
      const now = new Date();
      const mo = Number(now.toLocaleDateString('en-US', { timeZone: tz, month: 'numeric' }));
      const yr = Number(now.toLocaleDateString('en-US', { timeZone: tz, year: 'numeric' }));
      await refreshBudgetSheet(mo, yr);
    } catch (e) { logError('Gagal percantik budget.', e); }
    await ctx.reply(`Sip 👌 Budget ${canon} diset ${formatRupiah(amount)} / bulan. Nanti kuingatkan kalau mepet ya.`);
    return true;
  }

  // target <nama> <nominal>  |  target hapus <nama>
  if (/^target\s+/i.test(text)) {
    const rest = text.replace(/^target\s+/i, '').trim();
    if (/^hapus\s+/i.test(rest)) {
      const nama = rest.replace(/^hapus\s+/i, '').trim();
      const ok = await deleteTarget(nama);
      await ctx.reply(ok ? `Target "${nama}" dihapus.` : `Target "${nama}" tidak ditemukan.`);
      return true;
    }
    const m = rest.match(/^(.+?)\s+(\S+)$/);
    if (!m) {
      await ctx.reply('Format: target <nama> <nominal>\nContoh: target liburan 5jt\nHapus: target hapus liburan');
      return true;
    }
    const amount = await parseAmountToNumber(m[2]);
    if (!amount) {
      await ctx.reply('Nominal target tidak valid.');
      return true;
    }
    const t = await setTarget(m[1].trim(), amount);
    await ctx.reply(
      `Mantap, target "${t.nama}" diset ${formatRupiah(amount)} 🎯\n` +
      `Mulai nabung: nabung ${t.nama} <nominal>`
    );
    return true;
  }

  // nabung <nama target> <nominal>
  if (/^nabung\s+/i.test(text)) {
    const rest = text.replace(/^nabung\s+/i, '').trim();
    const m = rest.match(/^(.+?)\s+(\S+)$/);
    if (!m) {
      await ctx.reply('Format: nabung <nama target> <nominal>\nContoh: nabung liburan 500k');
      return true;
    }
    const amount = await parseAmountToNumber(m[2]);
    if (!amount) {
      await ctx.reply('Nominal tidak valid.');
      return true;
    }
    const t = await addNabung(m[1].trim(), amount);
    if (!t) {
      await ctx.reply(`Target "${m[1].trim()}" belum ada. Buat dulu: target ${m[1].trim()} <nominal>`);
      return true;
    }
    const pct = t.target > 0 ? Math.min(100, Math.round((t.terkumpul / t.target) * 100)) : 0;
    const semangat = pct >= 100
      ? '\n🎉 Targetnya tercapai! Keren banget 🥳'
      : (pct >= 50 ? '\nUdah lewat separuh, semangat! 💪' : '\nMantap, nabung terus ya 💪');
    await ctx.reply(
      `Sip, nabung ${formatRupiah(amount)} ke "${t.nama}" 👌\n` +
      `Progress: ${formatRupiah(t.terkumpul)} / ${formatRupiah(t.target)} (${pct}%)\n` +
      buildProgressBar(pct) + semangat
    );
    return true;
  }

  // hutang/piutang <nama> <nominal> [#catatan]
  const hutangMatch = text.match(/^(hutang|piutang)\s+/i);
  if (hutangMatch) {
    const jenis = hutangMatch[1].toLowerCase() === 'hutang' ? 'Hutang' : 'Piutang';
    let rest = text.replace(/^(hutang|piutang)\s+/i, '').trim();
    let catatan = '';
    const hi = rest.indexOf('#');
    if (hi !== -1) {
      catatan = rest.slice(hi + 1).trim();
      rest = rest.slice(0, hi).trim();
    }
    const m = rest.match(/^(.+?)\s+(\S+)$/);
    if (!m) {
      await ctx.reply(
        'Format: hutang <nama> <nominal>  (uang yang kamu pinjam)\n' +
        'atau: piutang <nama> <nominal>  (orang berhutang ke kamu)\n' +
        'Contoh: hutang budi 200000'
      );
      return true;
    }
    const amount = await parseAmountToNumber(m[2]);
    if (!amount) {
      await ctx.reply('Nominal tidak valid.');
      return true;
    }
    await addHutang(jenis, m[1].trim(), amount, catatan);
    const label = jenis === 'Hutang' ? 'Hutang (kamu pinjam)' : 'Piutang (dipinjam orang)';
    await ctx.reply(
      `${label} dicatat:\n${m[1].trim()} - ${formatRupiah(amount)}\n` +
      `Tandai lunas dengan: lunas ${m[1].trim()}`
    );
    return true;
  }

  // lunas <nama>
  if (/^lunas\s+/i.test(text)) {
    const nama = text.replace(/^lunas\s+/i, '').trim();
    if (!nama) {
      await ctx.reply('Format: lunas <nama>');
      return true;
    }
    const n = await deleteHutangByName(nama);
    await ctx.reply(
      n > 0
        ? `${n} catatan hutang/piutang "${nama}" ditandai lunas & dihapus.`
        : `Tidak ada catatan hutang/piutang untuk "${nama}".`
    );
    return true;
  }

  // Neraca: aset/liabilitas <nama> <nominal>  |  aset/liabilitas hapus <nama>
  const neracaMatch = text.match(/^(aset|liabilitas|kewajiban)\s+/i);
  if (neracaMatch) {
    const tipe = /^aset/i.test(neracaMatch[1]) ? 'Aset' : 'Liabilitas';
    const label = tipe === 'Aset' ? 'aset' : 'liabilitas';
    const rest = text.replace(/^(aset|liabilitas|kewajiban)\s+/i, '').trim();

    if (/^hapus\s+/i.test(rest)) {
      const nama = rest.replace(/^hapus\s+/i, '').trim();
      const ok = await deleteNeracaItem(tipe, nama);
      if (ok) { try { await formatNeracaSheet(); } catch (e) {} }
      await ctx.reply(ok ? `${tipe} "${nama}" dihapus dari neraca.` : `${tipe} "${nama}" tidak ditemukan.`);
      return true;
    }

    const m = rest.match(/^(.+?)\s+(\S+)$/);
    if (!m) {
      await ctx.reply(`Format: ${label} <nama> <nominal>\nContoh: ${label} ${tipe === 'Aset' ? 'Bank BCA 5jt' : 'KPR 100jt'}`);
      return true;
    }
    if (m[1].trim().toLowerCase() === 'kas') {
      await ctx.reply('Kas terisi otomatis dari transaksi, tidak perlu diinput manual 🙂');
      return true;
    }
    const nilai = await parseAmountToNumber(m[2]);
    if (!nilai) {
      await ctx.reply('Nominal tidak valid.');
      return true;
    }
    const canon = await addNeracaItem(tipe, m[1].trim(), nilai);
    try { await formatNeracaSheet(); } catch (e) {}
    await ctx.reply(`Sip 👌 ${canon} "${m[1].trim()}" dicatat: ${formatRupiah(nilai)}. Lihat /neraca`);
    return true;
  }

  return false;
}

bot.on('text', async (ctx) => {
  try {
    if (!(await guardOwner(ctx))) return;

    const text = ctx.message.text.trim();
    if (text.startsWith('/')) return;

    if (await handleKeywordText(ctx, text)) return;

    const reply = await processTransactionText(ctx, text);
    return ctx.reply(reply);
  } catch (err) {
    logError('Gagal memproses pesan.', err);
    let extra = '';
    if (isAdmin(ctx)) {
      let d = String((err && err.message) || '');
      try {
        const apiErr = err && err.response && err.response.data && err.response.data.error;
        if (apiErr && apiErr.message) d = apiErr.message;
      } catch (_) {}
      if (d) extra = `\n\n🔎 (admin) ${d.slice(0, 300)}`;
    }
    return ctx.reply('Gagal memproses pesan.' + extra);
  }
});

bot.on(['voice', 'audio'], async (ctx) => {
  try {
    if (!(await guardOwner(ctx))) return;

    const media = ctx.message.voice || ctx.message.audio;
    if (!media) return;

    await ctx.reply('Mendengar pesan suara... 🎙️');

    const link = await ctx.telegram.getFileLink(media.file_id);
    const res = await fetch(link.href);
    if (!res.ok) throw new Error('Gagal mengunduh suara dari Telegram');
    const buffer = Buffer.from(await res.arrayBuffer());
    const filename = ctx.message.voice
      ? 'voice.ogg'
      : (media.file_name || 'audio.mp3');

    let transcript = '';
    try {
      transcript = await transcribeAudio(buffer, filename);
    } catch (e) {
      logError('Transkripsi gagal.', e);
      return ctx.reply(
        'Gagal transkripsi suara. Pastikan openaiApiKey & sttModel mendukung audio.'
      );
    }

    transcript = (transcript || '').trim();
    if (!transcript) return ctx.reply('Suara tidak terdengar jelas.');

    await ctx.reply(`📝 "${transcript}"`);

    if (await handleKeywordText(ctx, transcript)) return;

    const reply = await processTransactionText(ctx, transcript);
    return ctx.reply(reply);
  } catch (err) {
    logError('Gagal memproses suara.', err);
    return ctx.reply('Gagal memproses pesan suara.');
  }
});

bot.on('callback_query', async (ctx) => {
  try {
    if (!isMultiTenant() && !isOwner(ctx)) {
      await ctx.answerCbQuery('Tidak diizinkan');
      return;
    }

    const data = (ctx.callbackQuery && ctx.callbackQuery.data) || '';
    const parts = data.split('|');

    // Konfirmasi hapus transaksi terakhir
    if (parts[0] === 'migr') {
      if (parts[1] === 'no') {
        await ctx.answerCbQuery('Dibatalkan');
        try { await ctx.editMessageText('Migrasi dibatalkan.'); } catch (e) {}
        return;
      }
      if (parts[1] === 'yes') {
        await ctx.answerCbQuery('Merapikan...');
        try {
          const changed = await runMigration();
          await formatSheetLayout();
          try { await updateAnalisaSheet(); } catch (e) { logError('Gagal update analisa.', e); }
          await ctx.editMessageText(`Data dirapikan ✅\n${changed} baris diperbarui.`);
        } catch (e) {
          logError('Gagal migrasi.', e);
          try { await ctx.editMessageText('Gagal merapikan data.'); } catch (e2) {}
        }
        return;
      }
      await ctx.answerCbQuery();
      return;
    }

    if (parts[0] === 'del') {
      if (parts[1] === 'no') {
        await ctx.answerCbQuery('Dibatalkan');
        try { await ctx.editMessageText('Hapus dibatalkan.'); } catch (e) {}
        return;
      }
      if (parts[1] === 'yes') {
        await ctx.answerCbQuery('Menghapus...');
        const deleted = await deleteLastTransaction();
        if (!deleted) {
          try { await ctx.editMessageText('Tidak ada transaksi untuk dihapus.'); } catch (e) {}
          return;
        }
        lastDeletedRow = deleted.raw || null;
        await formatSheetLayout();
        try { await updateAnalisaSheet(); } catch (e) { logError('Gagal update analisa.', e); }
        const nilai = deleted.pengeluaran > 0
          ? `-${formatRupiah(deleted.pengeluaran)}`
          : `+${formatRupiah(deleted.pemasukan)}`;
        const itemLabel = deleted.item ? `${deleted.item} | ` : '';
        const tokoLabel = deleted.toko ? ` | ${deleted.toko}` : '';
        try {
          await ctx.editMessageText(
            'Oke, sudah kuhapus ya 🗑️\n' +
            `${deleted.tanggal} | ${itemLabel}${deleted.kategori}${tokoLabel} | ${nilai}\n\n` +
            'Eh salah? Ketik /batal buat balikin lagi 🙂'
          );
        } catch (e) {}
        return;
      }
      await ctx.answerCbQuery();
      return;
    }

    if (parts[0] !== 'rc') {
      await ctx.answerCbQuery();
      return;
    }

    const action = parts[1];
    const id = parts[2];
    const pending = pendingReceipts.get(id);

    if (!pending) {
      await ctx.answerCbQuery('Data sudah kadaluarsa');
      try { await ctx.editMessageReplyMarkup(); } catch (e) {}
      return;
    }

    if (action === 'cancel') {
      pendingReceipts.delete(id);
      await ctx.answerCbQuery('Dibatalkan');
      try { await ctx.editMessageText('Struk dibatalkan ❌'); } catch (e) {}
      return;
    }

    if (action === 'cat') {
      const cat = parts.slice(3).join('|');
      pending.kategori = cat;
      pendingReceipts.set(id, pending);
      await ctx.answerCbQuery(`Kategori: ${cat}`);
      try {
        await ctx.editMessageText(
          buildReceiptSummary(pending) + '\n\nKategorinya pas? Kalau perlu ganti dulu, terus tekan Simpan ya 👇',
          { reply_markup: receiptKeyboard(id, cat) }
        );
      } catch (e) {}
      return;
    }

    if (action === 'save') {
      await ctx.answerCbQuery('Menyimpan...');
      await ensureHeader();
      const pengeluaran = 'Rp' + Math.round(pending.total).toLocaleString('id-ID');
      const receiptTxnId = await appendRow([
        pending.tanggal,
        pending.item || 'Belanja',
        pending.kategori,
        pending.toko || 'Lainnya',
        '',
        pengeluaran,
        'Struk',
        pending.pencatat || getUserName(ctx),
        'Kas'
      ]);
      await formatSheetLayout();
      try { await updateAnalisaSheet(); } catch (e) { logError('Gagal update analisa.', e); }
      pendingReceipts.delete(id);

      const tz = getTimezone();
      const now = new Date();
      const curMonth = Number(now.toLocaleDateString('en-US', { timeZone: tz, month: 'numeric' }));
      const curYear = Number(now.toLocaleDateString('en-US', { timeZone: tz, year: 'numeric' }));
      let alert = '';
      try {
        const a = await checkBudgetAlert(pending.kategori, curMonth, curYear);
        if (a) alert = '\n\n' + a;
      } catch (e) {}

      try {
        const idLine = receiptTxnId ? `\n🆔 ${receiptTxnId}` : '';
        await ctx.editMessageText(buildReceiptSummary(pending) + '\n\nSip, struk dicatat ya 👌' + idLine + alert);
      } catch (e) {}
      return;
    }

    await ctx.answerCbQuery();
  } catch (err) {
    logError('Gagal memproses tombol.', err);
    try { await ctx.answerCbQuery('Terjadi error'); } catch (e) {}
  }
});

bot.catch((err) => {
  logError('BOT ERROR:', err);
});

// ---------------------------------------------------------------------------
// Penjadwal: reminder harian + langganan jatuh tempo
// ---------------------------------------------------------------------------

let lastReminderDate = null;
let lastLanggananDate = null;
let lastMonthlyReportKey = null;

function getTzParts() {
  const tz = getTimezone();
  const now = new Date();
  const hour = Number(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false })
      .format(now)
      .replace(/[^\d]/g, '')
  ) % 24;
  const day = Number(now.toLocaleDateString('en-US', { timeZone: tz, day: 'numeric' }));
  const month = Number(now.toLocaleDateString('en-US', { timeZone: tz, month: 'numeric' }));
  const year = Number(now.toLocaleDateString('en-US', { timeZone: tz, year: 'numeric' }));
  const dateKey = now.toLocaleDateString('en-CA', { timeZone: tz });
  return { hour, day, month, year, dateKey };
}

async function sendMessageSafe(chatId, message) {
  try {
    await bot.telegram.sendMessage(chatId, message);
  } catch (e) {
    logError(`Gagal kirim pesan ke ${chatId}.`, e);
  }
}

async function broadcast(message) {
  for (const chatId of getOwnerChatIds()) {
    await sendMessageSafe(chatId, message);
  }
}

// Jalankan tugas terjadwal untuk konteks aktif (1 tenant / single-tenant).
async function runScheduled(o, send) {
  const { day, month, year, doMonthly, doLangganan, doReminder } = o;

  if (doMonthly) {
    try {
      let pm = month - 1;
      let py = year;
      if (pm < 1) { pm = 12; py -= 1; }
      const rep = await buildMonthlyReport(pm, py);
      if (rep.count > 0) {
        const lines = [`📊 Laporan bulan ${buildMonthLabel(pm, py)}`, ''];
        lines.push(`Pemasukan: ${formatRupiah(rep.income)}`);
        lines.push(`Pengeluaran: ${formatRupiah(rep.expense)}`);
        lines.push(`Saldo: ${formatRupiah(rep.saldo)}`);
        if (rep.top.length > 0) {
          lines.push('');
          lines.push('Top pengeluaran:');
          rep.top.forEach(([k, v], i) => lines.push(`${i + 1}. ${k}: ${formatRupiah(v)}`));
        }
        lines.push('');
        lines.push('Ketik /laporan untuk detail + grafik.');
        await send(lines.join('\n'));
      }
    } catch (e) {
      logError('Gagal laporan bulanan terjadwal.', e);
    }
  }

  if (doLangganan) {
    try {
      const posted = await runDueLangganan(day, month, year);
      if (posted.length > 0) {
        await send(
          'Langganan dicatat otomatis hari ini ✅\n' +
          posted.map((l) => `- ${l.nama}: ${formatRupiah(l.nominal)}`).join('\n')
        );
      }
    } catch (e) {
      logError('Gagal langganan terjadwal.', e);
    }
  }

  if (doReminder) {
    try {
      const summary = await getDailySummary(day, month, year);
      let msg = '⏰ Reminder catat keuangan hari ini.';
      if (summary.items.length > 0) {
        msg +=
          `\nHari ini: keluar ${formatRupiah(summary.totalPengeluaran)}, ` +
          `masuk ${formatRupiah(summary.totalPemasukan)}.`;
      } else {
        msg += '\nBelum ada transaksi tercatat hari ini.';
      }
      await send(msg);
    } catch (e) {
      logError('Gagal reminder terjadwal.', e);
    }
  }
}

async function schedulerTick() {
  try {
    const { hour, day, month, year, dateKey } = getTzParts();
    const reminderEnabled = config.reminderEnabled !== false;
    const reminderHour = Number.isInteger(config.reminderHour) ? config.reminderHour : 20;
    const langgananHour = Number.isInteger(config.langgananHour) ? config.langgananHour : 7;
    const monthlyReportEnabled = config.monthlyReportEnabled !== false;
    const monthlyReportHour = Number.isInteger(config.monthlyReportHour) ? config.monthlyReportHour : 8;
    const monthKey = `${year}-${String(month).padStart(2, '0')}`;

    const doMonthly = monthlyReportEnabled && day === 1 && hour === monthlyReportHour && lastMonthlyReportKey !== monthKey;
    const doLangganan = hour === langgananHour && lastLanggananDate !== dateKey;
    const doReminder = reminderEnabled && hour === reminderHour && lastReminderDate !== dateKey;
    if (!doMonthly && !doLangganan && !doReminder) return;

    const o = { day, month, year, doMonthly, doLangganan, doReminder };

    if (isMultiTenant()) {
      let tenants = [];
      try { tenants = await getActiveTenants(); } catch (e) { logError('Gagal ambil tenant aktif.', e); }
      for (const t of tenants) {
        await tenantStore.run(
          { spreadsheetId: t.spreadsheetId, sheetName: t.sheetName },
          async () => { await runScheduled(o, (msg) => sendMessageSafe(t.userId, msg)); }
        );
      }
    } else {
      await tenantStore.run(
        { spreadsheetId: config.spreadsheetId, sheetName: config.sheetName },
        async () => { await runScheduled(o, broadcast); }
      );
    }

    if (doMonthly) lastMonthlyReportKey = monthKey;
    if (doLangganan) lastLanggananDate = dateKey;
    if (doReminder) lastReminderDate = dateKey;
  } catch (e) {
    logError('Scheduler error.', e);
  }
}

async function registerBotCommands() {
  try {
    await bot.telegram.setMyCommands([
      { command: 'start', description: 'Mulai & petunjuk penggunaan' },
      { command: 'help', description: 'Panduan lengkap' },
      { command: 'menu', description: 'Tampilkan tombol pintasan' },
      { command: 'ringkasan', description: 'Ringkasan keuangan (dashboard)' },
      { command: 'neraca', description: 'Neraca: aset, liabilitas, ekuitas' },
      { command: 'akun', description: 'Saldo per akun/dompet' },
      { command: 'saldo', description: 'Saldo total & bulan ini' },
      { command: 'hari', description: 'Rekap hari ini' },
      { command: 'minggu', description: 'Rekap 7 hari terakhir' },
      { command: 'bulan', description: 'Rekap bulan ini' },
      { command: 'laporan', description: 'Laporan + grafik + proyeksi' },
      { command: 'analisa', description: 'Analisa lengkap + grafik' },
      { command: 'budget', description: 'Lihat budget & pemakaian' },
      { command: 'kategori', description: 'Rincian item per kategori' },
      { command: 'tips', description: 'Saran hemat dari AI' },
      { command: 'target', description: 'Lihat target tabungan' },
      { command: 'langganan', description: 'Kelola tagihan rutin' },
      { command: 'hutang', description: 'Catatan hutang & piutang' },
      { command: 'cari', description: 'Cari transaksi' },
      { command: 'export', description: 'Ekspor data ke CSV' },
      { command: 'edit', description: 'Edit transaksi terakhir' },
      { command: 'hapus', description: 'Hapus transaksi terakhir' },
      { command: 'batal', description: 'Kembalikan transaksi yang dihapus' },
      { command: 'migrasi', description: 'Rapikan data lama (kategori & item)' }
    ]);
    logInfo('Menu perintah Telegram terpasang.');
  } catch (e) {
    logError('Gagal memasang menu perintah.', e);
  }
}

logInfo('Started bot...');

// Jalankan bot dengan auto-retry. Bila Telegram tak terjangkau (ETIMEDOUT),
// bot tidak langsung mati — ia mencoba lagi dengan jeda bertambah (maks 60s).
let launchAttempt = 0;
async function startBot() {
  launchAttempt += 1;
  try {
    await bot.launch();
    launchAttempt = 0;
    logInfo('Bot terhubung ke Telegram ✅');
    registerBotCommands();
    if (!isMultiTenant()) loadCustomCategoryRules();
  } catch (err) {
    const delay = Math.min(60000, 2000 * 2 ** Math.min(launchAttempt - 1, 5));
    logError(
      `Gagal terhubung ke Telegram (percobaan ${launchAttempt}). ` +
      `Coba lagi dalam ${Math.round(delay / 1000)} detik. ` +
      'Jika ETIMEDOUT: cek koneksi/firewall VPS atau atur "proxyUrl" di rekap.json.',
      err
    );
    setTimeout(startBot, delay);
  }
}
startBot();

// Cek setiap menit
setInterval(schedulerTick, 60 * 1000);

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
