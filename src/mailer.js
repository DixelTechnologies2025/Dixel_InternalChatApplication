const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const cfg = require('./config');

const transport = cfg.smtp.host
  ? nodemailer.createTransport({
      host: cfg.smtp.host,
      port: cfg.smtp.port,
      secure: cfg.smtp.secure,
      auth: cfg.smtp.user ? { user: cfg.smtp.user, pass: cfg.smtp.pass } : undefined,
    })
  : null;

async function sendMail({ to, subject, text }) {
  if (transport) {
    await transport.sendMail({ from: cfg.smtp.from, to, subject, text });
    return;
  }
  // Development fallback: no SMTP configured, so print the mail and append it to data/dev-mail.log.
  // Never use this mode in production because it writes links to disk.
  const entry = `\n--- ${new Date().toISOString()} ---\nTo: ${to}\nSubject: ${subject}\n\n${text}\n`;
  console.log(`[mail:dev] ${entry}`);
  fs.appendFileSync(path.join(path.dirname(cfg.dbPath), 'dev-mail.log'), entry);
}

module.exports = { sendMail, smtpConfigured: !!transport };
