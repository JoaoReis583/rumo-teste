// POST /api/webhook-stripe — o Stripe avisa renovações, falhas e cancelamentos.
// O estado real é sempre lido de volta direto no Stripe (syncSubscription).
// Além disso, quando um pagamento é confirmado, aciona o prêmio de indicação automaticamente.
const { syncSubscription, db, ts, bodyOf, verifyStripeSignature, handler } = require('./_lib');

const EVENTS = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed',
];

const PREMIO_DIAS = 30;
const BLOCO = 5;

// Processa prêmio de indicação para o uid que acabou de pagar
async function processarPremioIndicacao(uid) {
  if (!uid) return;
  try {
    const usageRef = db().collection('referral_uses').doc(uid);
    const usageSnap = await usageRef.get();
    if (!usageSnap.exists || usageSnap.data().pago) return; // já processado ou não indicado

    const ownerUid = usageSnap.data().indicado_por;
    await usageRef.update({ pago: true, pago_em: ts(new Date()) });

    // Incrementa contador do dono do código
    const ownerRef = db().collection('referrals').doc(ownerUid);
    const ownerSnap = await ownerRef.get();
    if (!ownerSnap.exists) return;

    const novoTotal = (ownerSnap.data().total || 0) + 1;
    const ganhouPremio = Math.floor(novoTotal / BLOCO) > Math.floor((novoTotal - 1) / BLOCO);
    await ownerRef.update({ total: novoTotal });

    if (ganhouPremio) {
      // Adiciona 30 dias à assinatura do indicador
      const subRef = db().collection('subscriptions').doc(ownerUid);
      const subSnap = await subRef.get();
      const sub = subSnap.data() || {};
      const until = sub.access_until ? sub.access_until.toDate() : new Date();
      const nova = new Date(Math.max(until.getTime(), Date.now()) + PREMIO_DIAS * 86400000);
      await subRef.set({ access_until: ts(nova), updated_at: ts(new Date()) }, { merge: true });
      console.log(`[indicacao] Prêmio de ${PREMIO_DIAS} dias adicionado ao uid ${ownerUid} (${novoTotal} indicações)`);
    }
  } catch (e) {
    console.error('[indicacao] Erro ao processar prêmio:', e && e.message);
  }
}

module.exports = handler('POST', async (req) => {
  const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {});
  await verifyStripeSignature(rawBody, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);

  const ev = bodyOf(req);
  const o = ev.data && ev.data.object;
  if (!o || !EVENTS.includes(ev.type)) return { ignored: true };

  const subId = o.object === 'subscription' ? o.id
    : typeof o.subscription === 'string' ? o.subscription
    : (o.parent && o.parent.subscription_details && o.parent.subscription_details.subscription) || null;

  if (!subId) return { ignored: true };

  const result = await syncSubscription(subId);

  // Se o pagamento foi confirmado, aciona prêmio de indicação automaticamente
  if (ev.type === 'invoice.paid' || ev.type === 'checkout.session.completed') {
    const uid = result && result.uid;
    if (uid) await processarPremioIndicacao(uid);
  }

  return { ok: true };
});
