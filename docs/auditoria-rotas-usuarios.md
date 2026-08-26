# Auditoria: rotas não-admin vs. tabela `usuarios`

Data: 2026-08-26
Escopo: rotas de `server.js` que NÃO são `/api/admin/*` e fazem select/update/insert na tabela `usuarios`.
Critérios checados: uso de `role` sem considerar contas presas em `client`; queries que dependem de `usuarios.id == auth.users.id` sem tratar divergência; lugares que esperam `categoria_servico` preenchido sem checar null; lugares que dependem do trigger `trg_lock_approved` sem usar `service_role`.

Método: leitura estática do código. Nenhuma API foi chamada, nenhuma credencial foi usada.

## 1. Rotas não-admin que tocam `usuarios`

| Rota | Linha(s) |
|---|---|
| `POST /api/email/campanha` | 278 |
| `POST /api/documentos/analisar-ia` | 618, 666 |
| `POST /api/auth/login` | 763-771 |
| `POST /api/moedas/gerar-pix` | 1658-1662 |
| `POST /api/moedas/responder-oportunidade` | 1762 |
| `POST /api/cron/lembretes` | 3017, 3089 |

## 2. Pontos suspeitos por rota

### `server.js:1658-1662` — `/api/moedas/gerar-pix`
Checagem de `role === "professional"` pra liberar compra de moeda. Risco: conta aprovada mas presa em `role="client"` (bug histórico do approve-professional, casos Fábio/Junior/Adilson) cairia em 403 à toa.

**Status:** corrigido — commit `b5ab535`. Agora aceita `role === "professional"` OU `approved === true`.

### `server.js:763-771` — `/api/auth/login`
Dois pontos:
- Fallback de `role` caía em `"client"` sem checar `approved` quando o profile vinha vazio.
- `user.id` devolvido sempre foi `auth.users.id`, nunca `usuarios.id` — risco se o front usar esse id pra buscar em `usuarios` direto (há casos reais de divergência na memória do projeto: migração de categorias, customer_id do Junior).

**Status:** ambos corrigidos — commits `2a64f36` (fallback de role) e `957390c` (campo aditivo `usuarios_id`).

### `server.js:278` — `/api/email/campanha`
Só `select("name, email")`, sem tocar `role`/`categoria_servico`/`approved`.

**Status:** sem achado.

### `server.js:618, 666` — `/api/documentos/analisar-ia`
Select por `email`, update só de `analise_ia_status`/`analise_ia_observacoes` — não toca `approved`/`role`, roda com o client service_role (`supabase`, linhas 49-51).

**Status:** sem achado.

### `server.js:1762` — `/api/moedas/responder-oportunidade`
Só lê `saldo_moedas` pra montar mensagem de erro, não decide nada com base em `role`/`categoria_servico`/`approved`.

**Status:** sem achado.

### `server.js:3017, 3089` — `/api/cron/lembretes`
Join com `usuarios` por `email` só pra pegar `onesignal_player_id`.

**Status:** sem achado.

### `categoria_servico`
Não aparece em nenhuma rota não-admin. Só em `/api/admin/professionals` (`server.js:2383`, `2480`), fora do escopo desta auditoria, já com fallback `|| []` pra null.

### `trg_lock_approved`
Nenhuma rota não-admin escreve em `approved`. Todo write real fica em `/api/admin/approve-professional`/`reject-professional`, usando o client service_role.

## Resumo de status

| # | Achado | Status |
|---|---|---|
| 1 | `moedas/gerar-pix` bloqueava profissional preso em `role=client` | ✅ Corrigido (`b5ab535`) |
| 2 | `auth/login` fallback forçava `role="client"` mesmo pra aprovado | ✅ Corrigido (`2a64f36`) |
| 3 | `user.id` do login sempre `auth.users.id`, nunca `usuarios.id` | ✅ Corrigido (`957390c`) |
| — | `categoria_servico` / `trg_lock_approved` | Sem achado nas rotas não-admin |
