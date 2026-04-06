function mapOrderToInvoice(contactGuid, order) {
  const date = order.created_at.substring(0, 10);

  const productLines = order.line_items.map((item) => {
    // Shopify priser er inkl. 25% moms — del med 1.25 for ex-moms pris
    const priceExVat = parseFloat(item.price) / 1.25;

    return {
      Description: item.title,
      Quantity: item.quantity,
      Unit: 'parts',
      BaseAmountValue: Math.round(priceExVat * 100) / 100,
      AccountNumber: 1000,
      VatScale: 'DK25',
    };
  });

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
