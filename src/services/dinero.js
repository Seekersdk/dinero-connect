const axios = require('axios');
const config = require('../config');

let tokenCache = { accessToken: null, expiresAt: null };

async function getAccessToken() {
  if (tokenCache.accessToken && tokenCache.expiresAt > Date.now() + 5 * 60 * 1000) {
    return tokenCache.accessToken;
  }

  const credentials = Buffer.from(`${config.dinero.clientId}:${config.dinero.clientSecret}`).toString('base64');

  const response = await axios.post(
    'https://authz.dinero.dk/dineroapi/oauth/token',
    'grant_type=password&scope=read write&username=' + config.dinero.apiKey + '&password=' + config.dinero.apiKey,
    {
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    }
  );

  tokenCache.accessToken = response.data.access_token;
  tokenCache.expiresAt = Date.now() + response.data.expires_in * 1000;

  return tokenCache.accessToken;
}

function createClient() {
  const client = axios.create({
    baseURL: `https://api.dinero.dk/v1/${config.dinero.organizationId}/`,
    headers: { 'Content-Type': 'application/json' },
  });

  client.interceptors.request.use(async (req) => {
    const token = await getAccessToken();
    req.headers.Authorization = `Bearer ${token}`;
    return req;
  });

  return client;
}

async function findOrCreateContact(order) {
  const client = createClient();
  const email = order.email || order.customer?.email;

  if (email) {
    const search = await client.get(`contacts?queryFilter=${encodeURIComponent(email)}`);
    if (search.data?.Collection?.length > 0) {
      return search.data.Collection[0].ContactGuid;
    }
  }

  const billing = order.billing_address || {};
  const response = await client.post('contacts', {
    Name: billing.name || order.customer?.first_name + ' ' + order.customer?.last_name || 'Ukendt',
    Email: email || '',
    Street: billing.address1 || '',
    City: billing.city || '',
    ZipCode: billing.zip || '',
    CountryKey: billing.country_code || 'DK',
    IsPerson: true,
  });

  return response.data.ContactGuid;
}

async function createInvoice(contactGuid, order) {
  const client = createClient();
  const { mapOrderToInvoice } = require('./mapper');
  const payload = mapOrderToInvoice(contactGuid, order);
  const response = await client.post('invoices', payload);
  return response.data;
}

module.exports = { findOrCreateContact, createInvoice };
