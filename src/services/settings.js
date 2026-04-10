const fs = require('fs');
const path = require('path');

const SETTINGS_FILE = path.join('/app/data', 'settings.json');

const DEFAULT_SETTINGS = {
  accounts: {
    sale: { accountNumber: null, label: 'Total salg' },
    usedVat: { accountNumber: null, label: 'Brugtmoms' },
    transactionFee: { accountNumber: null, label: 'Transaktionsgebyr' },
    giftCard: { accountNumber: null, label: 'Gavekort' },
    cashCard: { accountNumber: null, label: 'Kontant/kreditkort' },
    storeCredit: { accountNumber: null, label: 'Store credit' },
    vatLiability: { accountNumber: null, label: 'Moms konto (brugtmoms)' },
  },
};

function load() {
  try {
    const data = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    // Merge with defaults so new keys are always present
    return {
      accounts: { ...DEFAULT_SETTINGS.accounts, ...data.accounts },
    };
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

function save(settings) {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
}

module.exports = { load, save, DEFAULT_SETTINGS };
