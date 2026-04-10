const settings = require('./settings');

function round2(value) {
  return Math.round(value * 100) / 100;
}

/**
 * Map en Shopify-ordre til en Dinero-faktura.
 *
 * Kontotyper:
 *   sale          → Salg (uden moms – avance) — produktlinjer
 *   usedVat       → Brugtmoms — fra finance.margin_summary metafield
 *   transactionFee→ Transaktionsgebyr — fra Shopify Payments transactions
 *   giftCard      → Gavekort — line_items med gift_card=true
 *   cashCard      → Kontant/kreditkort — betalinger via kort/kontant
 *   storeCredit   → Store credit — betalinger via store credit
 */
function mapOrderToInvoice(contactGuid, order, marginData, transactions) {
  const date = order.created_at.substring(0, 10);
  const { accounts } = settings.load();

  const saleAccount = accounts.sale?.accountNumber || 1000;
  const usedVatAccount = accounts.usedVat?.accountNumber;
  const feeAccount = accounts.transactionFee?.accountNumber;
  const giftCardAccount = accounts.giftCard?.accountNumber;
  const cashCardAccount = accounts.cashCard?.accountNumber;
  const storeCreditAccount = accounts.storeCredit?.accountNumber;

  const productLines = [];

  // --- Margindata lookup (brugtmoms) ---
  const marginByTitle = {};
  if (marginData?.line_items) {
    for (const item of marginData.line_items) {
      marginByTitle[item.title] = item;
    }
  }

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

    const marginItem = marginByTitle[item.title];

    if (marginData && usedVatAccount && marginItem) {
      // Brugtmoms: avance → salgskonto, moms → brugtmomskonto
      productLines.push({
        Description: `${item.title} (avance)`,
        Quantity: 1,
        Unit: 'parts',
        BaseAmountValue: round2(marginItem.revenue),
        AccountNumber: saleAccount,
        VatScale: 'DK0',
      });

      if (marginItem.vat > 0) {
        productLines.push({
          Description: `${item.title} (brugtmoms)`,
          Quantity: 1,
          Unit: 'parts',
          BaseAmountValue: round2(marginItem.vat),
          AccountNumber: usedVatAccount,
          VatScale: 'DK0',
        });
      }
    } else {
      // Standard 25% moms
      const priceExVat = parseFloat(item.price) / 1.25;
      productLines.push({
        Description: item.title,
        Quantity: item.quantity,
        Unit: 'parts',
        BaseAmountValue: round2(priceExVat),
        AccountNumber: saleAccount,
        VatScale: 'DK25',
      });
    }
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
    Comment: `Shopify ordre ${order.name}${marginData ? ' (brugtmoms)' : ''}`,
    ShowLinesInclVat: false,
  };
}

module.exports = { mapOrderToInvoice };
