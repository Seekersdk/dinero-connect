const express = require('express');
const { getOrders } = require('../services/shopify');
const shopifyAuth = require('../middleware/shopifyAuth');

const router = express.Router();
router.use(shopifyAuth);

router.get('/', async (req, res, next) => {
  try {
    const { financial_status, created_at_min, created_at_max } = req.query;
    const orders = await getOrders({
      financial_status: financial_status || 'paid',
      created_at_min,
      created_at_max,
    });
    res.json(orders);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
