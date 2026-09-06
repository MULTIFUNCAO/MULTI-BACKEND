-- Rode este script no SQL Editor do painel do Supabase (Project > SQL Editor > New query).
--
-- Fase 3 do diagnóstico de estrutura do CRM (2026-09-06), "Corrigir Vendas e
-- pipeline". ALTER na tabela existente (ver
-- supabase_vendas_pipeline_migration.sql), não uma tabela nova.
--
-- 1) Liga demandas_clientes (fila='vendas', Triagem da Fase 2) ao
--    vendas_pipeline sem duplicar dado: demanda_id aponta pra qual conversa
--    originou o lead — nullable (leads adicionados manualmente em Vendas
--    continuam sem isso) e único (uma demanda só pode gerar um lead, mesmo
--    padrão de índice único que permite múltiplos NULL no Postgres).
-- 2) profissional_email vira opcional: uma demanda que chega só com
--    telefone (sem e-mail ainda) pode virar lead antes da equipe descobrir
--    o e-mail na conversa — telefone (coluna nova) cobre esse período.
--    NÃO inventamos um e-mail falso pra isso (ver decisão registrada na
--    conversa: um e-mail fabricado geraria duplicata de verdade quando a
--    pessoa se cadastrar com o e-mail real dela depois).
-- 3) estagio ganha 3 valores novos, sem tocar nos 4 que já existem:
--    'novo_lead' (antes de 'contato_feito' — cobre lead que chegou pela
--    Triagem automática, ninguém ligou ainda) e 'aguardando_resposta'
--    (mesmo nome usado em demandas_clientes.status na Fase 2, por
--    consistência). 'pagamento_confirmado' é sincronizado pelo backend a
--    cada leitura contra assinaturas (ver GET /api/admin/vendas-pipeline),
--    nunca setado manualmente por um clique.
--
-- Script idempotente — seguro rodar de novo.

alter table vendas_pipeline alter column profissional_email drop not null;
alter table vendas_pipeline add column if not exists telefone text;
alter table vendas_pipeline add column if not exists demanda_id uuid references demandas_clientes(id);

create unique index if not exists vendas_pipeline_demanda_id_key on vendas_pipeline (demanda_id);

alter table vendas_pipeline drop constraint if exists vendas_pipeline_estagio_check;
alter table vendas_pipeline add constraint vendas_pipeline_estagio_check
  check (estagio in (
    'novo_lead', 'contato_feito', 'aguardando_resposta', 'documentos_pendentes',
    'pagamento_pendente', 'ativo', 'pagamento_confirmado'
  ));

notify pgrst, 'reload schema';
