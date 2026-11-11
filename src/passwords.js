const bcrypt = require('bcryptjs');

const BCRYPT_COST = 12;

function hashPassword(password) {
  return bcrypt.hash(password, BCRYPT_COST);
}

module.exports = { BCRYPT_COST, hashPassword };
