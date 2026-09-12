-- Rode este script no SQL Editor do painel do Supabase (Project > SQL Editor > New query).
-- Projeto "multifuncao", ref nlpfjkxqypveontunrxj.
--
-- Feed visual completo (briefing v3, 2026-09-11/12) — backend apenas desta
-- rodada: schema genérico de post (tipo antes_depois/foto/video + array de
-- mídias), curtidas, comentários, e migração dos pares antes/depois da fase
-- 1 (tabela portfolio_antes_depois) pro novo modelo. Feed/engajamento/CTA/
-- sidebar (mapa + ranking) e o cutover do frontend ficam pra próxima etapa —
-- ver briefing completo.
--
-- Este script é idempotente — seguro rodar mais de uma vez.
--
-- ⚠️ Projeto com histórico confirmado de DDL/RLS/dado revertendo sozinho
-- depois de confirmado (ver memória "Supabase multifuncao project", ticket
-- SU-456760 aberto). Depois de rodar, confira com os SELECTs no final —
-- e reconfira de novo daqui a ~1h antes de considerar definitivo.

-- =====================================================================
-- posts — substitui o modelo fixo antes/depois por um genérico. Cada post
-- tem um "tipo" e um array "midias" (jsonb) com o formato:
--   antes_depois: [{"papel":"antes","url":"..."}, {"papel":"depois","url":"..."}]
--   foto (única ou carrossel): [{"url":"..."}, {"url":"..."}, ...]
--   video: [{"url":"..."}]
-- "papel" só existe pra antes/depois — nos outros tipos cada item do array
-- é só {"url":...}, sem papel definido.
-- =====================================================================
create table if not exists posts (
  id                uuid primary key default gen_random_uuid(),
  profissional_id   text not null,  -- e-mail do profissional, mesmo padrão de
                                     -- portfolio_fotos/portfolio_antes_depois
                                     -- (sem auth.uid() real no frontend).
  tipo              text not null,
  midias            jsonb not null default '[]'::jsonb,
  descricao         text,
  categoria         text,
  ordem             integer not null default 0,
  created_at        timestamptz not null default now()
);

alter table posts add column if not exists profissional_id text;
alter table posts add column if not exists tipo text;
alter table posts add column if not exists midias jsonb not null default '[]'::jsonb;
alter table posts add column if not exists descricao text;
alter table posts add column if not exists categoria text;
alter table posts add column if not exists ordem integer not null default 0;
alter table posts add column if not exists created_at timestamptz not null default now();

-- Mesmo cuidado das migrations anteriores: força tipo/default/not null mesmo
-- se a coluna já existir de uma rodada anterior deste mesmo script.
alter table posts alter column profissional_id type text using profissional_id::text;
alter table posts alter column ordem set default 0;
update posts set ordem = 0 where ordem is null;
alter table posts alter column ordem set not null;
alter table posts alter column midias set default '[]'::jsonb;
update posts set midias = '[]'::jsonb where midias is null;
alter table posts alter column midias set not null;
alter table posts alter column created_at set default now();
update posts set created_at = now() where created_at is null;
alter table posts alter column created_at set not null;

do $$ begin
  alter table posts add constraint posts_tipo_check check (tipo in ('antes_depois', 'foto', 'video'));
exception when duplicate_object then null;
end $$;

create index if not exists idx_posts_profissional_id on posts (profissional_id);
create index if not exists idx_posts_profissional_ordem on posts (profissional_id, ordem);
-- Feed cronológico (sem ranking/algoritmo nesta fase) — ordena tudo por
-- created_at desc direto.
create index if not exists idx_posts_created_at on posts (created_at desc);

alter table posts enable row level security;

drop policy if exists "Leitura publica de posts" on posts;
create policy "Leitura publica de posts"
  on posts
  for select
  to anon, authenticated
  using (true);

drop policy if exists "Cadastro publico de posts" on posts;
create policy "Cadastro publico de posts"
  on posts
  for insert
  to anon, authenticated
  with check (true);

drop policy if exists "Edicao publica de posts" on posts;
create policy "Edicao publica de posts"
  on posts
  for update
  to anon, authenticated
  using (true)
  with check (true);

drop policy if exists "Exclusao publica de posts" on posts;
create policy "Exclusao publica de posts"
  on posts
  for delete
  to anon, authenticated
  using (true);

-- =====================================================================
-- post_curtidas — 1 linha por (post, usuário) que curtiu. Unique evita
-- curtida duplicada; contagem de curtidas de um post é count(*) por post_id.
-- =====================================================================
create table if not exists post_curtidas (
  id           uuid primary key default gen_random_uuid(),
  post_id      uuid not null references posts(id) on delete cascade,
  usuario_id   text not null,  -- e-mail de quem curtiu (cliente ou profissional)
  created_at   timestamptz not null default now()
);

alter table post_curtidas add column if not exists post_id uuid;
alter table post_curtidas add column if not exists usuario_id text;
alter table post_curtidas add column if not exists created_at timestamptz not null default now();

alter table post_curtidas alter column created_at set default now();
update post_curtidas set created_at = now() where created_at is null;
alter table post_curtidas alter column created_at set not null;

do $$ begin
  alter table post_curtidas add constraint post_curtidas_post_id_fkey
    foreign key (post_id) references posts(id) on delete cascade;
exception when duplicate_object then null;
end $$;

create unique index if not exists idx_post_curtidas_post_usuario on post_curtidas (post_id, usuario_id);
create index if not exists idx_post_curtidas_post_id on post_curtidas (post_id);

alter table post_curtidas enable row level security;

drop policy if exists "Leitura publica de post_curtidas" on post_curtidas;
create policy "Leitura publica de post_curtidas"
  on post_curtidas
  for select
  to anon, authenticated
  using (true);

drop policy if exists "Cadastro publico de post_curtidas" on post_curtidas;
create policy "Cadastro publico de post_curtidas"
  on post_curtidas
  for insert
  to anon, authenticated
  with check (true);

drop policy if exists "Exclusao publica de post_curtidas" on post_curtidas;
create policy "Exclusao publica de post_curtidas"
  on post_curtidas
  for delete
  to anon, authenticated
  using (true);

-- =====================================================================
-- post_comentarios — "usuario_nome" é denormalizado (nome de exibição no
-- momento do comentário) pra não depender de join com usuarios/auth pra
-- renderizar o feed — mesmo espírito das outras tabelas do app, que não
-- assumem sessão real de Supabase Auth no frontend.
-- =====================================================================
create table if not exists post_comentarios (
  id             uuid primary key default gen_random_uuid(),
  post_id        uuid not null references posts(id) on delete cascade,
  usuario_id     text not null,  -- e-mail de quem comentou
  usuario_nome   text,
  texto          text not null,
  created_at     timestamptz not null default now()
);

alter table post_comentarios add column if not exists post_id uuid;
alter table post_comentarios add column if not exists usuario_id text;
alter table post_comentarios add column if not exists usuario_nome text;
alter table post_comentarios add column if not exists texto text;
alter table post_comentarios add column if not exists created_at timestamptz not null default now();

alter table post_comentarios alter column created_at set default now();
update post_comentarios set created_at = now() where created_at is null;
alter table post_comentarios alter column created_at set not null;

do $$ begin
  alter table post_comentarios add constraint post_comentarios_post_id_fkey
    foreign key (post_id) references posts(id) on delete cascade;
exception when duplicate_object then null;
end $$;

create index if not exists idx_post_comentarios_post_id on post_comentarios (post_id, created_at);

alter table post_comentarios enable row level security;

drop policy if exists "Leitura publica de post_comentarios" on post_comentarios;
create policy "Leitura publica de post_comentarios"
  on post_comentarios
  for select
  to anon, authenticated
  using (true);

drop policy if exists "Cadastro publico de post_comentarios" on post_comentarios;
create policy "Cadastro publico de post_comentarios"
  on post_comentarios
  for insert
  to anon, authenticated
  with check (true);

drop policy if exists "Exclusao publica de post_comentarios" on post_comentarios;
create policy "Exclusao publica de post_comentarios"
  on post_comentarios
  for delete
  to anon, authenticated
  using (true);

-- =====================================================================
-- Migração dos pares antes/depois da fase 1 (portfolio_antes_depois) pro
-- modelo genérico de post (tipo='antes_depois'). Preserva o mesmo "id" da
-- linha de origem pra manter referência estável entre as duas tabelas.
--
-- IMPORTANTE: isto é uma CÓPIA, não um cutover — portfolio_antes_depois
-- NÃO é dropada nem alterada aqui. A fase 1 já está no ar (App.jsx lê e
-- escreve nela via fetchPortfolioAntesDepois/uploadAntesDepoisPar) e
-- continua funcionando normalmente até o frontend migrar pra ler/escrever
-- em "posts" — decisão e trabalho de outra etapa. Enquanto isso não
-- acontecer, um par novo cadastrado pela tela atual só entra em "posts" se
-- este INSERT for rodado de novo (idempotente via "on conflict do nothing"
-- no id, então rodar de novo não duplica os que já foram copiados).
-- =====================================================================
insert into posts (id, profissional_id, tipo, midias, descricao, categoria, ordem, created_at)
select
  id,
  profissional_id,
  'antes_depois',
  jsonb_build_array(
    jsonb_build_object('papel', 'antes', 'url', foto_antes_url),
    jsonb_build_object('papel', 'depois', 'url', foto_depois_url)
  ),
  descricao,
  categoria,
  ordem,
  created_at
from portfolio_antes_depois
on conflict (id) do nothing;

-- Confirmação — rode depois e confira o resultado (e reconfira de novo daqui
-- a ~1h, ver aviso no topo).
select column_name, data_type, is_nullable
from information_schema.columns
where table_name in ('posts', 'post_curtidas', 'post_comentarios')
order by table_name, ordinal_position;

select policyname, cmd, roles from pg_policies
where tablename in ('posts', 'post_curtidas', 'post_comentarios');

select conname from pg_constraint where conname = 'posts_tipo_check';

-- Confere que a migração copiou 1:1 (as duas contagens devem bater).
select
  (select count(*) from portfolio_antes_depois) as total_antes_depois_origem,
  (select count(*) from posts where tipo = 'antes_depois') as total_posts_antes_depois;

select id, profissional_id, tipo, midias, categoria, ordem, created_at
from posts
order by created_at desc
limit 20;
