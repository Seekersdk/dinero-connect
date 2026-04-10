const { getClient } = require('./dinero');
const settings = require('./settings');
const invoiceStore = require('./invoiceStore');
const { getOrderMarginData, orderHasTag, addTagToOrder } = require('./shopify');

const VAT_TAG = 'Moms bogført';

function round2(value) {
  return Math.round(value * 100) / 100;
}

/**
 * Beregn brugtmoms for alle eksporterede ordrer der mangler moms-bogføring.
 * Returnerer liste af { orderId, orderName, vatAmount, date }.
 */
async function collectPendingVat() {
  const allInvoices = invoiceStore.getAll();
  const pending = [];

  for (const [orderId, info] of Object.entries(allInvoices)) {
    // Spring over hvis moms allerede er bogført
    if (await orderHasTag(orderId, VAT_TAG)) continue;

    const marginData = await getOrderMarginData(orderId);
    if (!marginData?.line_items) continue;

    let totalVat = 0;
    for (const item of marginData.line_items) {
      totalVat += item.vat || 0;
    }

    if (totalVat > 0) {
      pending.push({
        orderId,
        orderName: info.orderName || orderId,
        vatAmount: round2(totalVat),
        date: info.exportedAt?.substring(0, 10) || new Date().toISOString().substring(0, 10),
      });
    }
  }

  return pending;
}

/**
 * Opret manuelt bilag i Dinero for brugtmoms.
 *
 * Debet: salgskonto (reducerer indtægt)
 * Kredit: momskonto (skyldig moms)
 */
async function createVatVoucher(voucherDate, vatAmount, orderNames, externalRef) {
  const { accounts } = settings.load();
  const salesAccount = accounts.sale?.accountNumber;
  const vatAccount = accounts.vatLiability?.accountNumber;

  if (!salesAccount) throw new Error('Salgskonto ikke konfigureret i indstillinger');
  if (!vatAccount) throw new Error('Moms konto (brugtmoms) ikke konfigureret i indstillinger');

  const client = getClient();
  const description = `Brugtmoms: ${orderNames.join(', ')}`;

  const payload = {
    VoucherDate: voucherDate,
    ExternalReference: externalRef,
    Lines: [
      {
        Description: description,
        AccountNumber: salesAccount,
        BalancingAccountNumber: vatAccount,
        Amount: vatAmount,
        AccountVatCode: 'none',
        BalancingAccountVatCode: 'none',
      },
    ],
  };

  const response = await client.post('vouchers/manuel', payload);
  console.log('[Voucher] Dinero response:', JSON.stringify(response.data));
  return response.data;
}

/**
 * Hovedflow: saml ventende moms, opret bilag, tag ordrer.
 */
async function postPendingVat() {
  const pending = await collectPendingVat();
  if (pending.length === 0) {
    return { status: 'nothing', message: 'Ingen ordrer med uposteret brugtmoms' };
  }

  const totalVat = round2(pending.reduce((sum, p) => sum + p.vatAmount, 0));
  const orderNames = pending.map(p => p.orderName);
  const voucherDate = new Date().toISOString().substring(0, 10);

  // Idempotency: brug dato + ordre-ids som reference
  const orderIds = pending.map(p => p.orderId).sort();
  const externalRef = `brugtmoms-${voucherDate}-${orderIds.join(',')}`.substring(0, 128);

  const voucher = await createVatVoucher(voucherDate, totalVat, orderNames, externalRef);

  // Tag alle ordrer som moms-bogført
  for (const p of pending) {
    await addTagToOrder(p.orderId, VAT_TAG);
  }

  return {
    status: 'success',
    voucherGuid: voucher.Guid,
    voucherNumber: voucher.VoucherNumber || null,
    dineroStatus: voucher.Status,
    totalVat,
    orderCount: pending.length,
    orders: pending,
  };
}

/**
 * Bogfør brugtmoms for én enkelt ordre.
 */
async function postSingleVat(orderId) {
  if (await orderHasTag(orderId, VAT_TAG)) {
    return { status: 'already', message: 'Moms allerede bogført for denne ordre' };
  }

  const info = invoiceStore.get(orderId);
  if (!info) throw new Error('Ordre ikke fundet i invoice store — eksportér til Dinero først');

  const marginData = await getOrderMarginData(orderId);
  if (!marginData?.line_items) {
    return { status: 'nothing', message: 'Ingen margindata fundet for denne ordre' };
  }

  let totalVat = 0;
  for (const item of marginData.line_items) {
    totalVat += item.vat || 0;
  }

  if (totalVat <= 0) {
    return { status: 'nothing', message: 'Ingen brugtmoms at bogføre (moms = 0)' };
  }

  totalVat = round2(totalVat);
  const orderName = info.orderName || orderId;
  const voucherDate = new Date().toISOString().substring(0, 10);
  const externalRef = `brugtmoms-${orderId}`;

  const voucher = await createVatVoucher(voucherDate, totalVat, [orderName], externalRef);
  await addTagToOrder(orderId, VAT_TAG);

  return {
    status: 'success',
    orderId,
    orderName,
    voucherGuid: voucher.Guid,
    voucherNumber: voucher.VoucherNumber || null,
    dineroStatus: voucher.Status,
    vatAmount: totalVat,
  };
}

module.exports = { collectPendingVat, createVatVoucher, postPendingVat, postSingleVat };
