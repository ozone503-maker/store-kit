// Order ledger -> CSV (one row per order). Money in dollars, dates in UTC and Hawaii time.
const COLUMNS = [
  'order_number', 'date_hst', 'date_utc', 'brand', 'livemode', 'payment_status', 'fulfillment_status',
  'customer_name', 'email', 'phone', 'ship_line1', 'ship_line2', 'ship_city', 'ship_state', 'ship_zip', 'ship_country',
  'items', 'skus', 'units', 'fulfillers',
  'subtotal', 'discount', 'shipping', 'tax', 'total', 'stripe_fee', 'net', 'refunded', 'net_after_refunds', 'currency',
  'carriers', 'tracking_numbers', 'shipped_at', 'confirmation_email', 'threepl_email', 'notes',
  'stripe_session_id', 'stripe_payment_intent',
];
const dollars = c => c == null ? '' : (c / 100).toFixed(2);
const hst = ms => {
  if (!ms) return '';
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'Pacific/Honolulu', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
};
// Quote every cell; neutralize spreadsheet formulas from customer-entered text.
function cell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
}
export function orderRow(o) {
  const a = o.shipping?.address || {};
  const items = o.items || [];
  const ships = o.shipments || [];
  const net = o.net_cents;
  return {
    order_number: o.order_number || '',
    date_hst: hst(o.created_at_ms),
    date_utc: o.created_at_ms ? new Date(o.created_at_ms).toISOString() : '',
    brand: o.brand || 'default',
    livemode: o.livemode ? 'live' : 'test',
    payment_status: o.payment,
    fulfillment_status: o.fulfillment,
    customer_name: o.shipping?.name || '',
    email: o.email || '',
    phone: o.phone || '',
    ship_line1: a.line1 || '', ship_line2: a.line2 || '', ship_city: a.city || '', ship_state: a.state || '', ship_zip: a.postal_code || '', ship_country: a.country || '',
    items: items.map(i => `${i.quantity} x ${i.title}`).join('; '),
    skus: items.map(i => `${i.sku || '?'}x${i.quantity}`).join('; '),
    units: items.reduce((n, i) => n + (i.quantity || 0), 0),
    fulfillers: [...new Set(items.map(i => i.fulfiller))].join('; '),
    subtotal: dollars(o.amount_subtotal_cents),
    discount: dollars(o.amount_discount_cents || 0),
    shipping: dollars(o.amount_shipping_cents),
    tax: dollars(o.amount_tax_cents || 0),
    total: dollars(o.amount_total_cents),
    stripe_fee: dollars(o.stripe_fee_cents),
    net: dollars(net),
    refunded: dollars(o.amount_refunded_cents || 0),
    net_after_refunds: net == null ? '' : dollars(net - (o.amount_refunded_cents || 0)),
    currency: (o.currency || 'usd').toUpperCase(),
    carriers: ships.map(s => s.carrier).join('; '),
    tracking_numbers: ships.map(s => s.tracking_number).join('; '),
    shipped_at: ships.map(s => s.at).join('; '),
    confirmation_email: o.confirmation_email?.status || '',
    threepl_email: o.threepl_email?.status || '',
    notes: o.notes || '',
    stripe_session_id: o.id,
    stripe_payment_intent: o.payment_intent || '',
  };
}
export function ordersCsv(orders) {
  const lines = [COLUMNS.join(',')];
  for (const o of orders) { const r = orderRow(o); lines.push(COLUMNS.map(c => cell(r[c])).join(',')); }
  return lines.join('\r\n') + '\r\n';
}
export { COLUMNS };
