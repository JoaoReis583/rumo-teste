// POST /api/indicar — gera ou recupera o código de indicação do usuário e registra indicações.
// Quem indicar X pessoas ganha 1 mês grátis (configu via REFERRAL_REWARD_COUNT, padrão 3).
const { HttpError, db, ts, requireUser, rateLimit, handler } = require('./_lib');

const REWARD_COUNT = Number(process.env.REFERRAL_REWARD_COUNT || 3);
const REWARD_DAYS = Number(process.env.REFERRAL_REWARD_DAYS || 30);

function genCode(uid) {
  // Código curto e único baseado no uid
  return uid.slice(0, 8).toUpperCase();
}

module.exports = handler('POST', async (req) => {
  await rateLimit(req, 'indicar', 20, 60 * 60 * 1000);

  const u = await requireUser(req);
  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const firestore = db();

  // Ação: obter código, registrar indicação usada ou checar recompensas
  const acao = body.acao || 'obter';

  if (acao === 'obter') {
    // Retorna o código do usuário atual e quantas indicações ele fez
    const ref = firestore.collection('referrals').doc(u.uid);
    const snap = await ref.get();
    let data = snap.exists ? snap.data() : null;
    if (!data) {
      const code = genCode(u.uid);
      data = { code, uid: u.uid, total: 0, recompensados: 0, created_at: new Date().toISOString() };
      await ref.set(data);
    }
    return {
      codigo: data.code,
      total: data.total || 0,
      recompensados: data.recompensados || 0,
      faltam: Math.max(0, REWARD_COUNT - ((data.total || 0) % REWARD_COUNT)),
      premio_dias: REWARD_DAYS,
    };
  }

  if (acao === 'registrar') {
    // Registra que o novo usuário (u.uid) usou um código de indicação
    const codigo = String(body.codigo || '').toUpperCase().trim();
    if (!codigo || codigo.length !== 8) throw new HttpError(400, 'Código inválido.');

    // Verifica se já registrou indicação antes
    const usadoSnap = await firestore.collection('referral_uses').doc(u.uid).get();
    if (usadoSnap.exists) return { ok: false, msg: 'Você já usou um código de indicação.' };

    // Acha o dono do código
    const donos = await firestore.collection('referrals').where('code', '==', codigo).limit(1).get();
    if (donos.empty) throw new HttpError(404, 'Código de indicação não encontrado.');
    const donoRef = donos.docs[0].ref;
    const donoData = donos.docs[0].data();
    if (donoData.uid === u.uid) throw new HttpError(400, 'Você não pode usar o próprio código.');

    // Registra o uso
    await firestore.collection('referral_uses').doc(u.uid).set({
      uid: u.uid,
      indicado_por: donoData.uid,
      codigo,
      data: new Date().toISOString(),
    });

    // Incrementa o total do dono
    const novoTotal = (donoData.total || 0) + 1;
    await donoRef.update({ total: novoTotal });

    // Verifica se ganhou recompensa (a cada REWARD_COUNT indicações)
    const recompensados = donoData.recompensados || 0;
    if (novoTotal % REWARD_COUNT === 0) {
      // Estende o acesso do dono por REWARD_DAYS dias
      const subRef = firestore.collection('subscriptions').doc(donoData.uid);
      const subSnap = await subRef.get();
      const subData = subSnap.exists ? subSnap.data() : {};
      const base = subData.access_until ? subData.access_until.toDate() : new Date();
      const nova = new Date(Math.max(base, new Date()) + REWARD_DAYS * 86400000);
      await subRef.set({ access_until: ts(nova), updated_at: ts(new Date()) }, { merge: true });
      await donoRef.update({ recompensados: recompensados + 1 });
    }

    return { ok: true, msg: 'Indicação registrada com sucesso!' };
  }

  throw new HttpError(400, 'Ação inválida.');
});
