const express = require('express');
const shopifyAuth = require('../middleware/shopifyAuth');
const { collectPendingVat, postPendingVat, postSingleVat } = require('../services/voucherService');

const router = express.Router();
router.use(shopifyAuth);

/** Hent ventende ordrer med uposteret brugtmoms */
router.get('/pending', async (req, res, next) => {
  try {
    const pending = await collectPendingVat();
    res.json(pending);
  } catch (err) {
    next(err);
  }
});

/** Bogfør brugtmoms som manuelt bilag i Dinero */
router.post('/post', async (req, res, next) => {
  try {
    const result = await postPendingVat();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/** Bogfør brugtmoms for én enkelt ordre */
router.post('/post/:orderId', async (req, res, next) => {
  try {
    const result = await postSingleVat(req.params.orderId);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
