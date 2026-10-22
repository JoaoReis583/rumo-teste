// POST /api/webhook-stripe — o Stripe avisa renovações, falhas de pagamento e cancelamentos.
// O aviso só diz QUAL assinatura mudou; o estado real é lido de volta direto no Stripe (syncSubscription).
// Assim, um aviso falso não consegue liberar ou bloquear ninguém.
const { syncSubscription, bodyOf, handler } = require('./_lib');

const EVENTS = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed',
];

module.exports = handler('POST', async (req) => {
  const ev = bodyOf(req);
  const o = ev.data && ev.data.object;
  if (!o || !EVENTS.includes(ev.type)) return { ignored: true };
  const subId = o.object === 'subscription' ? o.id
    : typeof o.subscription === 'string' ? o.subscription
    : (o.parent && o.parent.subscription_details && o.parent.subscription_details.subscription) || null;
  if (!subId) return { ignored: true };
  await syncSubscription(subId);
  return { ok: true };
});
