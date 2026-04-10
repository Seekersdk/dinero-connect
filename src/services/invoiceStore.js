const fs = require('fs');
const path = require('path');

const STORE_FILE = path.join('/app/data', 'invoice-map.json');

function load() {
  try {
    return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function save(data) {
  fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
  fs.writeFileSync(STORE_FILE, JSON.stringify(data, null, 2), 'utf8');
}

/** Gem kobling: Shopify orderId → Dinero faktura-info */
function set(orderId, invoiceData) {
  const map = load();
  map[String(orderId)] = {
    dineroGuid: invoiceData.Guid,
    dineroNumber: invoiceData.Number || null,
    orderName: invoiceData.orderName || null,
    exportedAt: new Date().toISOString(),
  };
  save(map);
}

/** Hent Dinero-faktura info for en ordre */
function get(orderId) {
  const map = load();
  return map[String(orderId)] || null;
}

/** Hent alle koblinger */
function getAll() {
  return load();
}

module.exports = { set, get, getAll };
