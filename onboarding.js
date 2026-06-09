/**
 * Onboarding pelanggan: salin spreadsheet template & bagikan ke email pelanggan.
 *
 * Prasyarat:
 *   - Google Drive API & Sheets API aktif untuk service account.
 *   - rekap-credentials.json (service account) ada.
 *   - Service account sudah jadi Editor di spreadsheet TEMPLATE.
 *
 * Pemakaian:
 *   node onboarding.js copy  <TEMPLATE_ID> <email_pelanggan> "<Nama>"
 *   node onboarding.js share <SPREADSHEET_ID> <email_pelanggan>
 *   node onboarding.js whoami        (tampilkan email service account)
 *
 * Catatan: service account biasa (tanpa Google Workspace/Shared Drive) bisa
 * kena limit "storageQuotaExceeded" saat 'copy'. Solusi: taruh template di
 * Shared Drive, ATAU lakukan "Buat salinan" manual lalu pakai mode 'share'.
 */
const fs = require('fs');
const { google } = require('googleapis');

const config = (() => {
  try { return require('./rekap.json'); } catch (_) { return {}; }
})();
const credFile = config.credentialsFile || './rekap-credentials.json';

const auth = new google.auth.GoogleAuth({
  keyFile: credFile,
  scopes: [
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/spreadsheets',
  ],
});

function saEmail() {
  try { return JSON.parse(fs.readFileSync(credFile, 'utf8')).client_email; }
  catch (_) { return '(tidak terbaca)'; }
}

async function shareTo(drive, fileId, email, role = 'writer') {
  await drive.permissions.create({
    fileId,
    sendNotificationEmail: true,
    supportsAllDrives: true,
    requestBody: { type: 'user', role, emailAddress: email },
  });
}

async function main() {
  const [mode, a1, a2, a3] = process.argv.slice(2);
  const client = await auth.getClient();
  const drive = google.drive({ version: 'v3', auth: client });

  if (mode === 'whoami') {
    console.log('Service account email:', saEmail());
    console.log('Pastikan email ini jadi Editor di template & tiap sheet pelanggan.');
    return;
  }

  if (mode === 'share') {
    if (!a1 || !a2) return console.log('Pakai: node onboarding.js share <SPREADSHEET_ID> <email>');
    await shareTo(drive, a1, a2, 'writer');
    console.log(`OK. Sheet ${a1} dibagikan ke ${a2} (Editor).`);
    console.log(`\nJalankan di bot:\n/daftar <TelegramID>; <Nama>; ${a2}; ${a1}; <AktifSampai>`);
    return;
  }

  if (mode === 'copy') {
    if (!a1 || !a2) return console.log('Pakai: node onboarding.js copy <TEMPLATE_ID> <email> "<Nama>"');
    const nama = a3 || a2;
    const copy = await drive.files.copy({
      fileId: a1,
      supportsAllDrives: true,
      requestBody: { name: nama },
    });
    const newId = copy.data.id;
    await shareTo(drive, newId, a2, 'writer');
    console.log('Berhasil! Spreadsheet baru dibuat & dibagikan.');
    console.log('Spreadsheet ID :', newId);
    console.log('Link           : https://docs.google.com/spreadsheets/d/' + newId + '/edit');
    console.log('Dibagikan ke   :', a2, '(Editor)');
    console.log(`\nJalankan di bot:\n/daftar <TelegramID>; ${nama}; ${a2}; ${newId}; <AktifSampai>`);
    return;
  }

  console.log('Mode tidak dikenal.\n' +
    '  node onboarding.js copy  <TEMPLATE_ID> <email> "<Nama>"\n' +
    '  node onboarding.js share <SPREADSHEET_ID> <email>\n' +
    '  node onboarding.js whoami');
}

main().catch((e) => {
  console.error('ERROR:', e.errors ? JSON.stringify(e.errors) : e.message);
  if (String(e.message || '').includes('storageQuota')) {
    console.error('Tips: service account kena limit storage. Pakai Shared Drive, ' +
      'atau "Buat salinan" manual di Google Drive lalu pakai mode "share".');
  }
  process.exit(1);
});
