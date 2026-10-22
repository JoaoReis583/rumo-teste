// Funções compartilhadas pelas rotas /api (servidor, nunca vai para o navegador).
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

let _admin;
function admin() {
  if (_admin) return _admin;
  const a = require('firebase-admin');
  if (!a.apps.length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new HttpError(500, 'Servidor sem FIREBASE_SERVICE_ACCOUNT. Cadastre a variável na Vercel e faça um novo deploy.');
    let sa;
    try { sa = JSON.parse(raw); }
    catch (e) { throw new HttpError(500, 'FIREBASE_SERVICE_ACCOUNT inválida: cole o JSON inteiro, de { até }.'); }
    if (sa.private_key) sa.private_key = sa.private_key.replace(/\\n/g, '\n');
    a.initializeApp({ credential: a.credential.cert(sa) });
  }
  return (_admin = a);
}
const db = () => admin().firestore();
const ts = (d) => admin().firestore.Timestamp.fromDate(d);

const CFG = () => ({
  value: Number(process.env.PLAN_VALUE || 5.9),
  trialDays: Number(process.env.TRIAL_DAYS ?? 7),
});

// ---- Stripe (API REST, sem dependências). A versão fica fixa para o formato não mudar sozinho. ----
const STRIPE_VERSION = '2024-06-20';
function form(obj, prefix, out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') form(v, key, out);
    else out.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(v)));
  }
  return out;
}
async function stripe(method, path, params) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new HttpError(500, 'Servidor sem STRIPE_SECRET_KEY. Cadastre a variável na Vercel e faça um novo deploy.');
  const qs = params ? form(params).join('&') : '';
  const get = method === 'GET';
  const r = await fetch('https://api.stripe.com/v1' + path + (get && qs ? '?' + qs : ''), {
    method,
    headers: { Authorization: 'Bearer ' + key, 'Stripe-Version': STRIPE_VERSION, ...(get ? {} : { 'Content-Type': 'application/x-www-form-urlencoded' }) },
    body: !get && qs ? qs : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.error('Stripe', method, path, r.status, JSON.stringify(j.error || j));
    throw new HttpError(r.status === 401 ? 500 : 400, (j.error && j.error.message) || 'Falha ao falar com o Stripe.');
  }
  return j;
}

// Lê a assinatura direto no Stripe (fonte da verdade) e grava o acesso em subscriptions/{uid}.
// Idempotente: pode rodar várias vezes (webhook, retorno do pagamento, botão "atualizar").
async function syncSubscription(subId, uidHint) {
  const sub = await stripe('GET', `/subscriptions/${encodeURIComponent(subId)}`);
  const metaUid = sub.metadata && sub.metadata.uid;
  if (uidHint && metaUid && metaUid !== uidHint) return null;
  const uid = metaUid || uidHint;
  if (!uid) return null;
  const ref = db().collection('subscriptions').doc(uid);
  const prev = (await ref.get()).data() || {};
  let until = prev.access_until ? prev.access_until.toDate() : new Date(0);
  let status;
  if (sub.status === 'trialing' || sub.status === 'active') {
    const end = new Date(sub.current_period_end * 1000 + 86400000); // 1 dia de folga
    if (end > until) until = end;
    status = sub.cancel_at_period_end ? 'canceled' : sub.status === 'trialing' ? 'trial' : 'active';
  } else if (sub.status === 'past_due' || sub.status === 'unpaid') status = 'overdue';
  else if (sub.status === 'canceled') status = 'canceled';
  else status = 'pending'; // incomplete / incomplete_expired
  const data = {
    status,
    stripe_customer: typeof sub.customer === 'string' ? sub.customer : sub.customer && sub.customer.id,
    stripe_subscription: sub.id,
    trial_used: !!(prev.trial_used || sub.trial_end),
    access_until: ts(until),
    updated_at: ts(new Date()),
  };
  await ref.set(data, { merge: true });
  return { ...data, access_until: until };
}

async function requireUser(req) {
  const h = req.headers.authorization || '';
  const m = /^Bearer (.+)$/.exec(h);
  if (!m) throw new HttpError(401, 'Entre na sua conta para continuar.');
  const a = admin(); // problema de configuração aparece como erro 500 com a causa, não como "sessão expirada"
  try { return await a.auth().verifyIdToken(m[1]); }
  catch (e) {
    console.error('verifyIdToken falhou:', e && e.code, e && e.message); // ex.: "incorrect aud" = conta de serviço de outro projeto
    throw new HttpError(401, 'Sessão expirada. Entre de novo.');
  }
}

const bodyOf = (req) => (typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {});
const originOf = (req) => req.headers.origin || `https://${req.headers.host}`;

function handler(method, fn) {
  return async (req, res) => {
    try {
      if (req.method !== method) { res.setHeader('Allow', method); return res.status(405).json({ error: 'Método não permitido.' }); }
      const out = await fn(req, res);
      if (!res.writableEnded) res.status(200).json(out || { ok: true });
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(e);
      if (!res.writableEnded) res.status(status).json({ error: status === 500 && !(e instanceof HttpError) ? 'Erro interno. Tente novamente.' : e.message });
    }
  };
}

module.exports = { HttpError, admin, db, ts, CFG, stripe, syncSubscription, requireUser, bodyOf, originOf, handler };
