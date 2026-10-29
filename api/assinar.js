// POST /api/assinar — cria a sessão de pagamento do Stripe (Checkout embutido no site).
// Na 1ª vez inclui o período de teste (cartão obrigatório; a cobrança só ocorre depois do teste).
// Suporta planos mensais e anuais.
const { HttpError, db, CFG, stripe, requireUser, originOf, rateLimit, handler } = require('./_lib');

module.exports = handler('POST', async (req) => {
  // Rate limit: máximo 10 tentativas por IP a cada 15 minutos
  await rateLimit(req, 'assinar', 10, 15 * 60 * 1000);

  const u = await requireUser(req);
  if (!process.env.STRIPE_PUBLISHABLE_KEY) throw new HttpError(500, 'Servidor sem STRIPE_PUBLISHABLE_KEY. Cadastre a variável na Vercel e faça um novo deploy.');
  const cfg = CFG();
  const prev = (await db().collection('subscriptions').doc(u.uid).get()).data() || {};
  const hasAccess = prev.access_until && prev.access_until.toDate() > new Date();

  if (hasAccess && ['active', 'trial'].includes(prev.status)) return { already: true };
  // Pagamento falhou numa assinatura que já existe: não cria outra, manda atualizar o cartão.
  if (prev.stripe_subscription && prev.status === 'overdue') return { overdue: true };

  // Plano: 'mensal' (padrão) ou 'anual'
  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const plano = body.plano === 'anual' ? 'anual' : 'mensal';
  const isAnual = plano === 'anual';

  const trial = !prev.trial_used && cfg.trialDays > 0;
  const preco = isAnual ? Math.round(cfg.valueAnual * 100) : Math.round(cfg.value * 100);
  const s = await stripe('POST', '/checkout/sessions', {
    mode: 'subscription',
    ui_mode: 'embedded',
    redirect_on_completion: 'if_required',
    return_url: originOf(req) + '/?assinatura=ok',
    locale: 'pt-BR',
    client_reference_id: u.uid,
    metadata: { uid: u.uid },
    line_items: [{
      quantity: 1,
      price_data: {
        currency: 'brl',
        unit_amount: preco,
        recurring: { interval: isAnual ? 'year' : 'month' },
        product_data: { name: isAnual ? 'Rumo (assinatura anual)' : 'Rumo (assinatura mensal)' },
      },
    }],
    subscription_data: { metadata: { uid: u.uid }, ...(trial ? { trial_period_days: cfg.trialDays } : {}) },
    ...(prev.stripe_customer ? { customer: prev.stripe_customer } : { customer_email: u.email }),
  });

  return {
    clientSecret: s.client_secret,
    sessionId: s.id,
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
    trial,
    plano,
  };
});
