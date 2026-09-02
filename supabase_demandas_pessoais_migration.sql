-- Rode este script no SQL Editor do painel do Supabase (Project > SQL Editor > New query).
--
-- Handoff MULTI-CRM 2026-09-02, item 4 (Demandas). ATENÇÃO: apesar do nome
-- (mantido por decisão do Thiago), isto NÃO tem relação nenhuma com
-- "pedidos" (demanda de serviço do marketplace) nem com "demandas-suporte"
-- (MULTI-SUP, cadastro de pedido em nome de cliente). É uma lista de
-- tarefas/pendências PESSOAL de quem está logado no CRM — cada pessoa da
-- equipe vê só as próprias, não uma lista compartilhada.
--
-- Mesmo padrão de suporte_tickets/vendas_pipeline: RLS com policy de
-- negação explícita (só o backend/service_role toca), script idempotente.

create table if not exists demandas_pessoais (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  -- Dono da tarefa — crm_equipe, nunca null (diferente de suporte_tickets/
  -- vendas_pipeline, que toleram responsável nulo): sem dono não faz
  -- sentido existir numa lista pessoal. Quem loga com o token antigo (senha
  -- única, sem userId) não consegue usar esta tela — checado no backend,
  -- não só aqui.
  dono_id      uuid not null references crm_equipe(id),
  texto        text not null,
  concluida    boolean not null default false,
  prazo        date,
  concluida_em timestamptz
);

create index if not exists demandas_pessoais_dono_idx on demandas_pessoais (dono_id);

alter table demandas_pessoais enable row level security;

drop policy if exists "Negar acesso publico" on demandas_pessoais;
create policy "Negar acesso publico" on demandas_pessoais for all to anon, authenticated using (false);
