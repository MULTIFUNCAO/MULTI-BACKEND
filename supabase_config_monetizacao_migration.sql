-- Rode este script no SQL Editor do painel do Supabase (Project > SQL Editor > New query).
--
-- Correção do modelo financeiro real + Configurações de Monetização
-- (MULTI-CRM, ver memória do projeto). Tabela singleton (1 linha só, id
-- fixo em 1) com os valores hoje hardcoded em PLANOS_ASSINATURA.acesso —
-- o Thiago (perfil Administrador da crm_equipe) passa a poder mudar
-- valor/duração da promoção sem precisar mexer em código. Não afeta os
-- outros planos (autonomo/pro/premium/empresa*), só a Taxa de Acesso.
-- RLS com policy de negação explícita (mesmo padrão já usado nas outras
-- tabelas novas deste projeto — "enable row level security" sozinho, sem
-- policy, já se mostrou instável nesse Supabase, revertia sozinho).
-- Script idempotente — seguro rodar de novo.

create table if not exists config_monetizacao (
  id                      int primary key default 1,
  modelo_cobranca         text not null default 'mensalidade'
                            check (modelo_cobranca in ('mensalidade','comissao','mensalidade_comissao')),
  valor_entrada           numeric not null default 9.90,
  duracao_promocao_meses  int not null default 2,
  valor_pos_promocao      numeric not null default 29.90,
  comissao_ativa          boolean not null default false,
  comissao_percentual     numeric not null default 15,
  comissao_base           text not null default 'servico_fechado'
                            check (comissao_base in ('orcamento','servico_fechado','valor_recebido')),
  updated_at              timestamptz not null default now(),
  updated_by              uuid references crm_equipe(id),
  constraint config_monetizacao_singleton check (id = 1)
);

insert into config_monetizacao (id) values (1) on conflict (id) do nothing;

alter table config_monetizacao enable row level security;

drop policy if exists "Negar acesso publico" on config_monetizacao;
create policy "Negar acesso publico" on config_monetizacao for all to anon, authenticated using (false);
