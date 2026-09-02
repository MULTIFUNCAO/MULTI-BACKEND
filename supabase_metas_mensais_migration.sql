-- Rode este script no SQL Editor do painel do Supabase (Project > SQL Editor > New query).
--
-- Handoff MULTI-CRM 2026-09-02, item 5 (Metas e Desempenho).
--
-- 1) Metas mensais — singleton (1 linha só, editável), mesmo padrão de
-- "config_monetizacao": não existe histórico de meta por mês ainda (V1
-- simples), o admin edita os 3 números sempre que quiser definir a meta do
-- mês corrente. "Realizado" é sempre calculado contra o mês corrente na
-- hora da consulta, nunca guardado aqui.
create table if not exists metas_mensais (
  id                          int primary key default 1,
  meta_profissionais_aprovados int not null default 0,
  meta_mensalidades_pagas      int not null default 0,
  meta_clientes_ativos         int not null default 0,
  updated_at                  timestamptz not null default now(),
  updated_by                  uuid references crm_equipe(id),
  constraint metas_mensais_singleton check (id = 1)
);
insert into metas_mensais (id) values (1) on conflict (id) do nothing;

alter table metas_mensais enable row level security;
drop policy if exists "Negar acesso publico" on metas_mensais;
create policy "Negar acesso publico" on metas_mensais for all to anon, authenticated using (false);

-- 2) vendas_pipeline ganha "ativo_em" — timestamp específico de quando
-- entrou no estágio 'ativo' (diferente de atualizado_em, que muda em
-- qualquer edição), pra dar pra medir tempo médio de fechamento de
-- verdade. Nullable: só é setado quando de fato vira 'ativo'; leads já
-- existentes antes desta migration ficam sem esse dado (não retroage,
-- honesto sobre isso).
alter table vendas_pipeline add column if not exists ativo_em timestamptz;
