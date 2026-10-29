// POST /api/metricas — registra eventos de uso para análise de funil.
// Eventos: conta_criada, teste_iniciado, assinatura_paga, assinatura_cancelada.
// Os dados ficam em _metrics/{ano-mes}/{event}_{uid} (agregados manualmente no console).
// Para privacidade, não salva PII — apenas uid hasheado, evento e timestamp.
const { HttpError, db, ts, handler, rateLimit } = require('./_lib');
const crypto = require('crypto');

const EVENTOS_VALIDOS = ['conta_criada', 'teste_iniciado', 'assinatura_paga', 'assinatura_cancelada', 'painel_aberto', 'ia_usada'];

module.exports = handler('POST', async (req) => {
  await rateLimit(req, 'metricas', 30, 60 * 1000); // 30/min por IP

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const { evento, uid } = body;

  if (!EVENTOS_VALIDOS.includes(evento)) return { ok: false };
  if (!uid || typeof uid !== 'string') return { ok: false };

  const uidHash = crypto.createHash('sha256').update(uid).digest('hex').slice(0, 12);
  const mes = new Date().toISOString().slice(0, 7);

  await db().collection('_metrics').doc(`${mes}_${evento}_${uidHash}`).set({
    evento,
    uid_hash: uidHash,
    mes,
    timestamp: ts(new Date()),
  }, { merge: true });

  return { ok: true };
});
