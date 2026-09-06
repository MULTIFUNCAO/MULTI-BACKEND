-- Rode este script no SQL Editor do painel do Supabase (Project > SQL Editor > New query).
--
-- Fase 2 do diagnóstico de estrutura do CRM (2026-09-06) — "Reorganizar Caixa
-- de Entrada como Triagem". ALTER na tabela existente (ver
-- supabase_demandas_clientes_migration.sql), não uma tabela nova — a
-- estrutura já resolve, só faltavam 2 valores de enum e 1 coluna:
--
-- 1) "fila" só aceitava demanda/vendas/suporte (sempre um destino já
--    escolhido) — não tinha como existir uma linha "ainda sendo triada, sem
--    destino decidido". Novo valor 'triagem' (agora o default) cobre isso.
-- 2) "status" não tinha 'aguardando_resposta' (equipe respondeu, esperando
--    o cliente voltar) — as outras views pedidas (Em andamento/Finalizadas)
--    já mapeiam pra em_andamento/resolvida, que já existiam.
-- 3) "atualizado_em" não existia (só criado_em/resolvido_em) — usada tanto
--    pra "encaminhada há quanto tempo" quanto pra distinguir "Em triagem"
--    (nunca saiu de lá: atualizado_em == criado_em) de "Retornaram para
--    triagem" (já foi movida antes e voltou: atualizado_em != criado_em) —
--    sem precisar de uma coluna nova só pra esse flag, ver Overview/App.
--
-- "Novas" (conversa do WhatsApp sem nenhuma linha em demandas_clientes ainda)
-- e "Encaminhada para serviços" (fila='demanda', só rótulo novo na tela de
-- Triagem) não precisam de nenhuma coluna — são derivadas do que já existe.
--
-- Script idempotente — seguro rodar de novo.

alter table demandas_clientes drop constraint if exists demandas_clientes_fila_check;
alter table demandas_clientes add constraint demandas_clientes_fila_check
  check (fila in ('triagem', 'demanda', 'vendas', 'suporte'));
alter table demandas_clientes alter column fila set default 'triagem';

alter table demandas_clientes drop constraint if exists demandas_clientes_status_check;
alter table demandas_clientes add constraint demandas_clientes_status_check
  check (status in ('aberta', 'em_andamento', 'aguardando_resposta', 'resolvida', 'cancelada'));

alter table demandas_clientes add column if not exists atualizado_em timestamptz not null default now();
-- Backfill das 3 linhas que já existem (criadas antes desta coluna existir)
-- pra que leiam como "Em triagem"/"o que já eram" e não apareçam como
-- "Retornaram para triagem" por um falso positivo de timestamp.
update demandas_clientes set atualizado_em = criado_em where atualizado_em <> criado_em;

notify pgrst, 'reload schema';
