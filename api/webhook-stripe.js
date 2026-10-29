// POST /api/webhook-stripe — o Stripe avisa renovações, falhas de pagamento e cancelamentos.
// O aviso só diz QUAL assinatura mudou; o estado real é lido de volta direto no Stripe (syncSubscription).
// Assim, um aviso falso não consegue liberar ou bloquear ninguém.
// Para segurança extra: configure STRIPE_WEBHOOK_SECRET na Vercel para validar a assinatura.
const { syncSubscription, bodyOf, verifyStripeSignature, handler } = require('./_lib');

const EVENTS = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed',
];

module.exports = handler('POST', async (req) => {
  // Verificação de assinatura do Stripe (STRIPE_WEBHOOK_SECRET no painel do Stripe > Webhooks > Assinar segredo)
  const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {});
  await verifyStripeSignature(rawBody, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);

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
