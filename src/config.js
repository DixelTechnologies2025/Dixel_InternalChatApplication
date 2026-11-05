require('dotenv').config();
const path = require('path');

const bool = (v, d) => (v === undefined || v === '' ? d : ['1', 'true', 'yes'].includes(String(v).toLowerCase()));
const root = path.join(__dirname, '..');

module.exports = {
  root,
  port: parseInt(process.env.PORT || '3000', 10),
  appUrl: (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, ''),
  companyName: process.env.COMPANY_NAME || 'Dixel Technologies',
  companyDomain: (process.env.COMPANY_DOMAIN || 'dixeltechnologies.com').toLowerCase(),
  dbPath: path.resolve(root, process.env.DB_PATH || './data/chat.db'),
  sessionHours: parseInt(process.env.SESSION_HOURS || '12', 10),
  retentionDays: parseInt(process.env.RETENTION_DAYS || '365', 10),
  // Employees pre-registered by an admin can skip manual approval when their invite details match.
  autoApproveInvited: bool(process.env.AUTO_APPROVE_INVITED, true),
  cookieSecure: bool(process.env.COOKIE_SECURE, false),
  trustProxy: bool(process.env.TRUST_PROXY, false),
  isProd: process.env.NODE_ENV === 'production',
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: bool(process.env.SMTP_SECURE, false),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.MAIL_FROM || 'Dixel Pulse <no-reply@dixeltechnologies.com>',
  },
};
