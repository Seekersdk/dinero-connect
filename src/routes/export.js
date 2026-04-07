const express = require('express');
const fs = require('fs');
const path = require('path');
const { getOrder } = require('../services/shopify');
const { findOrCreateContact, createInvoice } = require('../services/dinero');
const config = require('../config');
const shopifyAuth = require('../middleware/shopifyAuth');

const router = express.Router();
router.use(shopifyAuth);
const EXPORTED_FILE = path.join(__dirname, '../../.exported.json');

function getExported() {
  try {
    return JSON.parse(fs.readFileSync(EXPORTED_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function markExported(orderId, dineroId) {
  const exported = getExported();
  exported[orderId] = { dineroId, exportedAt: new Date().toISOString() };
  fs.writeFileSync(EXPORTED_FILE, JSON.stringify(exported, null, 2));
}

router.post('/', async (req, res, next) => {
  try {
    if (!config.dinero.clientId) {
      return res.status(503).json({ error: 'Dinero credentials ikke konfigureret endnu' });
    }

    const { orderIds } = req.body;
    if (!Array.isArray(orderIds) || orderIds.length === 0) {
      return res.status(400).json({ error: 'orderIds mangler' });
    }

    const exported = getExported();
    const results = [];

    for (const orderId of orderIds) {
      if (exported[orderId]) {
        results.push({ orderId, status: 'already_exported', dineroId: exported[orderId].dineroId });
        continue;
      }

      try {
        const order = await getOrder(orderId);
        const contactGuid = await findOrCreateContact(order);
        const invoice = await createInvoice(contactGuid, order);
        markExported(orderId, invoice.Guid);
        results.push({ orderId, status: 'success', dineroId: invoice.Guid });
      } catch (err) {
        results.push({ orderId, status: 'error', error: err.message });
      }
    }

    res.json(results);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
