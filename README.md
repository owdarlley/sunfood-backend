# Sunfood API

Backend real do Sunfood — Node.js + Express, com **Supabase** (Postgres + Auth) como banco de dados e autenticação, e **Mercado Pago** para pagamento PIX real. Todas as regras de negócio (pedido mínimo, cancelamento, disponibilidade de item, permissão por papel) são validadas aqui no servidor, nunca só no front-end.

Requer **Node.js 22.5 ou mais recente**.

## Rodando localmente

```bash
npm install
cp .env.example .env
```

Preencha o `.env`:

| Variável | Onde conseguir |
| --- | --- |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | Painel do Supabase → Project Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | Mesmo lugar — **nunca** exponha essa chave no front-end nem a commite |
| `PASSWORD_RESET_REDIRECT_URL` | URL pública de `redefinir-senha.html` (ex.: `https://seu-site.github.io/sunfood/redefinir-senha.html`) — precisa também estar na lista de Redirect URLs em Authentication → URL Configuration no Supabase |
| `MERCADOPAGO_ACCESS_TOKEN`, `MERCADOPAGO_WEBHOOK_SECRET` | Painel do Mercado Pago → Suas integrações → Credenciais. Sem isso, o PIX roda em **modo simulado** (não cobra dinheiro real) |

```bash
npm start   # sobe em http://localhost:8787
npm test    # roda a suíte de testes (regras de negócio, RBAC, validação, assinatura de webhook)
```

O schema do banco (tabelas, RLS, funções) já está provisionado no projeto Supabase — não há mais um `npm run seed` local; seed é feito por migração SQL direto no projeto.

## Contas de demonstração

| Perfil | E-mail | Senha |
| --- | --- | --- |
| Cliente | `ana@email.com` | `praia2026` |
| Administração | `admin@sunfood.com` | `admin2026` |
| Cozinha | `cozinha@sunfood.com` | `cozinha2026` |

Senhas ficam só como hash dentro do Supabase Auth — o backend nunca vê nem guarda a senha em texto puro.

## Endpoints

| Método | Rota | Auth | Descrição |
| --- | --- | --- | --- |
| POST | `/auth/login` | — | Login via Supabase Auth (rate-limited: 10 tentativas / 15 min por IP) |
| POST | `/auth/signup` | — | Cadastro real (rate-limited) — conta sempre nasce como "cliente" |
| POST | `/auth/refresh` | — | Renova a sessão com o refresh token |
| POST | `/auth/forgot-password` | — | Dispara o e-mail de redefinição de senha (rate-limited) |
| POST | `/auth/update-password` | — | Segunda etapa: troca a senha usando o token do link do e-mail |
| POST | `/auth/delete-account` | qualquer | Exclui a própria conta (LGPD) |
| GET | `/products` | — | Cardápio |
| POST | `/products` | admin | Criar produto |
| PUT | `/products/:id` | admin | Editar produto |
| PATCH | `/products/:id/sold-out` | admin, cozinha | Sinalizar item (in)disponível |
| GET | `/tables` | — | Lista de mesas |
| PATCH | `/tables/:number/active` | admin | Ativar/desativar mesa |
| POST | `/orders` | cliente | Criar pedido (RN01 + mesa ativa + item disponível, tudo checado aqui; rate-limited) |
| GET | `/orders/mine` | cliente | Histórico do próprio usuário |
| GET | `/orders` | admin, cozinha | Lista de pedidos (`?status=` opcional) |
| GET | `/orders/:id` | dono ou admin/cozinha | Detalhe de um pedido |
| POST | `/orders/:id/cancel` | cliente (dono) | Cancelar (RN04: só com status "Na Fila") |
| PATCH | `/orders/:id/status` | admin, cozinha | Avançar status (kanban) |
| POST | `/payments/pix/:orderId` | cliente (dono) | Gera a cobrança PIX (real ou simulada) pro pedido |
| GET | `/payments/pix/:orderId/status` | cliente (dono) | Status do pagamento do pedido |
| POST | `/payments/pix/:orderId/simulate-approve` | cliente (dono) | Só funciona em modo simulado — aprova o "pagamento" pra testar o fluxo sem Mercado Pago configurado |
| POST | `/payments/mercadopago/webhook` | Mercado Pago | Notificação de pagamento — assinatura verificada, status sempre reconferido na API deles |
| GET | `/kiosk-settings` | — | Estado atual (pausado/dia encerrado) |
| PATCH | `/kiosk-settings/pause` | admin | Pausar/reabrir o quiosque |
| GET | `/dashboard` | admin | KPIs do dia + vendas por horário + mais vendidos |
| GET | `/ops-metrics` | admin | Tempo médio de fila/preparo, atrasos, cancelamentos, itens esgotados |
| GET | `/day-reports/latest` | admin | Último relatório de fechamento de dia |
| POST | `/close-day` | admin | Encerra o dia e grava um relatório real |
| POST | `/reopen-day` | admin | Desfaz o encerramento |

## Modelo de dados (Supabase Postgres)

`profiles` (papel do usuário, ligado a `auth.users`), `products`, `kiosk_tables`, `orders` + `order_items` + `order_status_log`, `kiosk_settings`, `day_reports`. Ver as migrações aplicadas no projeto Supabase para o schema completo, incluindo as funções `create_order`, `set_order_status`, `dashboard_stats`, `ops_metrics` e `close_day`, que gravam/agregam atomicamente e só são executáveis pelo `service_role` (nunca direto por um cliente autenticado).

## Segurança

- **Supabase Auth** cuida de senha (hash), sessão (access + refresh token), confirmação de e-mail e recuperação de senha — nada disso é reinventado aqui.
- **Row Level Security** habilitada em toda tabela; a service role (usada só pelo backend) ignora RLS de propósito porque é este servidor que valida as regras de negócio antes de gravar — por isso as policies de escrita direta em `orders`/`order_items` foram removidas: um cliente com o próprio token não consegue criar ou alterar pedido pulando o Express.
- Funções do banco que gravam dados (`create_order`, `set_order_status`, `dashboard_stats`, `ops_metrics`, `close_day`) são executáveis **só pelo `service_role`** — nem `anon` nem `authenticated` conseguem chamá-las direto pela API REST do Supabase.
- Trigger no banco impede um usuário de trocar o próprio `role` direto pela API (proteção contra auto-escalação de privilégio).
- Validação de entrada com **zod** em todo endpoint que recebe body.
- **express-rate-limit** em login, cadastro, recuperação de senha, criação de pedido e geração de PIX.
- **helmet** + **CORS** restrito a uma lista de origens (`CORS_ORIGIN`, separadas por vírgula).
- Webhook do Mercado Pago com **verificação de assinatura HMAC** e reconsulta do status na API deles antes de liberar qualquer pedido — o corpo da notificação nunca é confiado por si só.
- O sandbox de pagamento (sem `MERCADOPAGO_ACCESS_TOKEN`) nunca finge cobrar de verdade, e a rota de "simular aprovação" se autodesativa assim que o token real é configurado.

## Deploy (Vercel)

O projeto já está preparado pra rodar como função serverless (`api/index.js` + `vercel.json`). Pra publicar:

1. No painel da Vercel, confirme as variáveis de ambiente do projeto (`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `PASSWORD_RESET_REDIRECT_URL`, `CORS_ORIGIN`, `MERCADOPAGO_ACCESS_TOKEN`, `MERCADOPAGO_WEBHOOK_SECRET`).
2. No painel do Supabase, em Authentication → URL Configuration, adicione a URL de `redefinir-senha.html` publicada na lista de Redirect URLs (senão o link do e-mail de recuperação de senha não funciona).
3. No painel do Mercado Pago, configure a Webhook URL apontando pra `https://<seu-domínio-vercel>/payments/mercadopago/webhook`.
4. Ative "Leaked Password Protection" em Authentication → Providers → Email, no painel do Supabase (recomendado pelo próprio linter de segurança do projeto).

## O que ainda falta pra comercialização plena

- Pagamento por **cartão** ainda é simulado (só PIX processa de verdade) — cartão exigiria integrar o Payment Brick / tokenização de cartão do Mercado Pago no front.
- Multi-tenant (vários quiosques usando o mesmo sistema, cada um com seus próprios dados) não existe — o sistema é single-tenant por design, conforme decidido.
- Termos de Uso e Política de Privacidade (na raiz do site) são um modelo honesto do que o sistema faz hoje, mas devem passar por um advogado antes do lançamento comercial real.
