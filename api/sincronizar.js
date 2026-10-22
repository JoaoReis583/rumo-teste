// POST /api/sincronizar { sessionId? } — confere no Stripe e libera o acesso na hora após o pagamento.
const { HttpError, db, stripe, syncSubscription, requireUser, bodyOf, handler } = require('./_lib');

module.exports = handler('POST', async (req) => {
  const u = await requireUser(req);
  const { sessionId } = bodyOf(req);
  let subId;
  if (sessionId) {
    const s = await stripe('GET', `/checkout/sessions/${encodeURIComponent(sessionId)}`);
    if (s.client_reference_id !== u.uid) throw new HttpError(403, 'Sessão de pagamento inválida.');
    subId = typeof s.subscription === 'string' ? s.subscription : s.subscription && s.subscription.id;
  } else {
    subId = ((await db().collection('subscriptions').doc(u.uid).get()).data() || {}).stripe_subscription;
  }
  if (!subId) return { status: 'none' };
  const d = await syncSubscription(subId, u.uid);
  return { status: d ? d.status : 'none', access: !!(d && d.access_until > new Date()) };
});
