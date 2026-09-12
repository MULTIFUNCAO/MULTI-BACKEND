-- Rode este script no SQL Editor do painel do Supabase (Project > SQL Editor > New query).
-- Projeto "multifuncao", ref nlpfjkxqypveontunrxj.
--
-- Portfólio "antes/depois" no perfil do profissional — fase 1 do briefing de
-- 2026-09-11 (deliberadamente pequena: upload de par antes/depois + galeria
-- no perfil público + CTA pro fluxo de orçamento já existente; SEM curtida/
-- comentário/feed algorítmico/vídeo, ver App.jsx/AntesDepoisCard e
-- ProfissionalProfileScreen).
--
-- Tabela nova (portfolio_antes_depois) — não reaproveita nem a tabela de
-- pedidos/propostas nem a portfolio_fotos existente (que é foto avulsa, não
-- par). Reaproveita sim o bucket "portfolio-fotos" já criado e testado (ver
-- supabase_portfolio_fotos_migration.sql), só numa subpasta própria
-- ("antes-depois/"), então este script NÃO cria bucket nem policies de
-- storage novas — as de "portfolio-fotos" já cobrem qualquer path dentro
-- dele.
--
-- Este script é idempotente — seguro rodar mais de uma vez.
--
-- ⚠️ Projeto com histórico confirmado de DDL/RLS/dado revertendo sozinho
-- depois de confirmado (ver memória "Supabase multifuncao project", ticket
-- SU-456760 aberto). Depois de rodar, confira com os SELECTs no final —
-- e reconfira de novo daqui a ~1h antes de considerar definitivo.

create table if not exists portfolio_antes_depois (
  id                uuid primary key default gen_random_uuid(),
  profissional_id   text not null,  -- e-mail do profissional (mesmo padrão de
                                     -- portfolio_fotos.profissional_id — texto
                                     -- puro, sem auth.uid() real no frontend).
  foto_antes_url    text not null,
  foto_depois_url   text not null,
  descricao         text,
  categoria         text,           -- opcional: categoria de serviço que esse
                                     -- par ilustra (só relevante pra quem tem
                                     -- mais de uma), mesmo padrão de portfolio_fotos.
  ordem             integer not null default 0,
  created_at        timestamptz not null default now()
);

alter table portfolio_antes_depois add column if not exists profissional_id text;
alter table portfolio_antes_depois add column if not exists foto_antes_url text;
alter table portfolio_antes_depois add column if not exists foto_depois_url text;
alter table portfolio_antes_depois add column if not exists descricao text;
alter table portfolio_antes_depois add column if not exists categoria text;
alter table portfolio_antes_depois add column if not exists ordem integer not null default 0;
alter table portfolio_antes_depois add column if not exists created_at timestamptz not null default now();

-- Mesmo cuidado do script de portfolio_fotos: se por acaso já existir uma
-- tabela homônima de tentativa anterior não documentada com tipo errado,
-- força pra text/not null aqui (::text e defaults são seguros rodar de novo
-- mesmo se a coluna já estiver certa).
alter table portfolio_antes_depois alter column profissional_id type text using profissional_id::text;
alter table portfolio_antes_depois alter column ordem set default 0;
update portfolio_antes_depois set ordem = 0 where ordem is null;
alter table portfolio_antes_depois alter column ordem set not null;
alter table portfolio_antes_depois alter column created_at set default now();
update portfolio_antes_depois set created_at = now() where created_at is null;
alter table portfolio_antes_depois alter column created_at set not null;

create index if not exists idx_portfolio_antes_depois_profissional_id on portfolio_antes_depois (profissional_id);
create index if not exists idx_portfolio_antes_depois_profissional_ordem on portfolio_antes_depois (profissional_id, ordem);

-- RLS: mesmo padrão permissivo já documentado em portfolio_fotos/pedidos
-- (app usa só a chave anon, sem sessão real de auth — "dono do par" é
-- reforçado na UI, não no banco, igual toda outra tabela editável do app).
alter table portfolio_antes_depois enable row level security;

drop policy if exists "Leitura publica de portfolio_antes_depois" on portfolio_antes_depois;
create policy "Leitura publica de portfolio_antes_depois"
  on portfolio_antes_depois
  for select
  to anon, authenticated
  using (true);

drop policy if exists "Cadastro publico de portfolio_antes_depois" on portfolio_antes_depois;
create policy "Cadastro publico de portfolio_antes_depois"
  on portfolio_antes_depois
  for insert
  to anon, authenticated
  with check (true);

drop policy if exists "Edicao publica de portfolio_antes_depois" on portfolio_antes_depois;
create policy "Edicao publica de portfolio_antes_depois"
  on portfolio_antes_depois
  for update
  to anon, authenticated
  using (true)
  with check (true);

drop policy if exists "Exclusao publica de portfolio_antes_depois" on portfolio_antes_depois;
create policy "Exclusao publica de portfolio_antes_depois"
  on portfolio_antes_depois
  for delete
  to anon, authenticated
  using (true);

-- Confirmação — rode depois e confira o resultado (e reconfira de novo daqui
-- a ~1h, ver aviso no topo).
select column_name, data_type, is_nullable
from information_schema.columns
where table_name = 'portfolio_antes_depois'
order by ordinal_position;

select policyname, cmd, roles from pg_policies where tablename = 'portfolio_antes_depois';
