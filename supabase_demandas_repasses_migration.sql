-- Rode este script no SQL Editor do painel do Supabase (Project > SQL Editor > New query).
--
-- Feature "Match automático de Demanda x Profissional" (MULTI-CRM,
-- 2026-09-06), item 3 — registro de "repassei essa demanda pra esse
-- profissional". Objetivo é só rastreabilidade (quem já recebeu contato
-- pra não repassar 2x nem perder histórico) — nada sofisticado por design
-- (sem status de aceite/recusa nesta fase, ver decisão registrada).
--
-- profissional_fonte distingue de onde veio o profissional sugerido, já que
-- esta feature cruza DUAS tabelas (ver supabase_profissionais_externos_
-- migration.sql): 'usuarios' (profissional_email preenchido) ou 'externo'
-- (profissional_externo_id preenchido). Só um dos dois vem preenchido por
-- linha — não é FK formal nem CHECK cruzado, mesmo padrão de referência
-- solta já usado em demandas_clientes.atribuido_para (decisão explícita,
-- não descuido).
--
-- demanda_id: referência solta pra demandas_clientes.id, sem FK formal —
-- mesmo motivo/padrão do resto do schema deste projeto.
--
-- Só o backend (service_role) toca esta tabela — RLS deny-all explícito
-- (mesmo padrão de suporte_tickets/crm_equipe/demandas_clientes/
-- profissionais_externos — "enable row level security" sozinho, sem
-- policy, já se mostrou instável nesse projeto, ver
-- supabase_multifuncao_project.md). Script idempotente — seguro rodar de novo.

create table if not exists demandas_repasses (
  id                       uuid primary key default gen_random_uuid(),
  criado_em                timestamptz not null default now(),
  demanda_id               uuid not null,
  profissional_fonte       text not null check (profissional_fonte in ('usuarios', 'externo')),
  profissional_email       text,
  profissional_externo_id  uuid,
  profissional_nome        text not null,
  profissional_whatsapp    text,
  -- crm_equipe, não usuarios — quem da equipe fez o repasse. Nullable:
  -- token antigo do Admin (senha única) não carrega userId (mesmo caso já
  -- documentado em suporte_tickets.criado_por).
  repassado_por            uuid references crm_equipe(id)
);

create index if not exists idx_demandas_repasses_demanda on demandas_repasses (demanda_id);

alter table demandas_repasses enable row level security;

drop policy if exists "Negar acesso publico" on demandas_repasses;
create policy "Negar acesso publico" on demandas_repasses for all to anon, authenticated using (false);

notify pgrst, 'reload schema';
