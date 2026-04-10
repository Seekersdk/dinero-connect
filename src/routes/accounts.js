const express = require('express');
const shopifyAuth = require('../middleware/shopifyAuth');

const router = express.Router();
router.use(shopifyAuth);

router.get('/', async (req, res, next) => {
  try {
    const { getClient } = require('../services/dinero');
    const client = getClient();
    const response = await client.get('accounts/entry');
    res.json(response.data.Collection || response.data);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
