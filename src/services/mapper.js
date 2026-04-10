const settings = require('./settings');
const { round2 } = require('../utils');

/**
 * Map en Shopify-ordre til en Dinero-faktura.
 *
 * Kontotyper:
 *   sale          → Total salg — hele beløbet uden moms
 *   transactionFee→ Transaktionsgebyr — fra Shopify Payments transactions
 *   giftCard      → Gavekort — line_items med gift_card=true
 *   cashCard      → Kontant/kreditkort — betalinger via kort/kontant
 *   storeCredit   → Store credit — betalinger via store credit
 *
 * Brugtmoms håndteres separat via manuelt bilag (voucherService).
 */
function mapOrderToInvoice(contactGuid, order, marginData, transactions) {
  const date = order.created_at.substring(0, 10);
  const { accounts } = settings.load();

  const saleAccount = accounts.sale?.accountNumber || 1000;
  const feeAccount = accounts.transactionFee?.accountNumber;
  const giftCardAccount = accounts.giftCard?.accountNumber;
  const cashCardAccount = accounts.cashCard?.accountNumber;
  const storeCreditAccount = accounts.storeCredit?.accountNumber;

  const productLines = [];

  // --- Produktlinjer ---
  for (const item of order.line_items) {
    // Gavekort → separat konto uden moms
    if (item.gift_card && giftCardAccount) {
      productLines.push({
        Description: item.title,
        Quantity: item.quantity,
        Unit: 'parts',
        BaseAmountValue: parseFloat(item.price),
        AccountNumber: giftCardAccount,
        VatScale: 'DK0',
      });
      continue;
    }

    // Hele beløbet på salgskonto uden moms (brugtmoms bogføres via separat bilag)
    productLines.push({
      Description: item.title,
      Quantity: item.quantity,
      Unit: 'parts',
      BaseAmountValue: parseFloat(item.price),
      AccountNumber: saleAccount,
      VatScale: 'DK0',
    });
  }

  // --- Transaktioner (betalinger + gebyrer) ---
  const txns = (transactions || []).filter(t => t.kind === 'sale' && t.status === 'success');

  for (const txn of txns) {
    const gateway = (txn.gateway || '').toLowerCase();

    // Transaktionsgebyr fra Shopify Payments
    if (feeAccount && txn.fee) {
      const fee = parseFloat(txn.fee);
      if (fee > 0) {
        productLines.push({
          Description: `Transaktionsgebyr (${txn.gateway})`,
          Quantity: 1,
          Unit: 'parts',
          BaseAmountValue: round2(-fee),
          AccountNumber: feeAccount,
          VatScale: 'DK0',
        });
      }
    }

    // Store credit betaling
    if (storeCreditAccount && (gateway === 'store_credit' || gateway === 'storecredit')) {
      productLines.push({
        Description: 'Store credit betaling',
        Quantity: 1,
        Unit: 'parts',
        BaseAmountValue: round2(-parseFloat(txn.amount)),
        AccountNumber: storeCreditAccount,
        VatScale: 'DK0',
      });
    }

    // Kontant/kreditkort betaling
    if (cashCardAccount && gateway !== 'store_credit' && gateway !== 'storecredit' && gateway !== 'gift_card') {
      productLines.push({
        Description: `Betaling (${txn.gateway})`,
        Quantity: 1,
        Unit: 'parts',
        BaseAmountValue: round2(-parseFloat(txn.amount)),
        AccountNumber: cashCardAccount,
        VatScale: 'DK0',
      });
    }
  }

  return {
    ContactGuid: contactGuid,
    Currency: order.currency || 'DKK',
    Language: 'da-DK',
    Date: date,
    ProductLines: productLines,
    Comment: `Shopify ordre ${order.name}`,
    ShowLinesInclVat: false,
  };
}

module.exports = { mapOrderToInvoice };
