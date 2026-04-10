const express = require('express');
const settings = require('../services/settings');
const shopifyAuth = require('../middleware/shopifyAuth');

const router = express.Router();
router.use(shopifyAuth);

router.get('/', (req, res) => {
  res.json(settings.load());
});

router.put('/', (req, res) => {
  const current = settings.load();
  const { accounts } = req.body;

  if (!accounts || typeof accounts !== 'object') {
    return res.status(400).json({ error: 'accounts objekt mangler' });
  }

  for (const [key, value] of Object.entries(accounts)) {
    if (current.accounts[key]) {
      current.accounts[key].accountNumber = value.accountNumber ?? null;
    }
  }

  settings.save(current);
  res.json(current);
});

module.exports = router;
