const axios = require('axios');
const fs = require('fs');
const path = require('path');
const config = require('../config');

const TOKEN_FILE = path.join('/app/data', '.token');

function getStoredToken() {
  try {
    return fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  } catch {
    return null;
  }
}

function storeToken(token) {
  fs.mkdirSync('/app/data', { recursive: true });
  fs.writeFileSync(TOKEN_FILE, token, 'utf8');
}

function getClient() {
  const token = getStoredToken();
  if (!token) throw new Error('Ingen Shopify access token — gå til /auth for at autorisere');

  return axios.create({
    baseURL: `https://${config.shopify.store}/admin/api/${config.shopify.apiVersion}/`,
    headers: {
      'X-Shopify-Access-Token': token,
      'Content-Type': 'application/json',
    },
  });
}

async function getOrders(params = {}) {
  const client = getClient();
  const allOrders = [];
  let url = 'orders.json';
  let queryParams = {
    status: 'any',
    limit: 250,
    fields: 'id,name,email,created_at,total_price,currency,financial_status,customer,billing_address,line_items',
    ...params,
  };

  do {
    const response = await client.get(url, { params: queryParams });
    allOrders.push(...response.data.orders);

    // Shopify paginering via Link header
    const link = response.headers.link || response.headers.Link || '';
    const nextMatch = link.match(/<([^>]+)>;\s*rel="next"/);
    if (nextMatch && allOrders.length < 1000) {
      // Brug fuld URL fra Link header
      url = nextMatch[1].replace(client.defaults.baseURL, '');
      queryParams = {}; // params er i URL'en
    } else {
      break;
    }
  } while (true);

  return allOrders;
}

async function getOrder(orderId) {
  const client = getClient();
  const response = await client.get(`orders/${orderId}.json`);
  return response.data.order;
}

async function addTagToOrder(orderId, tag) {
  const client = getClient();
  const order = await getOrder(orderId);
  const existingTags = order.tags ? order.tags.split(', ') : [];
  if (existingTags.includes(tag)) return;
  existingTags.push(tag);
  await client.put(`orders/${orderId}.json`, {
    order: { id: orderId, tags: existingTags.join(', ') },
  });
}

async function removeTagFromOrder(orderId, tag) {
  const client = getClient();
  const order = await getOrder(orderId);
  const existingTags = order.tags ? order.tags.split(', ') : [];
  const filtered = existingTags.filter(t => t !== tag);
  if (filtered.length === existingTags.length) return; // tag var der ikke
  await client.put(`orders/${orderId}.json`, {
    order: { id: orderId, tags: filtered.join(', ') },
  });
}

async function orderHasTag(orderId, tag) {
  const client = getClient();
  const response = await client.get(`orders/${orderId}.json`, {
    params: { fields: 'id,tags' },
  });
  const tags = response.data.order.tags ? response.data.order.tags.split(', ') : [];
  return tags.includes(tag);
}

/**
 * Batch-hent tags for flere ordrer (maks 250 pr. kald).
 * Returnerer Map<orderId, Set<tag>>.
 */
async function getOrderTagsBatch(orderIds) {
  if (orderIds.length === 0) return new Map();
  const client = getClient();
  const tagMap = new Map();

  // Shopify tillader op til 250 IDs pr. kald
  for (let i = 0; i < orderIds.length; i += 250) {
    const batch = orderIds.slice(i, i + 250);
    const response = await client.get('orders.json', {
      params: {
        ids: batch.join(','),
        fields: 'id,tags',
        status: 'any',
        limit: 250,
      },
    });
    for (const order of response.data.orders) {
      const tags = order.tags ? new Set(order.tags.split(', ')) : new Set();
      tagMap.set(String(order.id), tags);
    }
  }

  return tagMap;
}

// --- Shopify Payments (payouts) ---

async function getPayouts(params = {}) {
  const client = getClient();
  const response = await client.get('shopify_payments/payouts.json', { params });
  return response.data.payouts || [];
}

async function getPayout(payoutId) {
  const client = getClient();
  const response = await client.get(`shopify_payments/payouts/${payoutId}.json`);
  return response.data.payout;
}

async function getPayoutTransactions(payoutId) {
  const client = getClient();
  const allTransactions = [];
  let sinceId = null;

  // Paginate through all transactions for this payout
  do {
    const params = { payout_id: payoutId, limit: 250 };
    if (sinceId) params.since_id = sinceId;

    const response = await client.get('shopify_payments/balance/transactions.json', { params });
    const txns = response.data.transactions || [];
    if (txns.length === 0) break;

    allTransactions.push(...txns);
    sinceId = txns[txns.length - 1].id;

    if (txns.length < 250) break;
  } while (true);

  return allTransactions;
}

// --- GraphQL support for metafields ---

function graphqlClient() {
  const token = getStoredToken();
  if (!token) throw new Error('Ingen Shopify access token — gå til /auth for at autorisere');
  return { token };
}

async function shopifyGraphQL(query, variables = {}) {
  const { token } = graphqlClient();
  const response = await axios.post(
    `https://${config.shopify.store}/admin/api/${config.shopify.apiVersion}/graphql.json`,
    { query, variables },
    {
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token,
      },
    }
  );

  if (response.data.errors) {
    throw new Error(`GraphQL errors: ${JSON.stringify(response.data.errors)}`);
  }
  return response.data.data;
}

async function getOrderTransactions(orderId) {
  const client = getClient();
  const response = await client.get(`orders/${orderId}/transactions.json`);
  return response.data.transactions || [];
}

const ORDER_MARGIN_QUERY = `
  query ($id: ID!) {
    order(id: $id) {
      metafield(namespace: "finance", key: "margin_summary") {
        value
      }
    }
  }
`;

async function getOrderMarginData(orderId) {
  const gid = `gid://shopify/Order/${orderId}`;
  const data = await shopifyGraphQL(ORDER_MARGIN_QUERY, { id: gid });
  if (!data.order?.metafield?.value) return null;
  return JSON.parse(data.order.metafield.value);
}

module.exports = { getOrders, getOrder, getStoredToken, storeToken, addTagToOrder, removeTagFromOrder, orderHasTag, getOrderTagsBatch, getOrderMarginData, getOrderTransactions, getPayouts, getPayout, getPayoutTransactions };
