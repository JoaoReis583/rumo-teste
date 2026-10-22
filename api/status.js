// GET /api/status — diagnóstico TEMPORÁRIO: mostra se as variáveis de ambiente chegaram ao servidor.
// Não revela segredos (só se existem, o formato e o project_id). Apague este arquivo depois de configurar.
const { handler } = require('./_lib');

module.exports = handler('GET', async () => {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT || '';
  const fb = { definida: !!raw, tamanho: raw.length };
  if (raw) {
    const t = raw.trim();
    fb.comeca_com = t[0];
    fb.termina_com = t.slice(-1);
    try {
      const sa = JSON.parse(t);
      fb.json_valido = true;
      fb.project_id = sa.project_id || null;
      fb.tem_private_key = !!sa.private_key;
    } catch (e) { fb.json_valido = false; }
  }
  const sk = process.env.STRIPE_SECRET_KEY || '';
  const pk = process.env.STRIPE_PUBLISHABLE_KEY || '';
  const ak = process.env.ANTHROPIC_API_KEY || '';
  const gk = process.env.GEMINI_API_KEY || '';
  return {
    firebase_service_account: fb,
    stripe_secret_key: { definida: !!sk, comeco: sk.slice(0, 8) },
    stripe_publishable_key: { definida: !!pk, comeco: pk.slice(0, 8) },
    anthropic_api_key: { definida: !!ak, comeco: ak.slice(0, 7) },
    gemini_api_key: { definida: !!gk, comeco: gk.slice(0, 4) },
    plano: { valor: process.env.PLAN_VALUE || '(padrão 5.9)', teste_dias: process.env.TRIAL_DAYS ?? '(padrão 7)' },
  };
});
