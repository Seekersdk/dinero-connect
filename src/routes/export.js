const express = require('express');
const { getOrder, addTagToOrder, removeTagFromOrder, orderHasTag, getOrderMarginData, getOrderTransactions } = require('../services/shopify');
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
        // Dobbelt-check: tag OG invoiceStore
        if (invoiceStore.get(orderId) || await orderHasTag(orderId, TAG)) {
          results.push({ orderId, status: 'already_exported' });
          continue;
        }

        // Tag ordren FØR vi opretter i Dinero (forhindrer duplikater)
        await addTagToOrder(orderId, TAG);

        const order = await getOrder(orderId);
        const [marginData, transactions] = await Promise.all([
          getOrderMarginData(orderId),
          getOrderTransactions(orderId),
        ]);
        const contactGuid = await findOrCreateContact(order);
        const invoice = await createInvoice(contactGuid, order, marginData, transactions);
        invoiceStore.set(orderId, { ...invoice, orderName: order.name });
        results.push({ orderId, status: 'success', dineroId: invoice.Guid });
      } catch (err) {
        // Fjern tag igen hvis Dinero-kaldet fejlede
        try { await removeTagFromOrder(orderId, TAG); } catch { /* ignore */ }
        console.error(`[Export] Ordre ${orderId} fejlede:`, err.response?.data || err.message);
        results.push({ orderId, status: 'error', error: err.response?.data?.Message || err.message });
      }
    }

    res.json(results);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
