/**
 * Membuat Google Form "Pendaftaran Rekap Uang" secara otomatis.
 *
 * Cara pakai:
 *  1. Buka https://script.google.com  ->  New project
 *  2. Hapus isi default, tempel seluruh kode ini.
 *  3. Klik Run (pilih fungsi buatFormRekapUang). Izinkan akses saat diminta.
 *  4. Lihat Execution log: ada link "Edit" (untuk mengelola) dan "Isi"
 *     (link publik untuk dibagikan ke pelanggan).
 */
function buatFormRekapUang() {
  var GRUP = 'https://t.me/+D5IRzFMN2mM5NzM1';

  var form = FormApp.create('Pendaftaran Rekap Uang')
    .setDescription(
      'Terima kasih sudah memesan Rekap Uang!\n' +
      'Isi form singkat ini agar akun & Google Sheet kamu bisa kami siapkan.\n' +
      'Pastikan email yang diisi benar (untuk akses Google Sheet).'
    )
    .setConfirmationMessage(
      'Pendaftaran diterima! Akun & Google Sheet kamu sedang kami siapkan. ' +
      'Cek email & grup Telegram untuk info selanjutnya. ' +
      'Terima kasih — Rekap Uang, Rapikan Keuanganmu.'
    )
    .setProgressBar(false);

  // 1) Langkah 1: Join grup Telegram + ketik DAFTAR (checkbox wajib)
  var step1 = form.addCheckboxItem();
  step1.setTitle('Langkah 1: Join grup Telegram, lalu ketik "DAFTAR" di chat grup')
       .setHelpText(
         'Buka grup: ' + GRUP + '\n' +
         'Setelah masuk, ketik DAFTAR di chat grup untuk verifikasi.'
       )
       .setChoiceValues(['Saya sudah join grup dan menulis "DAFTAR" di chat'])
       .setRequired(true);

  // 2) Nama lengkap (jawaban singkat, wajib)
  form.addTextItem()
      .setTitle('Nama lengkap')
      .setHelpText('Sesuai nama yang ingin dipakai pada akun.')
      .setRequired(true);

  // 3) Alamat email (jawaban singkat + validasi email, wajib)
  var emailItem = form.addTextItem()
      .setTitle('Alamat email (untuk akses Google Sheet)')
      .setHelpText('Gunakan email Google/Gmail aktif. Google Sheet keuanganmu ' +
                   'akan dibagikan ke email ini sebagai Editor.')
      .setRequired(true);
  var emailRule = FormApp.createTextValidation()
      .setHelpText('Masukkan alamat email yang valid.')
      .requireTextIsEmail()
      .build();
  emailItem.setValidation(emailRule);

  // 4) Paket yang dibeli (pilihan ganda, wajib)
  form.addMultipleChoiceItem()
      .setTitle('Paket yang kamu beli')
      .setChoiceValues(['Bulanan', 'Tahunan', 'Lifetime'])
      .setRequired(true);

  // 5) Username Telegram (opsional)
  form.addTextItem()
      .setTitle('Username Telegram (opsional)')
      .setHelpText('Mis. @namakamu - membantu kami verifikasi & mempercepat aktivasi akun.');

  Logger.log('Form dibuat!');
  Logger.log('Link kelola (Edit): ' + form.getEditUrl());
  Logger.log('Link isi (bagikan): ' + form.getPublishedUrl());
}
