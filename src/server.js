const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const path = require('path');
const config = require('./config');
const errorHandler = require('./middleware/errorHandler');

const app = express();

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: [
    config.appUrl,
    `https://${config.shopify.store}`,
    /\.myshopify\.com$/,
  ],
}));
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

app.use('/auth', require('./routes/auth'));
app.use('/api/orders', require('./routes/orders'));
app.use('/api/export', require('./routes/export'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/accounts', require('./routes/accounts'));
app.use('/api/payouts', require('./routes/payouts'));
app.use('/api/vat', require('./routes/vat'));

app.get('/app', (req, res) => {
  const fs = require('fs');
  const html = fs.readFileSync(path.join(__dirname, '../public/app.html'), 'utf8')
    .replaceAll('__SHOPIFY_API_KEY__', config.shopify.apiKey)
    .replaceAll('__APP_URL__', config.appUrl);
  res.send(html);
});

app.get('/', (req, res) => res.redirect('/app'));

app.use(errorHandler);

app.listen(config.port, () => {
  console.log(`Server kører på port ${config.port}`);
  console.log(`Åbn ${config.appUrl}/auth for at autorisere Shopify`);
});
