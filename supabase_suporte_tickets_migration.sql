-- Rode este script no SQL Editor do painel do Supabase (Project > SQL Editor > New query).
--
-- Handoff MULTI-CRM 2026-09-02, item 2 (Caixa de Entrada) — só a metade de
-- "Módulo de Suporte" (problemas de profissional, tipo ticket: aberto → em
-- andamento → resolvido). A metade de WhatsApp Business API segue travada
-- numa decisão de provedor (ver EM_CONSTRUCAO.inbox em App.jsx) — não faz
-- parte deste script.
--
-- Tabela nova, sem relação com "pedidos" (que já tem origem='suporte' pra
-- outra coisa: demanda de serviço criada em nome de um cliente, MULTI-SUP —
-- ver /api/admin/demandas-suporte). Isso aqui é "a Multi tem um problema
-- pra resolver com um profissional" (não recebeu pagamento, documento
-- travado, dúvida, reclamação etc.), não uma solicitação de serviço.
--
-- Só o backend (service_role) toca esta tabela — RLS com policy de negação
-- explícita (mesmo padrão já usado em crm_equipe/config_monetizacao; "enable
-- row level security" sozinho, sem policy, já se mostrou instável nesse
-- projeto — ver supabase_multifuncao_project.md). Script idempotente —
-- seguro rodar de novo.

create table if not exists suporte_tickets (
  id             uuid primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),
  atualizado_em  timestamptz not null default now(),
  -- Livre (nem todo profissional que liga/manda WhatsApp já tem categoria/
  -- id resolvido na hora) — email é o único vínculo obrigatório, pra dar pra
  -- cruzar com "usuarios" depois se precisar, sem travar a criação do
  -- ticket nisso.
  profissional_email  text not null,
  profissional_nome   text not null,
  assunto        text not null,
  descricao      text not null,
  prioridade     text not null default 'normal' check (prioridade in ('baixa','normal','alta')),
  status         text not null default 'aberto' check (status in ('aberto','em_andamento','resolvido')),
  -- Quem abriu e quem está/ficou responsável — crm_equipe, não usuarios.
  -- Nullable: token antigo do Admin (senha única) não carrega userId.
  criado_por     uuid references crm_equipe(id),
  atendido_por   uuid references crm_equipe(id),
  resolvido_em   timestamptz,
  resolucao_nota text
);

create index if not exists suporte_tickets_status_idx on suporte_tickets (status);
create index if not exists suporte_tickets_email_idx on suporte_tickets (lower(profissional_email));

alter table suporte_tickets enable row level security;

drop policy if exists "Negar acesso publico" on suporte_tickets;
create policy "Negar acesso publico" on suporte_tickets for all to anon, authenticated using (false);
