require('dotenv').config();

const required = [
  'SHOPIFY_API_KEY',
  'SHOPIFY_API_SECRET',
  'SHOPIFY_STORE',
  'APP_URL',
  'AUTH_SECRET',
];

for (const key of required) {
  if (!process.env[key]) {
    throw new Error(`Mangler miljøvariabel: ${key}`);
  }
}

const dineroKeys = ['DINERO_API_KEY', 'DINERO_CLIENT_ID', 'DINERO_CLIENT_SECRET', 'DINERO_ORGANIZATION_ID'];
const missingDinero = dineroKeys.filter(k => !process.env[k]);
if (missingDinero.length > 0) {
  console.warn(`[Config] Dinero credentials mangler: ${missingDinero.join(', ')} — Dinero-funktioner vil fejle`);
}

module.exports = {
  port: process.env.PORT || 3000,
  appUrl: process.env.APP_URL,
  authSecret: process.env.AUTH_SECRET,
  shopify: {
    apiKey: process.env.SHOPIFY_API_KEY,
    apiSecret: process.env.SHOPIFY_API_SECRET,
    store: process.env.SHOPIFY_STORE,
    apiVersion: '2025-01',
  },
  dinero: {
    apiKey: process.env.DINERO_API_KEY,
    clientId: process.env.DINERO_CLIENT_ID,
    clientSecret: process.env.DINERO_CLIENT_SECRET,
    organizationId: process.env.DINERO_ORGANIZATION_ID,
  },
};
