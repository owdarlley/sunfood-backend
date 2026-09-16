# Sunfood API

Backend real do protótipo Sunfood — Node.js + Express + SQLite (via `better-sqlite3`). Substitui o estado mockado do front-end por banco de dados de verdade, com autenticação e regras de negócio validadas no servidor.

## Rodando

```bash
npm install
cp .env.example .env      # ajuste JWT_SECRET/CORS_ORIGIN se precisar
npm run seed               # cria server/sunfood.db com contas, produtos e mesas
npm start                  # sobe em http://localhost:8787
```

`npm run seed` é idempotente para produtos/mesas (não duplica se já existirem) e sempre garante as 3 contas de demonstração.

## Contas de demonstração (senha com hash bcrypt no banco, nunca em texto puro)

| Perfil | E-mail | Senha |
| --- | --- | --- |
| Cliente | `ana@email.com` | `praia2026` |
| Administração | `admin@sunfood.com` | `admin2026` |
| Cozinha | `cozinha@sunfood.com` | `cozinha2026` |

## Endpoints

| Método | Rota | Auth | Descrição |
| --- | --- | --- | --- |
| POST | `/auth/login` | — | Login (rate-limited: 10 tentativas / 15 min por IP) |
| GET | `/products` | — | Cardápio |
| POST | `/products` | admin | Criar produto |
| PUT | `/products/:id` | admin | Editar produto |
| PATCH | `/products/:id/sold-out` | admin, cozinha | Sinalizar item (in)disponível |
| GET | `/tables` | — | Lista de mesas |
| PATCH | `/tables/:number/active` | admin | Ativar/desativar mesa |
| POST | `/orders` | cliente | Criar pedido (RN01 + mesa ativa + item disponível, tudo checado aqui) |
| GET | `/orders/mine` | cliente | Histórico do próprio usuário |
| GET | `/orders` | admin, cozinha | Lista de pedidos (`?status=` opcional) |
| GET | `/orders/:id` | dono ou admin/cozinha | Detalhe de um pedido |
| POST | `/orders/:id/cancel` | cliente (dono) | Cancelar (RN04: só com status "Na Fila") |
| PATCH | `/orders/:id/status` | admin, cozinha | Avançar status (kanban) |
| GET | `/kiosk-settings` | — | Estado atual (pausado/dia encerrado) |
| PATCH | `/kiosk-settings/pause` | admin | Pausar/reabrir o quiosque |
| GET | `/dashboard` | admin | KPIs do dia, calculados de verdade a partir dos pedidos |
| POST | `/close-day` | admin | Encerra o dia e grava um relatório real em `day_reports` |
| POST | `/reopen-day` | admin | Desfaz o encerramento |

## Modelo de dados

`users`, `products`, `tables`, `orders` + `order_items`, `kiosk_settings`, `day_reports` — ver `src/db.js` para o schema completo. Pedido e "ticket da cozinha" viraram **uma única tabela** (`orders`), diferente do protótipo original que mantinha os dois em arrays separados e sincronizava manualmente.

## Segurança

- Senhas com **bcrypt** (custo 12).
- **JWT** assinado no servidor (papel do usuário embutido no token — não é mais um toggle escolhido no front).
- Todas as queries via **prepared statements** do `better-sqlite3` — sem concatenação de string, sem SQL injection.
- Validação de entrada com **zod** em todo endpoint que recebe body.
- **express-rate-limit** no login.
- **helmet** + **CORS** restrito à origem configurada em `.env`.
- Middleware de **autorização por papel** (`requireRole`) nas rotas de admin/cozinha.
- Regras de negócio reforçadas no servidor, não só no front: RN01 (pedido mínimo R$10), RN04 (cancelar só com status "Na Fila"), mesa precisa existir e estar ativa, produto esgotado não entra em pedido novo.

## O que ainda falta (próximas fases)

- Telas de Admin e Cozinha no front (`app-cliente.dc.html`) — hoje só a lógica/estado existe, sem interface; o backend acima já dá suporte a elas.
- Hospedagem pública da API (por ora só local).
- Cadastro (`/auth/signup`) e recuperação de senha — as telas existem no front mas ainda são só front-end mockado.
