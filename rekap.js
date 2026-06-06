const { execSync } = require('child_process');

execSync(
  'curl -s https://raw.githubusercontent.com/zamzasalim/logo/main/asc.sh | bash',
  {
    stdio: 'inherit'
  }
);

const { Telegraf, Markup } = require('telegraf');
const { google } = require('googleapis');
const Anthropic = require('@anthropic-ai/sdk');
const config = require('./rekap.json');

if (!config.botToken) {
  throw new Error('botToken di rekap.json belum diisi');
}

if (!config.spreadsheetId) {
  throw new Error('spreadsheetId di rekap.json belum diisi');
}

if (!config.ownerUserId) {
  throw new Error('ownerUserId di rekap.json belum diisi');
}

const bot = new Telegraf(config.botToken);

const anthropicApiKey = config.anthropicApiKey || process.env.ANTHROPIC_API_KEY;
const anthropic = anthropicApiKey
  ? new Anthropic({ apiKey: anthropicApiKey })
  : null;

// Menyimpan hasil baca struk sementara (menunggu konfirmasi tombol).
const pendingReceipts = new Map();

// Keyboard pintasan yang muncul di bawah kolom ketik.
const mainKeyboard = Markup.keyboard([
  ['/saldo', '/hari', '/minggu', '/bulan'],
  ['/laporan', '/analisa', '/budget', '/target'],
  ['/langganan', '/hutang', '/cari', '/export'],
  ['/edit', '/hapus', '/help']
]).resize();

const RECEIPT_CATEGORIES = [
  'Makanan', 'Minuman', 'Kebutuhan Pokok', 'Transportasi', 'Kesehatan',
  'Hiburan', 'Tagihan', 'Pendidikan', 'Belanja', 'Lainnya'
];

function buildReceiptSummary(p) {
  const lines = [];
  lines.push('Hasil baca struk 🧾');
  lines.push(`Tanggal: ${p.tanggal}`);
  lines.push(`Kategori: ${p.kategori}`);
  if (p.toko) lines.push(`Toko: ${p.toko}`);
  lines.push(`Total: Rp${Math.round(p.total).toLocaleString('id-ID')}`);
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

function getSheetName() {
  return config.sheetName || 'Sheet1';
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
function normalizeCategory(raw, type) {
  const s = String(raw || '').toLowerCase().trim();
  if (!s) return 'Lainnya';

  const rules = type === 'pemasukan' ? INCOME_CATEGORY_RULES : EXPENSE_CATEGORY_RULES;

  for (const [canonical, keywords] of rules) {
    for (const kw of keywords) {
      const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`\\b${escaped}\\b`, 'i');
      if (re.test(s)) return canonical;
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
    spreadsheetId: config.spreadsheetId,
    range: `'${sheetName}'!A:G`,
  });

  const rows = res.data.values || [];
  const dataRows = rows.slice(1);

  const entries = [];

  for (const row of dataRows) {
    const tanggal = row[0] || '';
    const kategori = row[1] || '';
    const toko = row[2] || '';
    const pemasukan = row[3] || '';
    const pengeluaran = row[4] || '';
    const catatan = row[5] || '';
    const pencatat = row[6] || '';

    const parsedDate = parseDateParts(tanggal);
    if (!parsedDate) continue;

    entries.push({
      tanggal,
      kategori,
      toko,
      pemasukan: parseRupiahTextToNumber(pemasukan),
      pengeluaran: parseRupiahTextToNumber(pengeluaran),
      catatan,
      pencatat,
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
  if (!isOwner(ctx)) {
    logInfo(`Akses ditolak untuk userId=${ctx.from?.id || 'unknown'}`);
    await ctx.reply('Bot ini khusus pemilik.');
    return false;
  }
  return true;
}

async function appendRow(values) {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });
  const sheetName = getSheetName();

  await sheets.spreadsheets.values.append({
    spreadsheetId: config.spreadsheetId,
    range: `'${sheetName}'!A:G`,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [values],
    },
  });

  logInfo('Berhasil simpan ke spreadsheet.');
}

async function ensureHeader() {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });
  const sheetName = getSheetName();

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: config.spreadsheetId,
    range: `'${sheetName}'!A1:G2`,
  });

  const values = res.data.values || [];
  const header = values[0] || [];

  const needsHeader =
    values.length === 0 ||
    header[0] !== 'Tanggal' ||
    header[2] !== 'Toko' ||
    header[4] !== 'Pengeluaran' ||
    header[5] !== 'Catatan' ||
    header[6] !== 'Pencatat';

  if (needsHeader) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: config.spreadsheetId,
      range: `'${sheetName}'!A1:G1`,
      valueInputOption: 'RAW',
      requestBody: {
        values: [[
          'Tanggal',
          'Kategori',
          'Toko',
          'Pemasukan',
          'Pengeluaran',
          'Catatan',
          'Pencatat'
        ]]
      }
    });
  }
}

async function formatSheetLayout() {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });
  const sheetName = getSheetName();

  const meta = await sheets.spreadsheets.get({
    spreadsheetId: config.spreadsheetId,
  });

  const targetSheet = meta.data.sheets.find(
    (sheet) => sheet.properties.title === sheetName
  );

  if (!targetSheet) {
    throw new Error(`Sheet "${sheetName}" tidak ditemukan`);
  }

  const sheetId = targetSheet.properties.sheetId;

  const valueRes = await sheets.spreadsheets.values.get({
    spreadsheetId: config.spreadsheetId,
    range: `'${sheetName}'!A:G`,
  });

  const values = valueRes.data.values || [];
  const lastRow = Math.max(values.length, 1);

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: config.spreadsheetId,
    requestBody: {
      requests: [
        {
          updateSheetProperties: {
            properties: {
              sheetId,
              gridProperties: {
                frozenRowCount: 1
              }
            },
            fields: 'gridProperties.frozenRowCount'
          }
        },
        {
          repeatCell: {
            range: {
              sheetId,
              startRowIndex: 0,
              endRowIndex: 1,
              startColumnIndex: 0,
              endColumnIndex: 7
            },
            cell: {
              userEnteredFormat: {
                backgroundColor: {
                  red: 0.84,
                  green: 0.93,
                  blue: 0.88
                },
                textFormat: {
                  bold: true,
                  fontSize: 12
                },
                horizontalAlignment: 'CENTER',
                verticalAlignment: 'MIDDLE'
              }
            },
            fields: 'userEnteredFormat.backgroundColor,userEnteredFormat.textFormat.bold,userEnteredFormat.textFormat.fontSize,userEnteredFormat.horizontalAlignment,userEnteredFormat.verticalAlignment'
          }
        },
        {
          repeatCell: {
            range: {
              sheetId,
              startRowIndex: 1,
              endRowIndex: lastRow,
              startColumnIndex: 0,
              endColumnIndex: 1
            },
            cell: {
              userEnteredFormat: {
                textFormat: {
                  fontSize: 12
                },
                horizontalAlignment: 'CENTER',
                verticalAlignment: 'MIDDLE'
              }
            },
            fields: 'userEnteredFormat.textFormat.fontSize,userEnteredFormat.horizontalAlignment,userEnteredFormat.verticalAlignment'
          }
        },
        {
          repeatCell: {
            range: {
              sheetId,
              startRowIndex: 1,
              endRowIndex: lastRow,
              startColumnIndex: 1,
              endColumnIndex: 3
            },
            cell: {
              userEnteredFormat: {
                textFormat: {
                  fontSize: 12
                },
                horizontalAlignment: 'LEFT',
                verticalAlignment: 'MIDDLE'
              }
            },
            fields: 'userEnteredFormat.textFormat.fontSize,userEnteredFormat.horizontalAlignment,userEnteredFormat.verticalAlignment'
          }
        },
        {
          repeatCell: {
            range: {
              sheetId,
              startRowIndex: 1,
              endRowIndex: lastRow,
              startColumnIndex: 3,
              endColumnIndex: 5
            },
            cell: {
              userEnteredFormat: {
                textFormat: {
                  fontSize: 12
                },
                horizontalAlignment: 'RIGHT',
                verticalAlignment: 'MIDDLE'
              }
            },
            fields: 'userEnteredFormat.textFormat.fontSize,userEnteredFormat.horizontalAlignment,userEnteredFormat.verticalAlignment'
          }
        },
        {
          repeatCell: {
            range: {
              sheetId,
              startRowIndex: 1,
              endRowIndex: lastRow,
              startColumnIndex: 5,
              endColumnIndex: 7
            },
            cell: {
              userEnteredFormat: {
                textFormat: {
                  fontSize: 12
                },
                horizontalAlignment: 'LEFT',
                verticalAlignment: 'MIDDLE'
              }
            },
            fields: 'userEnteredFormat.textFormat.fontSize,userEnteredFormat.horizontalAlignment,userEnteredFormat.verticalAlignment'
          }
        },
        {
          setBasicFilter: {
            filter: {
              range: {
                sheetId,
                startRowIndex: 0,
                endRowIndex: lastRow,
                startColumnIndex: 0,
                endColumnIndex: 7
              }
            }
          }
        },
        {
          updateDimensionProperties: {
            range: {
              sheetId,
              dimension: 'COLUMNS',
              startIndex: 0,
              endIndex: 1
            },
            properties: {
              pixelSize: 100
            },
            fields: 'pixelSize'
          }
        },
        {
          updateDimensionProperties: {
            range: {
              sheetId,
              dimension: 'COLUMNS',
              startIndex: 1,
              endIndex: 3
            },
            properties: {
              pixelSize: 150
            },
            fields: 'pixelSize'
          }
        },
        {
          updateDimensionProperties: {
            range: {
              sheetId,
              dimension: 'COLUMNS',
              startIndex: 3,
              endIndex: 5
            },
            properties: {
              pixelSize: 130
            },
            fields: 'pixelSize'
          }
        },
        {
          updateDimensionProperties: {
            range: {
              sheetId,
              dimension: 'COLUMNS',
              startIndex: 5,
              endIndex: 6
            },
            properties: {
              pixelSize: 200
            },
            fields: 'pixelSize'
          }
        },
        {
          updateDimensionProperties: {
            range: {
              sheetId,
              dimension: 'COLUMNS',
              startIndex: 6,
              endIndex: 7
            },
            properties: {
              pixelSize: 110
            },
            fields: 'pixelSize'
          }
        },
        {
          updateBorders: {
            range: {
              sheetId,
              startRowIndex: 0,
              endRowIndex: lastRow,
              startColumnIndex: 0,
              endColumnIndex: 7
            },
            top: {
              style: 'SOLID',
              width: 1,
              color: { red: 0, green: 0, blue: 0 }
            },
            bottom: {
              style: 'SOLID',
              width: 1,
              color: { red: 0, green: 0, blue: 0 }
            },
            left: {
              style: 'SOLID',
              width: 1,
              color: { red: 0, green: 0, blue: 0 }
            },
            right: {
              style: 'SOLID',
              width: 1,
              color: { red: 0, green: 0, blue: 0 }
            },
            innerHorizontal: {
              style: 'SOLID',
              width: 1,
              color: { red: 0, green: 0, blue: 0 }
            },
            innerVertical: {
              style: 'SOLID',
              width: 1,
              color: { red: 0, green: 0, blue: 0 }
            }
          }
        }
      ]
    }
  });
}

async function ensureSheetExists(sheetName) {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });

  const meta = await sheets.spreadsheets.get({
    spreadsheetId: config.spreadsheetId,
  });

  const existing = meta.data.sheets.find(
    (sheet) => sheet.properties.title === sheetName
  );

  if (existing) {
    return existing.properties.sheetId;
  }

  const res = await sheets.spreadsheets.batchUpdate({
    spreadsheetId: config.spreadsheetId,
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

  const perPencatat = {};

  for (const entry of entries) {
    totalPemasukan += entry.pemasukan;
    totalPengeluaran += entry.pengeluaran;

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
  const bulanSorted = Object.values(perBulan).sort((a, b) => {
    if (a.year !== b.year) return a.year - b.year;
    return a.month - b.month;
  });

  const now = new Date();
  const generatedAt = now.toLocaleString('id-ID', { timeZone: getTimezone() });
  const pctOf = (v) => (totalPengeluaran > 0 ? v / totalPengeluaran : 0);

  // Bangun baris sambil mencatat posisi (index 0-based) untuk acuan grafik.
  const rows = [];
  const boldRows = [];
  const at = () => rows.length; // index baris berikutnya

  rows.push(['ANALISA KEUANGAN']);
  rows.push([`Diperbarui: ${generatedAt}`]);
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
      spreadsheetId: config.spreadsheetId,
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
    spreadsheetId: config.spreadsheetId,
    range: `'${sheetName}'!A1:Z1000`,
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId: config.spreadsheetId,
    range: `'${sheetName}'!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: rows },
  });

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

  // Judul besar
  requests.push({
    repeatCell: {
      range: rangeCell(0, 1, 0, 4),
      cell: { userEnteredFormat: { textFormat: { bold: true, fontSize: 14 } } },
      fields: 'userEnteredFormat.textFormat.bold,userEnteredFormat.textFormat.fontSize'
    }
  });

  // Tebalkan baris header bagian/tabel
  for (const r of boldRows) {
    requests.push({
      repeatCell: {
        range: rangeCell(r, r + 1, 0, 4),
        cell: { userEnteredFormat: { textFormat: { bold: true } } },
        fields: 'userEnteredFormat.textFormat.bold'
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

  // Bar: Pemasukan & Pengeluaran per Bulan
  if (bulanDataEnd > bulanDataStart) {
    requests.push(anchorChart(65, {
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
    spreadsheetId: config.spreadsheetId,
    requestBody: { requests },
  });

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
  '"Total Bayar", atau "Total". Tulis sebagai angka Rupiah tanpa titik/koma/Rp.\n' +
  '- tanggal: tanggal transaksi pada struk, format DD/MM/YYYY. Kosongkan jika tidak ada.\n' +
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
    kategori: { type: 'string' },
    total: { type: 'number' },
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
  required: ['is_receipt', 'toko', 'tanggal', 'kategori', 'total', 'items'],
  additionalProperties: false
};

const RECEIPT_JSON_HINT =
  '\n\nKembalikan HANYA JSON valid (tanpa teks lain, tanpa markdown) dengan ' +
  'bentuk persis:\n' +
  '{"is_receipt": boolean, "toko": string, "tanggal": string, ' +
  '"kategori": string, "total": number, ' +
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
    spreadsheetId: config.spreadsheetId,
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
    spreadsheetId: config.spreadsheetId,
    range: `'${sheetName}'!A1:${colEnd}1`
  });
  const cur = (res.data.values && res.data.values[0]) || [];
  const needs = header.some((h, i) => cur[i] !== h);
  if (needs) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: config.spreadsheetId,
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

// ----- Budget -----

async function getBudgets() {
  const sheetName = getBudgetSheetName();
  await ensureSheetWithHeader(sheetName, ['Kategori', 'Budget Bulanan']);
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: config.spreadsheetId,
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
    spreadsheetId: config.spreadsheetId,
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
      spreadsheetId: config.spreadsheetId,
      range: `'${sheetName}'!A${rowNum}:B${rowNum}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[canon, amount]] }
    });
  } else {
    await sheets.spreadsheets.values.append({
      spreadsheetId: config.spreadsheetId,
      range: `'${sheetName}'!A:B`,
      valueInputOption: 'RAW',
      requestBody: { values: [[canon, amount]] }
    });
  }
  return canon;
}

async function deleteBudget(kategori) {
  const sheetName = getBudgetSheetName();
  const canon = normalizeCategory(kategori, 'pengeluaran');
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: config.spreadsheetId,
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
    spreadsheetId: config.spreadsheetId,
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
    spreadsheetId: config.spreadsheetId,
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
      spreadsheetId: config.spreadsheetId,
      range: `'${sheetName}'!A${found.rowNum}:C${found.rowNum}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[found.nama, target, found.terkumpul]] }
    });
    return { ...found, target };
  }
  await sheets.spreadsheets.values.append({
    spreadsheetId: config.spreadsheetId,
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
    spreadsheetId: config.spreadsheetId,
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
    spreadsheetId: config.spreadsheetId,
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

async function getLangganan() {
  const sheetName = getLanggananSheetName();
  await ensureSheetWithHeader(sheetName, [
    'Nama', 'Kategori', 'Toko', 'Nominal', 'Tanggal Tagih', 'Catatan'
  ]);
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: config.spreadsheetId,
    range: `'${sheetName}'!A2:F`
  });
  const rows = res.data.values || [];
  const list = [];
  rows.forEach((r, i) => {
    const nama = (r[0] || '').trim();
    if (!nama) return;
    list.push({
      nama,
      kategori: (r[1] || '').trim(),
      toko: (r[2] || '').trim(),
      nominal: parseRupiahTextToNumber(r[3] || ''),
      hari: Number(r[4]) || 0,
      catatan: (r[5] || '').trim(),
      rowNum: i + 2
    });
  });
  return list;
}

async function addLangganan(obj) {
  const sheetName = getLanggananSheetName();
  await ensureSheetWithHeader(sheetName, [
    'Nama', 'Kategori', 'Toko', 'Nominal', 'Tanggal Tagih', 'Catatan'
  ]);
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });
  await sheets.spreadsheets.values.append({
    spreadsheetId: config.spreadsheetId,
    range: `'${sheetName}'!A:F`,
    valueInputOption: 'RAW',
    requestBody: {
      values: [[
        obj.nama,
        normalizeCategory(obj.kategori, 'pengeluaran'),
        obj.toko || 'Lainnya',
        obj.nominal,
        obj.hari,
        obj.catatan || ''
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
    spreadsheetId: config.spreadsheetId,
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
    const pengeluaran = 'Rp' + Math.round(l.nominal).toLocaleString('id-ID');
    await appendRow([
      tanggal,
      normalizeCategory(l.kategori, 'pengeluaran'),
      l.toko || 'Lainnya',
      '',
      pengeluaran,
      tag,
      'Langganan'
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
    spreadsheetId: config.spreadsheetId,
    range: `'${sheetName}'!A:G`
  });
  const rows = res.data.values || [];
  if (rows.length <= 1) return null;
  const lastIndex = rows.length - 1;
  const last = rows[lastIndex];
  const sheetId = await getSheetIdByName(sheetName);
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: config.spreadsheetId,
    requestBody: {
      requests: [{
        deleteDimension: {
          range: { sheetId, dimension: 'ROWS', startIndex: lastIndex, endIndex: lastIndex + 1 }
        }
      }]
    }
  });
  return {
    tanggal: last[0] || '',
    kategori: last[1] || '',
    toko: last[2] || '',
    pemasukan: last[3] || '',
    pengeluaran: last[4] || '',
    catatan: last[5] || ''
  };
}

async function editLastTransaction(field, rawValue) {
  const sheetName = getSheetName();
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: config.spreadsheetId,
    range: `'${sheetName}'!A:G`
  });
  const rows = res.data.values || [];
  if (rows.length <= 1) return null;

  const rowNum = rows.length; // baris terakhir (header di baris 1)
  const last = rows[rows.length - 1];
  const isIncome = parseRupiahTextToNumber(last[3] || '') > 0;
  const type = isIncome ? 'pemasukan' : 'pengeluaran';

  let col = null;
  let value = rawValue;

  if (/^kategori$/i.test(field)) {
    col = 'B';
    value = normalizeCategory(rawValue, type);
  } else if (/^toko$/i.test(field)) {
    col = 'C';
    value = rawValue;
  } else if (/^(nominal|jumlah|nilai)$/i.test(field)) {
    const amt = await parseMoneyText(rawValue);
    if (!amt) return { error: 'Nominal tidak valid.' };
    col = isIncome ? 'D' : 'E';
    value = amt;
  } else if (/^(catatan|note)$/i.test(field)) {
    col = 'F';
    value = rawValue;
  } else {
    return { error: 'Field tidak dikenal. Pilih: kategori / toko / nominal / catatan.' };
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId: config.spreadsheetId,
    range: `'${sheetName}'!${col}${rowNum}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[value]] }
  });

  return {
    field,
    value,
    tanggal: last[0] || '',
    kategori: col === 'B' ? value : (last[1] || ''),
  };
}

// ----- Hutang / Piutang -----

async function getHutang() {
  const sheetName = getHutangSheetName();
  await ensureSheetWithHeader(sheetName, ['Nama', 'Jenis', 'Nominal', 'Catatan', 'Tanggal']);
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: config.spreadsheetId,
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
    spreadsheetId: config.spreadsheetId,
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
    spreadsheetId: config.spreadsheetId,
    requestBody: { requests }
  });
  return matched.length;
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
      category: normalizeCategory(category, type),
      toko: type === 'pemasukan' ? '' : (toko || 'Lainnya'),
      catatan,
      tanggal,
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
    category: normalizeCategory(category, type),
    toko: type === 'pemasukan' ? '' : (toko || 'Lainnya'),
    catatan,
    tanggal,
    amountText
  };
}

bot.start(async (ctx) => {
  if (!(await guardOwner(ctx))) return;

  return ctx.reply(
    '👋 Selamat datang di Bot Rekap Keuangan!\n' +
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
    'keluar <kategori> <nominal>\n' +
    'keluar <kategori> <nominal> di <toko>\n' +
    'masuk <kategori> <nominal>\n' +
    '\n' +
    'Kalau toko tidak ditulis, otomatis jadi "Lainnya".\n' +
    '\n' +
    'Contoh:\n' +
    '- keluar makan 100000\n' +
    '   → kategori=makan, toko=Lainnya\n' +
    '- keluar makan 100000 di warung agam\n' +
    '   → kategori=makan, toko=warung agam\n' +
    '- keluar bensin 50rb di SPBU Shell\n' +
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
    'Perintah:\n' +
    '/saldo - saldo total & bulan ini\n' +
    '/hari [DD MM YYYY] - rekap harian\n' +
    '/minggu - rekap 7 hari terakhir\n' +
    '/bulan [MM YYYY] - rekap bulanan\n' +
    '/laporan [MM YYYY] - laporan + grafik + proyeksi\n' +
    '/analisa - analisa lengkap + grafik di Sheet\n' +
    '/budget - lihat budget & pemakaian\n' +
    '/target - lihat target tabungan\n' +
    '/langganan - kelola tagihan rutin\n' +
    '   /langganan tambah Nama; Kategori; Nominal; Hari\n' +
    '   /langganan jalan | /langganan hapus <nama>\n' +
    '/hutang - catatan hutang & piutang\n' +
    '/cari <kata> - cari transaksi\n' +
    '/export - unduh data CSV\n' +
    '/edit - edit transaksi terakhir\n' +
    '/hapus - hapus transaksi terakhir'
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

    return ctx.reply(`Transaksi terakhir diperbarui ✅\n${m[1].toLowerCase()} → ${result.value}`);
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
          'Format: /langganan tambah Nama; Kategori; Nominal; Hari; [Toko]\n' +
          'Contoh: /langganan tambah Netflix; Hiburan; 54000; 1'
        );
      }
      const nominal = await parseAmountToNumber(parts[2]);
      const hari = Number(parts[3]);
      if (!nominal || !Number.isInteger(hari) || hari < 1 || hari > 31) {
        return ctx.reply('Nominal/Hari tidak valid (Hari = 1-31).');
      }
      await addLangganan({
        nama: parts[0],
        kategori: parts[1],
        nominal,
        hari,
        toko: parts[4] || 'Lainnya',
        catatan: ''
      });
      return ctx.reply(
        `Langganan "${parts[0]}" ditambahkan: ${formatRupiah(nominal)} setiap tanggal ${hari}.`
      );
    }

    // /langganan hapus Nama
    if (/^hapus\b/i.test(arg)) {
      const nama = arg.replace(/^hapus\s*/i, '').trim();
      if (!nama) return ctx.reply('Format: /langganan hapus <nama>');
      const ok = await deleteLangganan(nama);
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

    const lines = ['Langganan / Tagihan Rutin 🔁', ''];
    for (const l of list) {
      lines.push(`- ${l.nama} (${l.kategori}): ${formatRupiah(l.nominal)} tiap tgl ${l.hari}`);
    }
    lines.push('');
    lines.push('Tambah: /langganan tambah Nama; Kategori; Nominal; Hari');
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
      [e.kategori, e.toko, e.catatan, e.pencatat]
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
      const tokoLabel = e.toko ? ` | ${e.toko}` : '';
      lines.push(`${e.tanggal} | ${e.kategori}${tokoLabel} | ${nilai}`);
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

    const client = await auth.getClient();
    const sheets = google.sheets({ version: 'v4', auth: client });
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: config.spreadsheetId,
      range: `'${getSheetName()}'!A:G`
    });
    const rows = res.data.values || [];
    if (rows.length <= 1) {
      return ctx.reply('Belum ada data untuk diekspor.');
    }

    const esc = (v) => {
      const s = String(v == null ? '' : v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const csv = rows.map((r) => r.map(esc).join(',')).join('\n');
    const buffer = Buffer.from('﻿' + csv, 'utf8');

    const tz = getTimezone();
    const stamp = new Date().toLocaleDateString('en-CA', { timeZone: tz });

    return ctx.replyWithDocument({
      source: buffer,
      filename: `rekap-keuangan-${stamp}.csv`
    });
  } catch (err) {
    logError('Gagal ekspor data.', err);
    return ctx.reply('Gagal ekspor data.');
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

    await ctx.reply('Membaca struk... 🧾');

    const link = await ctx.telegram.getFileLink(fileId);
    const res = await fetch(link.href);
    if (!res.ok) {
      throw new Error('Gagal mengunduh gambar dari Telegram');
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    const base64Data = buffer.toString('base64');

    const parsed = await parseReceiptImage(base64Data, mediaType);
    logInfo('Hasil baca struk: ' + JSON.stringify(parsed));

    // Jika total terbaca, anggap struk valid (model benar-benar "melihat" gambar).
    const total = parsed ? coerceAmountNumber(parsed.total) : 0;
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

    const pending = {
      tanggal,
      kategori: normalizeCategory(parsed.kategori || '', 'pengeluaran'),
      toko: (parsed.toko || '').trim(),
      total: Math.round(total),
      items: Array.isArray(parsed.items) ? parsed.items : [],
      pencatat: getUserName(ctx)
    };

    const id = Math.random().toString(36).slice(2, 8);
    pendingReceipts.set(id, pending);

    return ctx.reply(
      buildReceiptSummary(pending) +
        '\n\nGanti kategori bila perlu, lalu tekan Simpan:',
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
    const tglRow = parsed.tanggal || todayStr;

    await appendRow([
      tglRow,
      parsed.category,
      toko,
      pemasukan,
      pengeluaran,
      parsed.catatan || '',
      pencatat
    ]);

    if (parsed.type === 'pengeluaran') expenseCats.add(parsed.category);

    const tokoLabel = toko ? ` | toko: ${toko}` : '';
    const noteLabel = parsed.catatan ? ` | #${parsed.catatan}` : '';
    successLines.push(
      `${parsed.type} | ${parsed.category}${tokoLabel} | ${parsed.amountText}${noteLabel}`
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
    reply += 'Tersimpan ✅\n' + successLines.join('\n');
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
      'Baris gagal dibaca:\n' +
      failedLines.map((line) => `- ${line}`).join('\n');
  }

  if (!reply) {
    reply =
      'Format tidak terbaca.\n' +
      'Contoh:\n' +
      '- keluar makan 100000\n' +
      '- keluar makan 100000 di warung agam\n' +
      '- masuk gaji 5jt';
  }

  return reply;
}

async function handleKeywordText(ctx, text) {
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
    await ctx.reply(`Budget ${canon} diatur: ${formatRupiah(amount)} / bulan.`);
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
      `Target "${t.nama}" diatur: ${formatRupiah(amount)}.\n` +
      `Tabung dengan: nabung ${t.nama} <nominal>`
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
    await ctx.reply(
      `Nabung ${formatRupiah(amount)} ke "${t.nama}".\n` +
      `Progress: ${formatRupiah(t.terkumpul)} / ${formatRupiah(t.target)} (${pct}%)`
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
    return ctx.reply('Gagal memproses pesan.');
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
    if (!isOwner(ctx)) {
      await ctx.answerCbQuery('Tidak diizinkan');
      return;
    }

    const data = (ctx.callbackQuery && ctx.callbackQuery.data) || '';
    const parts = data.split('|');

    // Konfirmasi hapus transaksi terakhir
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
        await formatSheetLayout();
        try { await updateAnalisaSheet(); } catch (e) { logError('Gagal update analisa.', e); }
        const nilai = deleted.pemasukan || deleted.pengeluaran || '';
        const tokoLabel = deleted.toko ? ` | ${deleted.toko}` : '';
        try {
          await ctx.editMessageText(
            'Transaksi dihapus 🗑️\n' +
            `${deleted.tanggal} | ${deleted.kategori}${tokoLabel} | ${nilai}`
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
          buildReceiptSummary(pending) + '\n\nGanti kategori bila perlu, lalu tekan Simpan:',
          { reply_markup: receiptKeyboard(id, cat) }
        );
      } catch (e) {}
      return;
    }

    if (action === 'save') {
      await ctx.answerCbQuery('Menyimpan...');
      await ensureHeader();
      const pengeluaran = 'Rp' + Math.round(pending.total).toLocaleString('id-ID');
      await appendRow([
        pending.tanggal,
        pending.kategori,
        pending.toko || 'Lainnya',
        '',
        pengeluaran,
        'Struk',
        pending.pencatat || getUserName(ctx)
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
        await ctx.editMessageText(buildReceiptSummary(pending) + '\n\nTersimpan ✅' + alert);
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

async function broadcast(message) {
  for (const chatId of getOwnerChatIds()) {
    try {
      await bot.telegram.sendMessage(chatId, message);
    } catch (e) {
      logError(`Gagal kirim pesan terjadwal ke ${chatId}.`, e);
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

    // Laporan bulanan otomatis (tanggal 1, untuk bulan sebelumnya)
    const monthKey = `${year}-${String(month).padStart(2, '0')}`;
    if (
      monthlyReportEnabled &&
      day === 1 &&
      hour === monthlyReportHour &&
      lastMonthlyReportKey !== monthKey
    ) {
      lastMonthlyReportKey = monthKey;
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
          await broadcast(lines.join('\n'));
        }
      } catch (e) {
        logError('Gagal kirim laporan bulanan.', e);
      }
    }

    // Langganan jatuh tempo
    if (hour === langgananHour && lastLanggananDate !== dateKey) {
      lastLanggananDate = dateKey;
      try {
        const posted = await runDueLangganan(day, month, year);
        if (posted.length > 0) {
          await broadcast(
            'Langganan dicatat otomatis hari ini ✅\n' +
            posted.map((l) => `- ${l.nama}: ${formatRupiah(l.nominal)}`).join('\n')
          );
        }
      } catch (e) {
        logError('Gagal proses langganan terjadwal.', e);
      }
    }

    // Reminder harian
    if (reminderEnabled && hour === reminderHour && lastReminderDate !== dateKey) {
      lastReminderDate = dateKey;
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
        await broadcast(msg);
      } catch (e) {
        logError('Gagal kirim reminder.', e);
      }
    }
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
      { command: 'saldo', description: 'Saldo total & bulan ini' },
      { command: 'hari', description: 'Rekap hari ini' },
      { command: 'minggu', description: 'Rekap 7 hari terakhir' },
      { command: 'bulan', description: 'Rekap bulan ini' },
      { command: 'laporan', description: 'Laporan + grafik + proyeksi' },
      { command: 'analisa', description: 'Analisa lengkap + grafik' },
      { command: 'budget', description: 'Lihat budget & pemakaian' },
      { command: 'target', description: 'Lihat target tabungan' },
      { command: 'langganan', description: 'Kelola tagihan rutin' },
      { command: 'hutang', description: 'Catatan hutang & piutang' },
      { command: 'cari', description: 'Cari transaksi' },
      { command: 'export', description: 'Ekspor data ke CSV' },
      { command: 'edit', description: 'Edit transaksi terakhir' },
      { command: 'hapus', description: 'Hapus transaksi terakhir' }
    ]);
    logInfo('Menu perintah Telegram terpasang.');
  } catch (e) {
    logError('Gagal memasang menu perintah.', e);
  }
}

logInfo('Started bot...');

bot.launch().then(() => {
  registerBotCommands();
}).catch((err) => {
  logError('Launch error:', err);
});

// Cek setiap menit
setInterval(schedulerTick, 60 * 1000);

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
