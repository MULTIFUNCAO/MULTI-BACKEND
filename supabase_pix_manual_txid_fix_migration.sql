-- Rode este script no SQL Editor do painel do Supabase (Project > SQL Editor > New query).
--
-- Bugfix urgente (2026-09-01): "assinaturas.pix_manual_txid" e
-- "assinaturas.pix_manual_gerado_em" sumiram sozinhas — bug de durabilidade
-- já documentado no projeto (ver supabase_multifuncao_project.md). São as
-- duas colunas que o fallback de Pix estático (server.js, seção "PIX
-- ESTÁTICO — FALLBACK EMERGENCIAL, 2026-08-31") usa pra guardar o txid
-- gerado e permitir confirmação manual em /api/admin/ativar-manual — sem
-- elas, /api/admin/pix-manual-pendentes quebra com "column does not exist"
-- e ninguém consegue confirmar pagamento de Taxa de Acesso via Pix manual.
--
-- "taxa_acesso_entrada_em" é coluna NOVA (não é bugfix, é a correção do
-- modelo financeiro, mesma entrega) — âncora fixa da promoção de 2 meses
-- do plano "acesso", nunca sobrescrita numa renovação (diferente de
-- "inicio", que continua sendo o início do ciclo ATUAL, recalculado a cada
-- renovação como já era). Ver resolverValorAcesso() em server.js.
--
-- Script idempotente — seguro rodar de novo.

alter table assinaturas add column if not exists pix_manual_txid text;
alter table assinaturas add column if not exists pix_manual_gerado_em timestamptz;
alter table assinaturas add column if not exists taxa_acesso_entrada_em timestamptz;
