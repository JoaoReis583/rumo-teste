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
  valueAnual: Number(process.env.PLAN_VALUE_ANUAL || (Number(process.env.PLAN_VALUE || 5.9) * 10)), // 2 meses grátis
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

// ---- Verificação de assinatura do webhook do Stripe ----
// Usa crypto nativo do Node (sem dependências externas).
async function verifyStripeSignature(rawBody, sigHeader, secret) {
  if (!secret) return; // sem STRIPE_WEBHOOK_SECRET configurado, pula a verificação
  const crypto = require('crypto');
  const parts = String(sigHeader || '').split(',');
  const tPart = parts.find(p => p.startsWith('t='));
  const v1Parts = parts.filter(p => p.startsWith('v1='));
  if (!tPart || !v1Parts.length) throw new HttpError(400, 'Stripe-Signature inválido.');
  const t = tPart.slice(2);
  // Protege contra replay de até 5 minutos
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) throw new HttpError(400, 'Webhook expirado (replay protection).');
  const payload = `${t}.${rawBody}`;
  const expected = crypto.createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
  const match = v1Parts.some(p => {
    try {
      return crypto.timingSafeEqual(Buffer.from(p.slice(3), 'hex'), Buffer.from(expected, 'hex'));
    } catch { return false; }
  });
  if (!match) throw new HttpError(400, 'Assinatura do webhook inválida.');
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
    plan_interval: sub.items && sub.items.data && sub.items.data[0] && sub.items.data[0].plan ? sub.items.data[0].plan.interval : 'month',
    updated_at: ts(new Date()),
  };
  await ref.set(data, { merge: true });
  // paid: já houve cobrança real (assinatura 'active'; o período de teste não conta)
  return { ...data, uid, access_until: until, paid: sub.status === 'active' };
}

// ---- Indicação por link: 5 amigos pagantes = 30 dias grátis (acumula a cada bloco de 5) ----
const PREMIO_DIAS = 30;
const BLOCO = 5;
const TRAVA_DIAS = 37; // 7 dias de teste + 30 do primeiro período
// Conta a indicação quando o amigo paga de verdade. Transacional e idempotente (só conta uma vez por amigo).
async function premiarIndicacao(uid) {
  if (!uid) return { ok: false };
  const usageRef = db().collection('referral_uses').doc(uid);
  return db().runTransaction(async (t) => {
    const usage = await t.get(usageRef);
    if (!usage.exists || usage.data().pago) return { ok: false };
    const ownerUid = usage.data().indicado_por;
    const ownerRef = db().collection('referrals').doc(ownerUid);
    const subRef = db().collection('subscriptions').doc(ownerUid);
    const [owner, subSnap] = await Promise.all([t.get(ownerRef), t.get(subRef)]);
    t.update(usageRef, { pago: true, pago_em: ts(new Date()) });
    if (!owner.exists) return { ok: false };
    const total = (owner.data().total || 0) + 1;
    const ganhou = Math.floor(total / BLOCO) > Math.floor((total - 1) / BLOCO);
    const upd = { total };
    if (ganhou) {
      upd.premiados = (owner.data().premiados || 0) + 1;
      const sub = subSnap.data() || {};
      const base = sub.access_until ? sub.access_until.toDate() : new Date();
      const nova = new Date(Math.max(base.getTime(), Date.now()) + PREMIO_DIAS * 86400000);
      t.set(subRef, { access_until: ts(nova), updated_at: ts(new Date()) }, { merge: true });
    }
    t.update(ownerRef, upd);
    return { ok: true, premio: ganhou, total };
  });
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

// ---- Rate limiting por IP usando Firestore ----
// Evita abuso das rotas /api além do limite diário da IA.
// windowMs: janela em ms; max: máximo de requisições por janela.
async function rateLimit(req, key, max, windowMs) {
  if (process.env.RATE_LIMIT_DISABLED === '1') return; // facilita testes locais
  const crypto = require('crypto');
  const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  const ipHash = crypto.createHash('sha256').update(ip).digest('hex').slice(0, 16); // anonimiza
  const window = Math.floor(Date.now() / windowMs);
  const docId = `rl_${key}_${ipHash}_${window}`;
  const ref = db().collection('_rate_limits').doc(docId);
  const count = await db().runTransaction(async (t) => {
    const s = await t.get(ref);
    const c = (s.exists ? s.data().n : 0) + 1;
    const expiry = admin().firestore.Timestamp.fromDate(new Date(Date.now() + windowMs * 2));
    t.set(ref, { n: c, expiry }, { merge: true });
    return c;
  });
  if (count > max) {
    const retryAfter = Math.ceil(windowMs / 1000);
    throw new HttpError(429, `Muitas requisições. Aguarde ${Math.ceil(retryAfter / 60)} minutos e tente de novo.`);
  }
}

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

module.exports = { HttpError, admin, db, ts, CFG, stripe, verifyStripeSignature, syncSubscription, premiarIndicacao, PREMIO_DIAS, BLOCO, TRAVA_DIAS, requireUser, bodyOf, originOf, rateLimit, handler };
