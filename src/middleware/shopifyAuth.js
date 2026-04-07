const crypto = require('crypto');
const config = require('../config');

function verifySessionToken(token) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Ugyldig token format');

  const [header, payload, signature] = parts;
  const expectedSig = crypto
    .createHmac('sha256', config.shopify.apiSecret)
    .update(`${header}.${payload}`)
    .digest('base64url');

  if (expectedSig !== signature) throw new Error('Ugyldig token signatur');

  const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString());
  if (decoded.exp < Math.floor(Date.now() / 1000)) throw new Error('Token udløbet');

  return decoded;
}

module.exports = (req, res, next) => {
  try {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Ikke autoriseret' });
    }
    req.shopifySession = verifySessionToken(auth.slice(7));
    next();
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
};
