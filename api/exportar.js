// POST /api/exportar — exporta todos os dados do usuário em JSON (LGPD: portabilidade de dados).
// Retorna um JSON com todos os dados: usuário, lançamentos, contas fixas, metas e assinatura.
const { HttpError, db, requireUser, rateLimit, handler } = require('./_lib');

module.exports = handler('POST', async (req) => {
  // Rate limit: máximo 5 exportações por hora por IP
  await rateLimit(req, 'exportar', 5, 60 * 60 * 1000);

  const u = await requireUser(req);
  const uid = u.uid;
  const firestore = db();

  // Dados raiz do usuário
  const userDoc = await firestore.collection('users').doc(uid).get();
  const userData = userDoc.exists ? userDoc.data() : {};

  // Subcoleções
  const loadCol = async (col) => {
    const snap = await firestore.collection(`users/${uid}/${col}`).get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  };

  const [transactions, bills, goals] = await Promise.all([
    loadCol('transactions'),
    loadCol('bills'),
    loadCol('goals'),
  ]);

  // Assinatura (apenas status e datas, sem dados de cartão — esses ficam só no Stripe)
  const subDoc = await firestore.collection('subscriptions').doc(uid).get();
  const sub = subDoc.exists ? subDoc.data() : null;

  const exportData = {
    exportado_em: new Date().toISOString(),
    usuario: {
      uid,
      email: u.email || null,
      nome: u.name || null,
    },
    renda_e_planejamento: {
      renda_mensal_reais: userData.income_cents ? userData.income_cents / 100 : 0,
      divisao_percentual: userData.pcts || {},
    },
    lancamentos: transactions.map(t => ({
      id: t.id,
      tipo: t.kind === 'income' ? 'renda' : 'gasto',
      descricao: t.description,
      valor_reais: t.amount_cents / 100,
      categoria: t.cat || null,
      data: t.tx_date,
      criado_em: t.created_at,
    })),
    contas_fixas: bills.map(b => ({
      id: b.id,
      nome: b.name,
      valor_reais: b.amount_cents / 100,
      dia_vencimento: b.due_day,
      categoria: b.cat,
      criado_em: b.created_at,
    })),
    metas: goals.map(g => ({
      id: g.id,
      nome: g.name,
      valor_alvo_reais: g.target_cents / 100,
      valor_guardado_reais: g.saved_cents / 100,
      prazo: g.deadline || null,
      criado_em: g.created_at,
    })),
    assinatura: sub ? {
      status: sub.status,
      plano: sub.plan_interval || 'month',
      acesso_ate: sub.access_until ? sub.access_until.toDate().toISOString() : null,
      atualizado_em: sub.updated_at ? sub.updated_at.toDate().toISOString() : null,
    } : null,
  };

  return exportData;
});
