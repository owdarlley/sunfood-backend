# Sunfood API

> **O Sunfood tem dois repositórios.** Este (`sunfood-backend`) é a **API e o banco**: servidor, Supabase (migrações e modelos de e-mail) e testes do banco. O **site** fica em [`owdarlley/sunfood`](https://github.com/owdarlley/sunfood).

Backend real do Sunfood — Node.js + Express, com **Supabase** (Postgres + Auth) como banco de dados e autenticação, e **Mercado Pago** para pagamento por PIX e cartão. Todas as regras de negócio (pedido mínimo, cancelamento, disponibilidade de item, permissão por papel) são validadas aqui no servidor, nunca só no front-end.

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
| `CORS_ORIGIN` | Endereços do site que podem chamar a API, separados por vírgula (ex.: `https://owdarlley.github.io`) |
| `EMAIL_CONFIRM_REDIRECT_URL` | Para onde o link do e-mail de confirmação de cadastro leva (a tela de login do site, ex.: `https://owdarlley.github.io/sunfood/index.html?login=1`) |
| `PASSWORD_RESET_REDIRECT_URL` | URL pública de `redefinir-senha.html` (ex.: `https://seu-site.github.io/sunfood/redefinir-senha.html`) — precisa também estar na lista de Redirect URLs em Authentication → URL Configuration no Supabase |
| `MERCADOPAGO_ACCESS_TOKEN`, `MERCADOPAGO_WEBHOOK_SECRET` | Painel do Mercado Pago → Suas integrações → Credenciais. Sem isso, PIX e cartão são aprovados na hora como **provisório** (não cobra dinheiro real) |

```bash
npm start   # sobe em http://localhost:8787
npm test    # roda os testes (ver abaixo)
```

## Testes

| Onde | O que testa | Como rodar |
| --- | --- | --- |
| `test/*.test.js` | Regras de negócio, permissões por papel, validação, assinatura do webhook e o fluxo completo da API (cadastro → pedido → entregue → excluir conta) com um Supabase falso em memória | `npm test` (roda sozinho no GitHub a cada push) |
| `test/banco/*.sql` | As funções do banco de verdade: CPF do cadastro, estoque, status do pedido, formas de pagamento, prazo de cancelamento, pedido mínimo, painel e encerrar o dia | Colar no SQL Editor do Supabase |

Os `.sql` terminam com um erro **de propósito**: o Postgres desfaz tudo o que fizeram, então nada fica gravado. Passou = a mensagem começa com `TESTE_..._PASSOU`; qualquer `FALHA ...` é um bug.

Os testes das telas ficam no repositório do site (`owdarlley/sunfood`, pasta `tests/fluxo`).

## Banco e e-mails (Supabase)

- `supabase/migrations/`: histórico das mudanças no banco, na ordem em que foram aplicadas no projeto Supabase.
- `supabase/emails/`: modelos dos e-mails de **confirmação de cadastro** e **redefinição de senha**. Para usar, cole o HTML em Authentication → Emails, no painel do Supabase.

## Contas de demonstração

| Perfil | E-mail | Senha |
| --- | --- | --- |
| Cliente | `ana@email.com` | `praia2026` |
| Administração | `admin@sunfood.com` | (não publicada) |
| Cozinha | `cozinha@sunfood.com` | (não publicada) |

Senhas ficam só como hash dentro do Supabase Auth — o backend nunca vê nem guarda a senha em texto puro.

## Endpoints

| Método | Rota | Auth | Descrição |
| --- | --- | --- | --- |
| GET | `/health` | — | Responde `{ ok: true }` se a API está no ar |
| POST | `/auth/login` | — | Login via Supabase Auth (limite: 10 tentativas / 15 min por IP) |
| POST | `/auth/signup` | — | Cadastro (a conta sempre nasce como "cliente") |
| POST | `/auth/resend-confirmation` | — | Reenvia o e-mail de confirmação de cadastro |
| POST | `/auth/refresh` | — | Renova a sessão com o refresh token |
| GET | `/auth/me` | qualquer | Dados do usuário logado |
| POST | `/auth/forgot-password` | — | Dispara o e-mail de redefinição de senha |
| POST | `/auth/update-password` | — | Troca a senha usando o token do link do e-mail |
| POST | `/auth/delete-account` | qualquer | Exclui a própria conta (LGPD); os pedidos ficam no histórico sem dono |
| GET | `/products` | — | Cardápio |
| POST | `/products` | admin | Criar produto |
| PUT | `/products/:id` | admin | Editar produto (inclui estoque) |
| PATCH | `/products/:id/sold-out` | admin, cozinha | Sinalizar item (in)disponível |
| GET | `/tables` | — | Lista de mesas |
| PATCH | `/tables/:number/active` | admin | Ativar/desativar mesa |
| POST | `/orders` | cliente | Criar pedido (pedido mínimo, mesa ativa, estoque, quiosque aberto) |
| GET | `/orders/mine` | cliente | Pedidos do próprio usuário |
| GET | `/orders` | admin, cozinha | Lista de pedidos (`?status=` opcional) |
| GET | `/orders/:id` | dono ou admin/cozinha | Detalhe de um pedido |
| POST | `/orders/:id/cancel` | cliente (dono) | Cancelar (só "Na Fila" e dentro do prazo); estorna se já foi pago |
| PATCH | `/orders/:id/status` | admin, cozinha | Avançar status (kanban) |
| PATCH | `/orders/:id/payment-received` | admin | Anotar como o garçom recebeu um pedido "pagar na entrega" |
| GET | `/payments/status` | — | Diz se o Mercado Pago está configurado |
| POST | `/payments/pix/:orderId` | cliente (dono) | Gera a cobrança PIX (ou aprova como provisório sem Mercado Pago) |
| POST | `/payments/card/:orderId` | cliente (dono) | Abre o checkout de cartão do Mercado Pago (ou aprova como provisório) |
| GET | `/payments/pix/:orderId/status` | cliente (dono) | Status do pagamento do pedido |
| POST | `/payments/mercadopago/webhook` | Mercado Pago | Aviso de pagamento: assinatura verificada e status sempre reconferido na API deles |
| GET | `/kiosk-settings` | — | Estado do quiosque (pausado, dia encerrado, pedido mínimo, prazo de cancelamento) |
| PATCH | `/kiosk-settings/pause` | admin | Pausar/reabrir o quiosque |
| PATCH | `/kiosk-settings/min-order` | admin | Mudar o pedido mínimo |
| PATCH | `/kiosk-settings/cancel-window` | admin | Mudar o prazo de cancelamento (0 a 120 min) |
| GET | `/dashboard` | admin | Vendas do dia, por horário e mais vendidos |
| GET | `/ops-metrics` | admin | Tempo médio de fila/preparo, atrasos, cancelamentos, itens esgotados |
| GET | `/day-reports/latest` | admin | Último relatório de fechamento do dia |
| POST | `/close-day` | admin | Encerra o dia e grava o relatório |
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
- Sem `MERCADOPAGO_ACCESS_TOKEN`, PIX e cartão são aprovados como **provisório** (sem cobrança) e aparecem assim na tela de Pagamentos do admin. Configure o token antes de usar com clientes de verdade.

## Deploy (Vercel)

O projeto já está preparado pra rodar como função serverless (`api/index.js` + `vercel.json`). Pra publicar:

1. No painel da Vercel, confirme as variáveis de ambiente do projeto (`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `PASSWORD_RESET_REDIRECT_URL`, `EMAIL_CONFIRM_REDIRECT_URL`, `CORS_ORIGIN`, `MERCADOPAGO_ACCESS_TOKEN`, `MERCADOPAGO_WEBHOOK_SECRET`).
2. No painel do Supabase, em Authentication → URL Configuration, adicione a URL de `redefinir-senha.html` publicada na lista de Redirect URLs (senão o link do e-mail de recuperação de senha não funciona).
3. No painel do Mercado Pago, configure a Webhook URL apontando pra `https://<seu-domínio-vercel>/payments/mercadopago/webhook`.
4. Ative "Leaked Password Protection" em Authentication → Providers → Email, no painel do Supabase (recomendado pelo próprio linter de segurança do projeto).

## O que ainda falta pra comercialização plena

- Pagamentos ainda rodam como **provisório** até o `MERCADOPAGO_ACCESS_TOKEN` ser configurado na Vercel.
- Multi-tenant (vários quiosques usando o mesmo sistema, cada um com seus próprios dados) não existe — o sistema é single-tenant por design, conforme decidido.
- Termos de Uso e Política de Privacidade (na raiz do site) são um modelo honesto do que o sistema faz hoje, mas devem passar por um advogado antes do lançamento comercial real.
