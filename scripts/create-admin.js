// Usage: npm run create-admin -- admin@dixeltechnologies.com "Full Name" [password]
// If the password is omitted you will be prompted (input is visible; run in a trusted terminal).
const readline = require('readline');
const bcrypt = require('bcryptjs');
const cfg = require('../src/config');
const db = require('../src/db');
const S = require('../src/security');

(async () => {
  const email = S.normEmail(process.argv[2]);
  const name = (process.argv[3] || '').trim();
  let password = process.argv[4];
  const ep = S.emailProblem(email);
  if (ep || !name) {
    console.error(`Usage: npm run create-admin -- name@${cfg.companyDomain} "Full Name" [password]\n${ep || 'Full name is required.'}`);
    process.exit(1);
  }
  if (!password) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    password = await new Promise((r) => rl.question('Password (10+ chars, upper, lower, number): ', (a) => { rl.close(); r(a); }));
  }
  const pp = S.passwordProblem(password);
  if (pp) { console.error(pp); process.exit(1); }
  const hash = await bcrypt.hash(password, 12);
  const now = Date.now();
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) {
    db.prepare("UPDATE users SET role='admin', status='active', password_hash=?, full_name=?, email_verified_at=COALESCE(email_verified_at,?) WHERE id=?").run(hash, name, now, existing.id);
    console.log(`Updated existing account ${email} to administrator.`);
  } else {
    db.prepare("INSERT INTO users (full_name,email,password_hash,role,status,email_verified_at,created_at) VALUES (?,?,?,'admin','active',?,?)").run(name, email, hash, now, now);
    console.log(`Created administrator ${email}.`);
  }
  db.audit(null, 'admin_created_via_cli', email);
})();
