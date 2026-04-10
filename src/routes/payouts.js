const express = require('express');
const { listPayouts, reconcilePayout } = require('../services/payoutService');
const shopifyAuth = require('../middleware/shopifyAuth');

const router = express.Router();
router.use(shopifyAuth);

// Liste over payouts med valgfri datofilter
router.get('/', async (req, res, next) => {
  try {
    const params = {};
    if (req.query.date_min) params.date_min = req.query.date_min;
    if (req.query.date_max) params.date_max = req.query.date_max;
    if (req.query.status) params.status = req.query.status;

    const payouts = await listPayouts(params);
    res.json(payouts);
  } catch (err) {
    next(err);
  }
});

// Afstemning for en enkelt payout
router.get('/:id/reconcile', async (req, res, next) => {
  try {
    const result = await reconcilePayout(req.params.id);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
