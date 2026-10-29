// POST /api/webhook-stripe — o Stripe avisa renovações, falhas e cancelamentos.
// O estado real é sempre lido de volta direto no Stripe (syncSubscription).
// Quando um amigo indicado paga de verdade, a indicação é contada automaticamente.
const { syncSubscription, premiarIndicacao, verifyStripeSignature, handler } = require('./_lib');

const EVENTS = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed',
];

// A assinatura do Stripe é calculada sobre o corpo cru, então o parser JSON da Vercel fica desligado aqui.
function rawBodyOf(req) {
  if (typeof req.body === 'string') return Promise.resolve(req.body);
  if (Buffer.isBuffer(req.body)) return Promise.resolve(req.body.toString('utf8'));
  if (req.body && typeof req.body === 'object') return Promise.resolve(JSON.stringify(req.body));
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const h = handler('POST', async (req) => {
  const raw = await rawBodyOf(req);
  await verifyStripeSignature(raw, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);

  const ev = JSON.parse(raw || '{}');
  const o = ev.data && ev.data.object;
  if (!o || !EVENTS.includes(ev.type)) return { ignored: true };

  const subId = o.object === 'subscription' ? o.id
    : typeof o.subscription === 'string' ? o.subscription
    : (o.parent && o.parent.subscription_details && o.parent.subscription_details.subscription) || null;
  if (!subId) return { ignored: true };

  const result = await syncSubscription(subId);

  // Só conta quando houve cobrança real: assinatura 'active' (o teste grátis e a fatura de R$ 0 não contam).
  if (result && result.paid && (ev.type === 'invoice.paid' || ev.type === 'checkout.session.completed' || ev.type === 'customer.subscription.updated')) {
    try { await premiarIndicacao(result.uid); } catch (e) { console.error('[indicacao] erro:', e && e.message); }
  }
  return { ok: true };
});

module.exports = h;
module.exports.config = { api: { bodyParser: false } };
