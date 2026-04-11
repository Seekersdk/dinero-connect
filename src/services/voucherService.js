const { getClient } = require('./dinero');
const settings = require('./settings');
const invoiceStore = require('./invoiceStore');
const { getOrderMarginData, orderHasTag, addTagToOrder, removeTagFromOrder, getOrderTagsBatch, setOrderMetafield } = require('./shopify');

const { round2 } = require('../utils');

const VAT_TAG = 'Moms bogført';
const VAT_UPDATED_TAG = 'MomsOpdateret';

/**
 * Beregn brugtmoms for alle eksporterede ordrer der mangler moms-bogføring,
 * samt korrektioner for ordrer hvor moms allerede er bogført men en refundering er sket.
 *
 * Returnerer liste af { orderId, orderName, vatAmount, date, isCorrection }.
 *   - isCorrection=false: ny moms-bogføring (positiv vatAmount)
 *   - isCorrection=true:  korrektion pga. refund (negativ vatAmount)
 */
async function collectPendingVat() {
  const allInvoices = invoiceStore.getAll();
  const orderIds = Object.keys(allInvoices);
  if (orderIds.length === 0) return [];

  // Batch-hent tags (1 API-kald pr. 250 ordrer i stedet for 1 pr. ordre)
  const tagMap = await getOrderTagsBatch(orderIds);

  const pending = [];
  for (const [orderId, info] of Object.entries(allInvoices)) {
    const tags = tagMap.get(orderId);
    const hasVatTag = tags && tags.has(VAT_TAG);
    const hasUpdatedTag = tags && tags.has(VAT_UPDATED_TAG);

    if (!hasVatTag) {
      // Spor 1: Ny moms-bogføring — total_vat er allerede justeret for evt. refunds
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
          isCorrection: false,
        });
      }
    } else if (hasUpdatedTag) {
      // Spor 2: Korrektion — moms er bogført, Brugtmoms-appen har sat MomsOpdateret-tag
      const marginData = await getOrderMarginData(orderId);
      if (!marginData) continue;

      const adjustments = marginData.refund_adjustments;
      if (!Array.isArray(adjustments) || adjustments.length === 0) continue;

      const currentVat = marginData.total_vat;
      if (currentVat == null) continue;

      // Beregn hvad der tidligere er bogført (fra finance.booked_vat metafield)
      const sumVatReduction = adjustments.reduce((sum, a) => sum + (a.vatReduction || 0), 0);
      const bookedVat = marginData.bookedVat != null
        ? marginData.bookedVat
        : round2(currentVat + sumVatReduction); // rekonstruér original fra metadata

      const correction = round2(currentVat - bookedVat);
      if (correction >= 0) continue; // allerede korrigeret eller intet at gøre

      pending.push({
        orderId,
        orderName: info.orderName || orderId,
        vatAmount: correction, // negativ
        date: new Date().toISOString().substring(0, 10),
        isCorrection: true,
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

  const createRes = await client.post('vouchers/manuel', payload);
  const draft = createRes.data;
  console.log('[Voucher] Kladde oprettet:', JSON.stringify(draft));

  // Auto-bogfør bilaget
  const bookRes = await client.post(`vouchers/manuel/${draft.Guid}/book`, {
    Timestamp: draft.Timestamp,
  });
  const booked = bookRes.data;
  console.log('[Voucher] Bogført:', JSON.stringify(booked));
  return booked;
}

/**
 * Hovedflow: saml ventende moms, opret bilag, tag ordrer.
 * Håndterer både nye bogføringer og korrektioner (refund).
 */
async function postPendingVat() {
  const pending = await collectPendingVat();
  if (pending.length === 0) {
    return { status: 'nothing', message: 'Ingen ordrer med uposteret brugtmoms' };
  }

  const newBookings = pending.filter(p => !p.isCorrection);
  const corrections = pending.filter(p => p.isCorrection);
  const results = [];

  // --- Nye moms-bogføringer ---
  if (newBookings.length > 0) {
    const totalVat = round2(newBookings.reduce((sum, p) => sum + p.vatAmount, 0));
    const orderNames = newBookings.map(p => p.orderName);
    const voucherDate = new Date().toISOString().substring(0, 10);
    const orderIds = newBookings.map(p => p.orderId).sort();
    const externalRef = `brugtmoms-${voucherDate}-${orderIds.join(',')}`.substring(0, 128);

    // Tag ordrer FØR vi opretter bilaget (forhindrer duplikater)
    for (const p of newBookings) {
      await addTagToOrder(p.orderId, VAT_TAG);
    }

    try {
      const voucher = await createVatVoucher(voucherDate, totalVat, orderNames, externalRef);
      // Gem bookedVat i Shopify metafield for fremtidige korrektioner
      for (const p of newBookings) {
        await setOrderMetafield(p.orderId, 'finance', 'booked_vat', p.vatAmount);
      }
      results.push({
        type: 'new',
        voucherGuid: voucher.Guid,
        voucherNumber: voucher.VoucherNumber || null,
        dineroStatus: voucher.Status,
        totalVat,
        orderCount: newBookings.length,
        orders: newBookings,
      });
    } catch (err) {
      for (const p of newBookings) {
        try { await removeTagFromOrder(p.orderId, VAT_TAG); } catch { /* ignore */ }
      }
      throw err;
    }
  }

  // --- Korrektioner (refund) ---
  if (corrections.length > 0) {
    const totalCorrection = round2(corrections.reduce((sum, p) => sum + p.vatAmount, 0));
    const orderNames = corrections.map(p => `${p.orderName} (korrektion)`);
    const voucherDate = new Date().toISOString().substring(0, 10);
    const orderIds = corrections.map(p => p.orderId).sort();
    const externalRef = `brugtmoms-korrektion-${voucherDate}-${orderIds.join(',')}`.substring(0, 128);

    const voucher = await createVatVoucher(voucherDate, totalCorrection, orderNames, externalRef);

    // Opdatér bookedVat i Shopify metafield og fjern MomsOpdateret-tag
    for (const p of corrections) {
      const marginData = await getOrderMarginData(p.orderId);
      const currentVat = marginData?.total_vat;
      if (currentVat != null) {
        await setOrderMetafield(p.orderId, 'finance', 'booked_vat', currentVat);
      }
      await removeTagFromOrder(p.orderId, VAT_UPDATED_TAG);
    }

    results.push({
      type: 'correction',
      voucherGuid: voucher.Guid,
      voucherNumber: voucher.VoucherNumber || null,
      dineroStatus: voucher.Status,
      totalVat: totalCorrection,
      orderCount: corrections.length,
      orders: corrections,
    });
  }

  // Returformat der er bagudkompatibelt
  const totalVat = round2(pending.reduce((sum, p) => sum + p.vatAmount, 0));
  return {
    status: 'success',
    totalVat,
    orderCount: pending.length,
    vouchers: results,
    orders: pending,
  };
}

/**
 * Bogfør brugtmoms for én enkelt ordre.
 * Håndterer både ny bogføring og korrektion ved refund.
 */
async function postSingleVat(orderId) {
  const info = invoiceStore.get(orderId);
  if (!info) throw new Error('Ordre ikke fundet i invoice store — eksportér til Dinero først');

  const hasVatTag = await orderHasTag(orderId, VAT_TAG);

  const marginData = await getOrderMarginData(orderId);
  if (!marginData?.line_items) {
    return { status: 'nothing', message: 'Ingen margindata fundet for denne ordre' };
  }

  const orderName = info.orderName || orderId;
  const voucherDate = new Date().toISOString().substring(0, 10);

  if (!hasVatTag) {
    // --- Ny moms-bogføring ---
    let totalVat = 0;
    for (const item of marginData.line_items) {
      totalVat += item.vat || 0;
    }

    if (totalVat <= 0) {
      return { status: 'nothing', message: 'Ingen brugtmoms at bogføre (moms = 0)' };
    }

    totalVat = round2(totalVat);
    const externalRef = `brugtmoms-${orderId}`;

    await addTagToOrder(orderId, VAT_TAG);

    let voucher;
    try {
      voucher = await createVatVoucher(voucherDate, totalVat, [orderName], externalRef);
    } catch (err) {
      try { await removeTagFromOrder(orderId, VAT_TAG); } catch { /* ignore */ }
      throw err;
    }

    await setOrderMetafield(orderId, 'finance', 'booked_vat', totalVat);

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

  // --- Korrektion pga. refund ---
  const adjustments = marginData.refund_adjustments;
  if (!Array.isArray(adjustments) || adjustments.length === 0) {
    return { status: 'already', message: 'Moms allerede bogført for denne ordre' };
  }

  const currentVat = marginData.total_vat;
  if (currentVat == null) {
    return { status: 'already', message: 'Moms allerede bogført — ingen total_vat i metadata' };
  }

  const sumVatReduction = adjustments.reduce((sum, a) => sum + (a.vatReduction || 0), 0);
  const bookedVat = marginData.bookedVat != null
    ? marginData.bookedVat
    : round2(currentVat + sumVatReduction);

  const correction = round2(currentVat - bookedVat);
  if (correction >= 0) {
    return { status: 'already', message: 'Moms allerede korrigeret for denne ordre' };
  }

  const externalRef = `brugtmoms-korrektion-${orderId}`;
  const voucher = await createVatVoucher(voucherDate, correction, [`${orderName} (korrektion)`], externalRef);

  await setOrderMetafield(orderId, 'finance', 'booked_vat', round2(bookedVat + correction));
  await removeTagFromOrder(orderId, VAT_UPDATED_TAG);

  return {
    status: 'success',
    type: 'correction',
    orderId,
    orderName,
    voucherGuid: voucher.Guid,
    voucherNumber: voucher.VoucherNumber || null,
    dineroStatus: voucher.Status,
    vatAmount: correction,
  };
}

module.exports = { collectPendingVat, createVatVoucher, postPendingVat, postSingleVat };
