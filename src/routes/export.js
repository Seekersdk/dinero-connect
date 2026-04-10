const express = require('express');
const { getOrder, addTagToOrder, orderHasTag, getOrderMarginData, getOrderTransactions } = require('../services/shopify');
const { findOrCreateContact, createInvoice } = require('../services/dinero');
const invoiceStore = require('../services/invoiceStore');
const config = require('../config');
const shopifyAuth = require('../middleware/shopifyAuth');

const router = express.Router();
router.use(shopifyAuth);

const TAG = 'Bogført';

router.post('/', async (req, res, next) => {
  try {
    if (!config.dinero.clientId) {
      return res.status(503).json({ error: 'Dinero credentials ikke konfigureret endnu' });
    }

    const { orderIds } = req.body;
    if (!Array.isArray(orderIds) || orderIds.length === 0) {
      return res.status(400).json({ error: 'orderIds mangler' });
    }

    const results = [];

    for (const orderId of orderIds) {
      try {
        if (await orderHasTag(orderId, TAG)) {
          results.push({ orderId, status: 'already_exported' });
          continue;
        }

        const order = await getOrder(orderId);
        const [marginData, transactions] = await Promise.all([
          getOrderMarginData(orderId),
          getOrderTransactions(orderId),
        ]);
        const contactGuid = await findOrCreateContact(order);
        const invoice = await createInvoice(contactGuid, order, marginData, transactions);
        invoiceStore.set(orderId, { ...invoice, orderName: order.name });
        await addTagToOrder(orderId, TAG);
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
