-- Rode este script no SQL Editor do painel do Supabase (Project > SQL Editor > New query).
-- Projeto "multifuncao", ref nlpfjkxqypveontunrxj.
--
-- Portfólio de fotos estilo Instagram no perfil do profissional (grid 3
-- colunas na visão do cliente + tirinha de 3 fotos no card de candidato,
-- ver App.jsx/ProfissionalProfileScreen e CandidatoCard). Tabela nova
-- (portfolio_fotos) em vez de reaproveitar usuarios.portfolio (jsonb de
-- URLs cru, sem descrição/categoria/ordem, usado hoje só pela tela antiga
-- de edição de perfil) — esta é a fonte de verdade nova, o campo antigo
-- fica intocado (sem leitura nem escrita depois desta mudança).
--
-- Este script é idempotente — seguro rodar mais de uma vez.
--
-- ⚠️ Projeto com histórico confirmado de DDL/RLS/dado revertendo sozinho
-- depois de confirmado (ver memória "Supabase multifuncao project", ticket
-- SU-456760 aberto). Depois de rodar, confira com os SELECTs no final —
-- e reconfira de novo daqui a ~1h antes de considerar definitivo.

create table if not exists portfolio_fotos (
  id                uuid primary key default gen_random_uuid(),
  profissional_id   text not null,  -- e-mail do profissional (texto puro, mesmo
                                     -- padrão de cliente_id/profissional_aceito
                                     -- em "pedidos" — sem sessão real do Supabase
                                     -- Auth no frontend, então não é auth.uid()).
  foto_url          text not null,
  descricao         text,
  categoria         text,           -- opcional: qual categoria de serviço do
                                     -- profissional essa foto ilustra (só
                                     -- relevante pra quem tem mais de uma).
  ordem             integer not null default 0,
  created_at        timestamptz not null default now()
);

alter table portfolio_fotos add column if not exists profissional_id text;
alter table portfolio_fotos add column if not exists foto_url text;
alter table portfolio_fotos add column if not exists descricao text;
alter table portfolio_fotos add column if not exists categoria text;
alter table portfolio_fotos add column if not exists ordem integer not null default 0;
alter table portfolio_fotos add column if not exists created_at timestamptz not null default now();

-- Achado ao rodar pela 1ª vez (2026-09-09): já existia uma tabela
-- "portfolio_fotos" de alguma tentativa anterior não documentada, vazia (0
-- linhas, sem risco de perda de dado) mas com "profissional_id uuid" — o
-- "create table if not exists"/"add column if not exists" acima são no-op
-- numa tabela que já existe, então não corrigem tipo de coluna já criada
-- errada. E-mail não cabe em uuid, então força pra text aqui (::text é
-- seguro rodar de novo mesmo se a coluna já estiver certa). Idem pra
-- ordem/created_at ficarem realmente NOT NULL (também não pegava via "add
-- column if not exists" numa coluna já existente).
alter table portfolio_fotos alter column profissional_id type text using profissional_id::text;
alter table portfolio_fotos alter column ordem set default 0;
update portfolio_fotos set ordem = 0 where ordem is null;
alter table portfolio_fotos alter column ordem set not null;
alter table portfolio_fotos alter column created_at set default now();
update portfolio_fotos set created_at = now() where created_at is null;
alter table portfolio_fotos alter column created_at set not null;

create index if not exists idx_portfolio_fotos_profissional_id on portfolio_fotos (profissional_id);
create index if not exists idx_portfolio_fotos_profissional_ordem on portfolio_fotos (profissional_id, ordem);

-- RLS: mesmo padrão permissivo já documentado em supabase_pedidos_migration.sql
-- (app usa só a chave anon, sem sessão real de auth — "dono da foto" é
-- reforçado na UI, não no banco, igual toda outra tabela editável do app).
alter table portfolio_fotos enable row level security;

drop policy if exists "Leitura publica de portfolio_fotos" on portfolio_fotos;
create policy "Leitura publica de portfolio_fotos"
  on portfolio_fotos
  for select
  to anon, authenticated
  using (true);

drop policy if exists "Cadastro publico de portfolio_fotos" on portfolio_fotos;
create policy "Cadastro publico de portfolio_fotos"
  on portfolio_fotos
  for insert
  to anon, authenticated
  with check (true);

drop policy if exists "Edicao publica de portfolio_fotos" on portfolio_fotos;
create policy "Edicao publica de portfolio_fotos"
  on portfolio_fotos
  for update
  to anon, authenticated
  using (true)
  with check (true);

drop policy if exists "Exclusao publica de portfolio_fotos" on portfolio_fotos;
create policy "Exclusao publica de portfolio_fotos"
  on portfolio_fotos
  for delete
  to anon, authenticated
  using (true);

-- Bucket de Storage "portfolio-fotos" — público (mesmo padrão de
-- "pedidos-fotos", já usado em todo o app), separado por assunto em vez de
-- misturar com fotos de pedido/logo de empresa.
insert into storage.buckets (id, name, public)
values ('portfolio-fotos', 'portfolio-fotos', true)
on conflict (id) do update set public = true;

drop policy if exists "Leitura publica portfolio-fotos" on storage.objects;
create policy "Leitura publica portfolio-fotos"
  on storage.objects
  for select
  to anon, authenticated
  using (bucket_id = 'portfolio-fotos');

drop policy if exists "Upload publico portfolio-fotos" on storage.objects;
create policy "Upload publico portfolio-fotos"
  on storage.objects
  for insert
  to anon, authenticated
  with check (bucket_id = 'portfolio-fotos');

drop policy if exists "Edicao publica portfolio-fotos" on storage.objects;
create policy "Edicao publica portfolio-fotos"
  on storage.objects
  for update
  to anon, authenticated
  using (bucket_id = 'portfolio-fotos')
  with check (bucket_id = 'portfolio-fotos');

drop policy if exists "Exclusao publica portfolio-fotos" on storage.objects;
create policy "Exclusao publica portfolio-fotos"
  on storage.objects
  for delete
  to anon, authenticated
  using (bucket_id = 'portfolio-fotos');

-- Confirmação — rode depois e confira o resultado (e reconfira de novo daqui
-- a ~1h, ver aviso no topo).
select column_name, data_type, is_nullable
from information_schema.columns
where table_name = 'portfolio_fotos'
order by ordinal_position;

select policyname, cmd, roles from pg_policies where tablename = 'portfolio_fotos';

select id, name, public from storage.buckets where id = 'portfolio-fotos';

select policyname, cmd, roles from pg_policies
where tablename = 'objects' and schemaname = 'storage' and policyname ilike '%portfolio-fotos%';
