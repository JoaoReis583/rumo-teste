// POST /api/indicar { acao } — indicação por link de convite.
// acao: 'obter'     → devolve o link do usuário, progresso e se a aba de convite deve ficar oculta
// acao: 'registrar' → { codigo } (token do link) registra que o usuário logado veio de um convite
// O prêmio (5 amigos pagantes = 30 dias) é concedido pelo servidor quando o Stripe confirma o pagamento.
const { HttpError, db, ts, requireUser, bodyOf, originOf, handler, PREMIO_DIAS, BLOCO, TRAVA_DIAS } = require('./_lib');

const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const novoToken = () => Array.from({ length: 8 }, () => ALFABETO[Math.floor(Math.random() * ALFABETO.length)]).join('');

module.exports = handler('POST', async (req) => {
  const u = await requireUser(req);
  const { acao, codigo } = bodyOf(req);

  if (acao === 'obter') {
    const ref = db().collection('referrals').doc(u.uid);
    let snap = await ref.get();
    if (!snap.exists) {
      await ref.set({ uid: u.uid, codigo: novoToken(), total: 0, premiados: 0, created_at: ts(new Date()) });
      snap = await ref.get();
    }
    const d = snap.data();
    const total = d.total || 0;
    const noBloco = total % BLOCO;
    const uso = (await db().collection('referral_uses').doc(u.uid).get()).data();
    const ate = uso && uso.convite_oculto_ate ? uso.convite_oculto_ate.toDate() : null;
    const oculto = !!(ate && ate > new Date());
    return {
      codigo: d.codigo,
      link: `${originOf(req)}/i/${d.codigo}`,
      total, no_bloco: noBloco, faltam: BLOCO - noBloco, bloco: BLOCO, premio_dias: PREMIO_DIAS,
      premios: Math.floor(total / BLOCO),
      oculto, oculto_ate: oculto ? ate.toISOString() : null,
    };
  }

  if (acao === 'registrar') {
    const clean = String(codigo || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{4,16}$/.test(clean)) throw new HttpError(400, 'Link de convite inválido.');

    const q = await db().collection('referrals').where('codigo', '==', clean).limit(1).get();
    if (q.empty) throw new HttpError(404, 'Convite não encontrado.');
    const ownerUid = q.docs[0].id;
    if (ownerUid === u.uid) throw new HttpError(400, 'Você não pode usar o seu próprio convite.');

    const usageRef = db().collection('referral_uses').doc(u.uid);
    if ((await usageRef.get()).exists) return { ok: false, msg: 'Você já foi registrado como convidado.' };

    // Convite só vale para quem acabou de criar a conta (evita registrar usuários antigos/assinantes)
    const sub = (await db().collection('subscriptions').doc(u.uid).get()).data();
    if (sub && sub.stripe_subscription && sub.status !== 'pending') return { ok: false, msg: 'Convites só valem para contas novas.' };

    const now = new Date();
    await usageRef.set({
      uid: u.uid,
      indicado_por: ownerUid,
      codigo_usado: clean,
      registrado_em: ts(now),
      convite_oculto_ate: ts(new Date(now.getTime() + TRAVA_DIAS * 86400000)),
      pago: false,
    });
    return { ok: true, msg: 'Convite registrado.' };
  }

  throw new HttpError(400, 'Ação desconhecida.');
});
