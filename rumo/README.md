# Rumo — Firebase

Site estático (hospedado na Vercel) que usa **Firebase Authentication** para o login por e-mail e senha e o **Cloud Firestore** para guardar os dados. Não há backend próprio. O Supabase não é mais usado.

## Funções do painel

- **Resumo**: entradas, gastos, saldo e contas a pagar do mês, planejado x gasto por categoria, próximas contas e metas.
- **Gastos**: lançamento de gastos e rendas extras, filtro por categoria e navegação mês a mês.
- **Contas fixas**: vencimentos, status (paga, pendente, atrasada) e botão de marcar como paga (cria o gasto automaticamente).
- **Metas**: objetivos com prazo, guardar e retirar valores, quanto separar por mês.
- **Relatórios**: comparação dos últimos 6 meses, gastos por categoria e exportação em CSV.
- **Planejamento**: renda mensal, divisão em % e reserva de emergência.

## Configurar o Firebase (uma vez)

1. Acesse https://console.firebase.google.com e clique em **Adicionar projeto** (o Google Analytics pode ficar desligado).
2. Em **Criação → Authentication → Vamos começar → Método de login**, ative **E-mail/senha** (deixe "Link por e-mail" desligado).
3. Em **Criação → Firestore Database → Criar banco de dados**, escolha uma região (por exemplo `southamerica-east1`, São Paulo) e o modo de **produção**.
4. Ainda no Firestore, abra a aba **Regras**, apague o conteúdo, cole o arquivo `firestore.rules` deste projeto e clique em **Publicar**. Sem esse passo o painel mostra um aviso amarelo e não salva nada.
5. Em **Configurações do projeto (engrenagem) → Seus apps → ícone `</>` (Web)**, registre um app e copie o objeto `firebaseConfig`.
6. Abra `index.html`, procure `FIREBASE_CONFIG` e preencha `apiKey`, `authDomain`, `projectId` e `appId` com os valores copiados.
7. Em **Authentication → Configurações → Domínios autorizados**, adicione o endereço do seu site na Vercel (por exemplo `seu-site.vercel.app` e o domínio próprio, se tiver).

A `apiKey` do Firebase pode ficar no site: ela só identifica o projeto. Quem protege os dados são as regras do `firestore.rules`, que deixam cada usuário ler e gravar apenas em `users/{seu uid}` e validam os valores no servidor.

## Cadastro e limite de tentativas

O cadastro entra direto, sem e-mail de confirmação, então não existe mais o limite de envios que bloqueava a criação de contas. O e-mail só é usado em "Esqueci minha senha" (o Firebase envia o link de redefinição).

No site, cada aparelho pode fazer até **5 tentativas por hora** de criar conta e **5 por hora** de "Esqueci minha senha". Na 5ª, o botão fica bloqueado e mostra quanto falta para liberar. Essa trava é só no navegador; o Firebase tem a própria proteção contra abuso (mensagem "Muitas tentativas seguidas").

## Publicar na Vercel

Importe esta pasta na Vercel. O `build.js` gera o site em `dist/`, e a pasta `api/` vira funções de servidor (precisa do `npm install` automático da Vercel, por causa do `firebase-admin`). Defina as variáveis de ambiente da seção abaixo **antes** do deploy.

## Assinatura mensal com Stripe

Fluxo: a pessoa cria a conta, vê a tela de teste/assinatura e clica no botão. O servidor (`api/assinar.js`) cria uma sessão de pagamento no Stripe e o formulário do cartão aparece **dentro do site** (Checkout embutido). Ao pagar, `api/sincronizar.js` confere no Stripe e libera o acesso na hora. Renovações, falhas e cancelamentos chegam por webhook em `api/webhook-stripe.js`. O acesso fica em `subscriptions/{uid}` no Firestore; as regras só deixam gravar dados enquanto `access_until` estiver no futuro (sem acesso, o painel vira somente leitura). Só o servidor escreve em `subscriptions`. O botão "Assinatura" do painel abre o portal do Stripe (`api/portal.js`) para trocar o cartão, ver faturas e cancelar.

### Variáveis de ambiente (Vercel > Settings > Environment Variables)

| Nome | Tipo | O que é |
|---|---|---|
| `STRIPE_SECRET_KEY` | Secret | Chave secreta (`sk_test_...` para testar, `sk_live_...` em produção). Stripe > Desenvolvedores > Chaves de API. |
| `STRIPE_PUBLISHABLE_KEY` | Config | Chave publicável (`pk_test_...` / `pk_live_...`), da mesma tela. Use sempre o mesmo modo (teste ou produção) nas duas chaves. |
| `FIREBASE_SERVICE_ACCOUNT` | Secret | Conteúdo inteiro do JSON da conta de serviço (Firebase > Configurações do projeto > Contas de serviço > Gerar nova chave privada). |
| `PLAN_VALUE` | Config | Opcional. Mensalidade em reais, ex.: `5.90` (padrão 5.90). |
| `TRIAL_DAYS` | Config | Opcional. Dias de teste grátis (padrão 7; `0` desliga). |

O preço mostrado na tela está em `const PLAN` no `index.html`; mantenha igual a `PLAN_VALUE` e `TRIAL_DAYS`.

### Configurar no Stripe (modo de teste primeiro)

1. Crie a conta no Stripe e ative o **modo de teste** (chave de teste).
2. Em *Configurações > Faturamento > Portal do cliente*, ative o portal e salve (é o que faz o botão "Assinatura" funcionar).
3. Em *Desenvolvedores > Webhooks > Adicionar endpoint*, use a URL `https://SEU-SITE.vercel.app/api/webhook-stripe` e marque os eventos: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid` e `invoice.payment_failed`.
4. Publique o novo `firestore.rules` no Firebase.

O webhook não usa segredo de assinatura: o aviso só indica qual assinatura mudou, e o servidor lê o estado real direto no Stripe.

### Ir para produção (cobrança real)

1. Ative a conta no Stripe (Ativar conta: dados do negócio, identidade e conta bancária) e saia do modo de teste.
2. No modo real, copie as chaves `sk_live_...` e `pk_live_...` e **substitua** `STRIPE_SECRET_KEY` e `STRIPE_PUBLISHABLE_KEY` na Vercel.
3. Refaça no modo real o que foi feito no teste: o **webhook** (mesma URL e mesmos eventos) e o **Portal do cliente**. Cada modo tem a sua própria configuração.
4. No Firestore, apague os documentos de `subscriptions/` criados nos testes: eles guardam códigos de cliente do modo de teste, que não existem no modo real.
5. Para cobrar desde o primeiro dia, defina `TRIAL_DAYS=0` na Vercel e `trial:0` em `const PLAN` no `index.html`.
6. Apague `api/status.js`, faça o redeploy e teste com uma compra real; depois cancele e peça o reembolso no painel do Stripe.

### Testar

Crie uma conta no site e clique em "Começar teste grátis". Use o cartão de teste `4242 4242 4242 4242`, qualquer data futura e qualquer CVC. Confira no Firestore o documento `subscriptions/{uid}` com `status: trial`.

## Assistente de IA

Botão "Assistente" no canto do painel (só aparece para quem tem acesso ativo). O assistente usa o Claude (Anthropic) e recebe, a cada pergunta, um resumo dos dados do mês da própria pessoa (renda, planejado x gasto por categoria, contas fixas, metas e últimos lançamentos). A conversa não é guardada. A rota é `api/assistente.js`.

O que ele faz: avalia a divisão da renda, analisa onde o dinheiro está indo, acompanha contas fixas e metas, ajuda a montar a reserva e organizar dívidas, explica termos financeiros e ensina a usar o site. Ele não indica investimentos específicos nem substitui um profissional.

| Variável | Tipo | O que é |
|---|---|---|
| `ANTHROPIC_API_KEY` | Secret | Chave da API (console.anthropic.com > API Keys). Cada pergunta é cobrada na sua conta Anthropic: adicione crédito e **defina um limite de gasto** lá. |
| `ASSISTANT_MODEL` | Config | Opcional. Padrão `claude-haiku-5-5` (mais barato). Para respostas mais fortes use `claude-sonnet-5-5`. |
| `ASSISTANT_DAILY_LIMIT` | Config | Opcional. Perguntas por pessoa por dia (padrão 30). |

Os dados enviados à IA devem constar na Política de Privacidade do site.

## Dados

Estrutura no Firestore:

- `users/{uid}`: `income_cents` e `pcts` (divisão em %).
- `users/{uid}/transactions`: gastos e rendas extras.
- `users/{uid}/bills`: contas fixas.
- `users/{uid}/goals`: metas.

Os dados que estavam no Supabase não são migrados automaticamente (as senhas não podem ser exportadas). As contas precisam ser criadas de novo.
