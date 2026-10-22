// POST /api/portal — abre o portal do Stripe para trocar o cartão, ver faturas e cancelar.
const { HttpError, db, stripe, requireUser, originOf, handler } = require('./_lib');

module.exports = handler('POST', async (req) => {
  const u = await requireUser(req);
  const prev = (await db().collection('subscriptions').doc(u.uid).get()).data() || {};
  if (!prev.stripe_customer) throw new HttpError(400, 'Nenhuma assinatura encontrada nesta conta.');
  const s = await stripe('POST', '/billing_portal/sessions', { customer: prev.stripe_customer, return_url: originOf(req) + '/' });
  return { url: s.url };
});
