// POST /api/indicar { acao } — sistema de indicação por link
// acao: 'obter' → retorna o link de convite do usuário
// acao: 'registrar' → { codigo } → registra que o usuário logado foi indicado por alguém
// acao: 'webhook_premio' → chamado internamente pelo webhook-stripe ao confirmar pagamento de indicado
const { HttpError, db, ts, requireUser, bodyOf, handler } = require('./_lib');

const PREMIO_DIAS = 30;     // dias grátis por bloco de 5 indicações
const BLOCO = 5;            // quantas indicações por prêmio
const TRAVA_DIAS = 37;      // dias que a aba de convite fica oculta para quem veio de link (7 trial + 30 plano)

module.exports = handler('POST', async (req) => {
  const u = await requireUser(req);
  const { acao, codigo } = bodyOf(req);

  /* ---------- OBTER ---------- */
  if (acao === 'obter') {
    const ref = db().collection('referrals').doc(u.uid);
    let snap = await ref.get();
    if (!snap.exists) {
      // Gera código único de 8 chars: maiúsculas + dígitos
      const newCodigo = Array.from({ length: 8 }, () =>
        'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]
      ).join('');
      await ref.set({ uid: u.uid, codigo: newCodigo, total: 0, premiados: 0, created_at: ts(new Date()) });
      snap = await ref.get();
    }
    const d = snap.data();
    const total = d.total || 0;
    const blocoAtual = total % BLOCO;
    const faltam = BLOCO - blocoAtual;
    const link = `https://rumo.vercel.app/i/${d.codigo}`;
    return { codigo: d.codigo, link, total, faltam, bloco: BLOCO, premio_dias: PREMIO_DIAS };
  }

  /* ---------- REGISTRAR (quem foi indicado chama isso) ---------- */
  if (acao === 'registrar') {
    if (!codigo || typeof codigo !== 'string' || codigo.length < 4) throw new HttpError(400, 'Código de indicação inválido.');
    const clean = codigo.trim().toUpperCase();

    // Garante que a pessoa não tenta usar o próprio código
    const selfRef = db().collection('referrals').doc(u.uid);
    const selfSnap = await selfRef.get();
    if (selfSnap.exists && selfSnap.data().codigo === clean) throw new HttpError(400, 'Você não pode usar o seu próprio código.');

    // Busca o dono do código
    const q = await db().collection('referrals').where('codigo', '==', clean).limit(1).get();
    if (q.empty) throw new HttpError(404, 'Código de indicação não encontrado.');
    const ownerDoc = q.docs[0];
    const ownerUid = ownerDoc.id;

    // Verifica se este usuário já foi registrado como indicado antes
    const usageRef = db().collection('referral_uses').doc(u.uid);
    const usageSnap = await usageRef.get();
    if (usageSnap.exists) return { ok: false, msg: 'Você já foi registrado como indicado anteriormente.' };

    // Registra que este usuário foi indicado por ownerUid
    const now = new Date();
    await usageRef.set({
      uid: u.uid,
      indicado_por: ownerUid,
      codigo_usado: clean,
      registrado_em: ts(now),
      // Oculta aba de convite por 37 dias (trial + 1º mês)
      convite_oculto_ate: ts(new Date(now.getTime() + TRAVA_DIAS * 86400000)),
      pago: false, // só conta de verdade quando pagar
    });

    return { ok: true, msg: 'Indicação registrada! Você e seu amigo serão premiados quando você assinar.' };
  }

  /* ---------- PRÊMIO (chamado pelo webhook após pagamento confirmado) ---------- */
  if (acao === 'webhook_premio') {
    // Esta ação só pode ser chamada internamente (pelo webhook-stripe via _lib direta)
    // Verificação extra de segurança: o user deve ser o próprio dono do codigo
    const { uid_indicado } = bodyOf(req);
    if (!uid_indicado) throw new HttpError(400, 'uid_indicado obrigatório.');

    const usageRef = db().collection('referral_uses').doc(uid_indicado);
    const usageSnap = await usageRef.get();
    if (!usageSnap.exists || usageSnap.data().pago) return { ok: false, msg: 'Já processado ou não encontrado.' };

    const ownerUid = usageSnap.data().indicado_por;
    await usageRef.update({ pago: true, pago_em: ts(new Date()) });

    // Incrementa contador do dono do código
    const ownerRef = db().collection('referrals').doc(ownerUid);
    const ownerSnap = await ownerRef.get();
    if (!ownerSnap.exists) return { ok: false, msg: 'Dono do código não encontrado.' };
    const ownerData = ownerSnap.data();
    const novoTotal = (ownerData.total || 0) + 1;

    // Verifica se completou mais um bloco → adiciona dias na assinatura
    const blocoAnterior = Math.floor((novoTotal - 1) / BLOCO);
    const blocoAtual = Math.floor(novoTotal / BLOCO);
    const ganhouPremio = blocoAtual > blocoAnterior;

    await ownerRef.update({ total: novoTotal });

    if (ganhouPremio) {
      // Adiciona PREMIO_DIAS à assinatura do dono
      const subRef = db().collection('subscriptions').doc(ownerUid);
      const subSnap = await subRef.get();
      const sub = subSnap.data() || {};
      const until = sub.access_until ? sub.access_until.toDate() : new Date();
      const nova = new Date(Math.max(until.getTime(), Date.now()) + PREMIO_DIAS * 86400000);
      await subRef.set({ access_until: ts(nova), updated_at: ts(new Date()) }, { merge: true });
      return { ok: true, premio: true, msg: `${PREMIO_DIAS} dias grátis adicionados ao dono do código.` };
    }

    return { ok: true, premio: false, msg: 'Indicação confirmada. Faltam indicações para o próximo prêmio.' };
  }

  throw new HttpError(400, 'Ação desconhecida.');
});
