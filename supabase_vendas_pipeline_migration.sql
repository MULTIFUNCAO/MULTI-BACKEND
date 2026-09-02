-- Rode este script no SQL Editor do painel do Supabase (Project > SQL Editor > New query).
--
-- Handoff MULTI-CRM 2026-09-02, item 3 (Vendas). Pipeline dos profissionais
-- "em atendimento" — alguém da equipe (Thiago/Ana/etc) trabalhando
-- ativamente pra fechar aquele cadastro. Opt-in: NÃO auto-popula com todo
-- profissional pendente (isso já existe em "Dinheiro na Mesa"/oportunidades,
-- que é sobre volume, não sobre quem está sendo trabalhado individualmente)
-- — a equipe adiciona manualmente quem está de fato perseguindo.
--
-- Mesmo padrão de suporte_tickets: RLS com policy de negação explícita
-- (só o backend/service_role toca), script idempotente.

create table if not exists vendas_pipeline (
  id                  uuid primary key default gen_random_uuid(),
  created_at          timestamptz not null default now(),
  atualizado_em       timestamptz not null default now(),
  profissional_email  text not null,
  profissional_nome   text not null,
  estagio             text not null default 'contato_feito'
                        check (estagio in ('contato_feito','documentos_pendentes','pagamento_pendente','ativo')),
  -- Quem está atendendo esse lead — crm_equipe, não usuarios. Nullable: se
  -- ninguém foi atribuído ainda (adicionado ao funil sem dono definido).
  responsavel_id      uuid references crm_equipe(id),
  observacoes         text
);

create index if not exists vendas_pipeline_estagio_idx on vendas_pipeline (estagio);
create index if not exists vendas_pipeline_email_idx on vendas_pipeline (lower(profissional_email));

alter table vendas_pipeline enable row level security;

drop policy if exists "Negar acesso publico" on vendas_pipeline;
create policy "Negar acesso publico" on vendas_pipeline for all to anon, authenticated using (false);
