const { getPayouts, getPayout, getPayoutTransactions, orderHasTag, addTagToOrder } = require('./shopify');
const { addPaymentToInvoice } = require('./dinero');
const invoiceStore = require('./invoiceStore');
const settings = require('./settings');

function round2(value) {
  return Math.round(value * 100) / 100;
}

/**
 * Hent payouts med datofilter.
 * Returnerer liste med payout-id, dato, beløb.
 */
async function listPayouts(params = {}) {
  return getPayouts(params);
}

/**
 * Byg afstemnings-objekt for en enkelt payout.
 *
 * Struktur:
 *   payout          — id, dato, beløb
 *   totals          — gross, fees, refunds, adjustments, net
 *   orders[]        — ordre-id, beløb, gebyr, net, + Dinero-faktura reference
 *   unmatched[]     — transaktioner vi ikke kunne koble til en ordre
 *   valid           — om sum(net) === payout amount
 */
async function reconcilePayout(payoutId) {
  const transactions = await getPayoutTransactions(payoutId);
  const invoiceMap = invoiceStore.getAll();

  let grossSales = 0;
  let totalFees = 0;
  let totalRefunds = 0;
  let totalAdjustments = 0;
  let totalNet = 0;

  const orderMap = {};  // orderId → aggregated data
  const unmatched = [];

  for (const txn of transactions) {
    const amount = parseFloat(txn.amount || 0);
    const fee = parseFloat(txn.fee || 0);
    const net = parseFloat(txn.net || 0);

    totalNet += net;

    switch (txn.type) {
      case 'charge':
        grossSales += amount;
        totalFees += fee;
        break;
      case 'refund':
        totalRefunds += amount; // amount is negative for refunds
        totalFees += fee;
        break;
      case 'adjustment':
      case 'payout':
        totalAdjustments += amount;
        break;
      default:
        totalAdjustments += amount;
        totalFees += fee;
        break;
    }

    // Kobl til ordre
    const sourceOrderId = txn.source_order_id;
    if (!sourceOrderId) {
      if (txn.type !== 'payout') {
        unmatched.push({
          transactionId: txn.id,
          type: txn.type,
          amount: round2(amount),
          fee: round2(fee),
          net: round2(net),
        });
      }
      continue;
    }

    if (!orderMap[sourceOrderId]) {
      const invoice = invoiceMap[String(sourceOrderId)];
      orderMap[sourceOrderId] = {
        orderId: sourceOrderId,
        dineroGuid: invoice?.dineroGuid || null,
        dineroNumber: invoice?.dineroNumber || null,
        orderName: invoice?.orderName || null,
        exported: !!invoice,
        paid: false,
        gross: 0,
        fees: 0,
        refunds: 0,
        net: 0,
      };
    }

    const entry = orderMap[sourceOrderId];
    entry.net += net;

    if (txn.type === 'charge') {
      entry.gross += amount;
      entry.fees += fee;
    } else if (txn.type === 'refund') {
      entry.refunds += amount;
      entry.fees += fee;
    }
  }

  // Tjek "Betalt" tag for hver ordre
  for (const entry of Object.values(orderMap)) {
    try {
      entry.paid = await orderHasTag(entry.orderId, 'Betalt');
    } catch { /* ignore */ }
  }

  // Afrund
  const orders = Object.values(orderMap).map(o => ({
    ...o,
    gross: round2(o.gross),
    fees: round2(o.fees),
    refunds: round2(o.refunds),
    net: round2(o.net),
  }));

  const payoutAmount = round2(totalNet);

  const result = {
    payoutId,
    totals: {
      gross: round2(grossSales),
      fees: round2(totalFees),
      refunds: round2(totalRefunds),
      adjustments: round2(totalAdjustments),
      net: round2(totalNet),
    },
    orders,
    unmatched,
    valid: true,
  };

  // Validering: tjek at ordrer + unmatched summerer til payout net
  const ordersNet = orders.reduce((sum, o) => sum + o.net, 0);
  const unmatchedNet = unmatched.reduce((sum, u) => sum + u.net, 0);
  const calculatedNet = round2(ordersNet + unmatchedNet);

  if (Math.abs(calculatedNet - payoutAmount) > 0.01) {
    console.warn(`[Payout ${payoutId}] Afvigelse: beregnet ${calculatedNet} vs. payout ${payoutAmount}`);
    result.valid = false;
    result.discrepancy = round2(payoutAmount - calculatedNet);
  }

  console.log(`[Payout ${payoutId}] ${transactions.length} transaktioner, ${orders.length} ordrer, net: ${payoutAmount}`);

  return result;
}

/**
 * Registrér betalinger i Dinero for alle ordrer i en payout.
 * Bruger invoiceStore til at finde Dinero faktura Guid pr. ordre.
 */
async function registerPayoutPayments(payoutId) {
  const [reconciliation, payout] = await Promise.all([
    reconcilePayout(payoutId),
    getPayout(payoutId),
  ]);
  const payoutDate = payout.date || new Date().toISOString().substring(0, 10);
  const { accounts } = settings.load();
  const depositAccount = accounts.cashCard?.accountNumber;

  if (!depositAccount) throw new Error('Kontant/kreditkort konto ikke konfigureret i indstillinger');

  const results = [];

  const PAID_TAG = 'Betalt';

  for (const order of reconciliation.orders) {
    if (!order.exported || !order.dineroGuid) {
      results.push({ orderId: order.orderId, orderName: order.orderName, status: 'skipped', reason: 'Ikke eksporteret til Dinero' });
      continue;
    }

    try {
      if (await orderHasTag(order.orderId, PAID_TAG)) {
        results.push({ orderId: order.orderId, orderName: order.orderName, status: 'already_paid' });
        continue;
      }

      const amount = round2(order.gross + order.refunds); // refunds er negative
      if (amount <= 0) {
        results.push({ orderId: order.orderId, orderName: order.orderName, status: 'skipped', reason: 'Beløb er 0 eller negativt' });
        continue;
      }

      await addPaymentToInvoice(
        order.dineroGuid,
        amount,
        depositAccount,
        payoutDate,
        `Shopify payout ${payoutId} — ${order.orderName || order.orderId}`,
        `payout-${payoutId}-${order.orderId}`
      );

      await addTagToOrder(order.orderId, PAID_TAG);

      results.push({ orderId: order.orderId, orderName: order.orderName, status: 'success', amount });
    } catch (err) {
      console.error(`[Payout] Betaling fejlede for ordre ${order.orderId}:`, err.response?.data || err.message);
      results.push({ orderId: order.orderId, orderName: order.orderName, status: 'error', error: err.response?.data?.message || err.message });
    }
  }

  return {
    payoutId,
    registered: results.filter(r => r.status === 'success').length,
    skipped: results.filter(r => r.status === 'skipped').length,
    errors: results.filter(r => r.status === 'error').length,
    details: results,
  };
}

module.exports = { listPayouts, reconcilePayout, registerPayoutPayments };
