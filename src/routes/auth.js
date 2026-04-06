const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const config = require('../config');
const { storeToken } = require('../services/shopify');

const router = express.Router();
const stateStore = new Set();

router.get('/', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  stateStore.add(state);

  const params = new URLSearchParams({
    client_id: config.shopify.apiKey,
    scope: 'read_orders,read_customers,read_products',
    redirect_uri: `${config.appUrl}/auth/callback`,
    state,
  });

  res.redirect(`https://${config.shopify.store}/admin/oauth/authorize?${params}`);
});

router.get('/callback', async (req, res) => {
  const { hmac, state, code, ...rest } = req.query;

  if (!stateStore.has(state)) {
    return res.status(403).send('Ugyldig state parameter');
  }
  stateStore.delete(state);

  // Verificér HMAC - kun hmac fjernes fra beregningen
  const allParams = { state, code, ...rest };
  const message = Object.keys(allParams).sort().map(k => `${k}=${allParams[k]}`).join('&');
  const digest = crypto.createHmac('sha256', config.shopify.apiSecret).update(message).digest('hex');
  if (digest !== hmac) {
    return res.status(403).send('Ugyldig HMAC signatur');
  }

  // Byt code for access token
  const response = await axios.post(
    `https://${config.shopify.store}/admin/oauth/access_token`,
    {
      client_id: config.shopify.apiKey,
      client_secret: config.shopify.apiSecret,
      code,
    }
  );

  storeToken(response.data.access_token);
  res.redirect('/app');
});

module.exports = router;
