-- Rode este script no SQL Editor do painel do Supabase (Project > SQL Editor > New query).
-- Projeto "multifuncao", ref nlpfjkxqypveontunrxj.
--
-- SUBSTITUI supabase_feed_posts_migration.sql + supabase_feed_posts_complemento_migration.sql.
-- Achado 2026-09-16: "posts"/"post_curtidas"/"post_comentarios" JÁ EXISTIAM
-- no banco antes dessas duas migrations rodarem — uma tabela alheia, não
-- documentada, com schema bem diferente (usuario_id uuid, não e-mail em
-- texto como todo o resto do app; colunas "midia"/"legenda"/
-- "categoria_servico" em vez de "midias"/"descricao"/"categoria"). O
-- "create table if not exists" das migrations antigas foi no-op contra essa
-- tabela alheia, e as colunas novas que elas tentavam adicionar
-- (categoria/descricao/midias/ordem/profissional_id) nunca persistiram —
-- só likes_count/comments_count pegaram (bug de durabilidade + colisão de
-- nome, achado junto). Decisão: não mexer na tabela alheia (schema/origem
-- desconhecidos, pode ser de outra feature) — cria tabelas NOVAS com nome
-- próprio (feed_posts/feed_curtidas/feed_comentarios), mesmo padrão de
-- e-mail-como-texto usado em portfolio_fotos/pedidos/etc.
--
-- Bucket "posts-media" já foi criado e confirmado funcionando (upload/
-- delete via anon key testados ao vivo) — sem colisão de nome (Storage é
-- namespace separado das tabelas), mantido como está, só reafirmado aqui
-- de forma idempotente.
--
-- Este script é idempotente — seguro rodar mais de uma vez.
--
-- ⚠️ Projeto com histórico confirmado de DDL/RLS/dado revertendo sozinho
-- depois de confirmado (ver memória "Supabase multifuncao project", ticket
-- SU-456760 aberto). Depois de rodar, confira com os SELECTs no final —
-- e reconfira de novo daqui a ~1h antes de considerar definitivo.

-- =====================================================================
-- feed_posts — cada post tem "tipo" (antes_depois/foto/video) e "midias"
-- jsonb: antes_depois é [{"papel":"antes","url":"..."},{"papel":"depois","url":"..."}],
-- foto/video é [{"url":"..."}, ...] (sem "papel").
-- =====================================================================
create table if not exists feed_posts (
  id                uuid primary key default gen_random_uuid(),
  profissional_id   text not null,  -- e-mail do profissional, mesmo padrão de
                                     -- portfolio_fotos/pedidos (sem sessão real
                                     -- de Supabase Auth no frontend).
  tipo              text not null,
  midias            jsonb not null default '[]'::jsonb,
  descricao         text,
  categoria         text,
  ordem             integer not null default 0,
  likes_count       integer not null default 0,
  comments_count    integer not null default 0,
  created_at        timestamptz not null default now()
);

do $$ begin
  alter table feed_posts add constraint feed_posts_tipo_check check (tipo in ('antes_depois', 'foto', 'video'));
exception when duplicate_object then null;
end $$;

create index if not exists idx_feed_posts_profissional_id on feed_posts (profissional_id);
create index if not exists idx_feed_posts_profissional_ordem on feed_posts (profissional_id, ordem);
create index if not exists idx_feed_posts_created_at on feed_posts (created_at desc);

alter table feed_posts enable row level security;

drop policy if exists "Leitura publica de feed_posts" on feed_posts;
create policy "Leitura publica de feed_posts" on feed_posts for select to anon, authenticated using (true);

drop policy if exists "Cadastro publico de feed_posts" on feed_posts;
create policy "Cadastro publico de feed_posts" on feed_posts for insert to anon, authenticated with check (true);

drop policy if exists "Edicao publica de feed_posts" on feed_posts;
create policy "Edicao publica de feed_posts" on feed_posts for update to anon, authenticated using (true) with check (true);

drop policy if exists "Exclusao publica de feed_posts" on feed_posts;
create policy "Exclusao publica de feed_posts" on feed_posts for delete to anon, authenticated using (true);

-- =====================================================================
-- feed_curtidas — 1 linha por (post, usuário) que curtiu.
-- =====================================================================
create table if not exists feed_curtidas (
  id           uuid primary key default gen_random_uuid(),
  post_id      uuid not null references feed_posts(id) on delete cascade,
  usuario_id   text not null,  -- e-mail de quem curtiu
  created_at   timestamptz not null default now()
);

create unique index if not exists idx_feed_curtidas_post_usuario on feed_curtidas (post_id, usuario_id);
create index if not exists idx_feed_curtidas_post_id on feed_curtidas (post_id);

alter table feed_curtidas enable row level security;

drop policy if exists "Leitura publica de feed_curtidas" on feed_curtidas;
create policy "Leitura publica de feed_curtidas" on feed_curtidas for select to anon, authenticated using (true);

drop policy if exists "Cadastro publico de feed_curtidas" on feed_curtidas;
create policy "Cadastro publico de feed_curtidas" on feed_curtidas for insert to anon, authenticated with check (true);

drop policy if exists "Exclusao publica de feed_curtidas" on feed_curtidas;
create policy "Exclusao publica de feed_curtidas" on feed_curtidas for delete to anon, authenticated using (true);

-- =====================================================================
-- feed_comentarios — "usuario_nome" denormalizado (nome no momento do
-- comentário), mesmo espírito das outras tabelas do app.
-- =====================================================================
create table if not exists feed_comentarios (
  id             uuid primary key default gen_random_uuid(),
  post_id        uuid not null references feed_posts(id) on delete cascade,
  usuario_id     text not null,  -- e-mail de quem comentou
  usuario_nome   text,
  texto          text not null,
  created_at     timestamptz not null default now()
);

create index if not exists idx_feed_comentarios_post_id on feed_comentarios (post_id, created_at);

alter table feed_comentarios enable row level security;

drop policy if exists "Leitura publica de feed_comentarios" on feed_comentarios;
create policy "Leitura publica de feed_comentarios" on feed_comentarios for select to anon, authenticated using (true);

drop policy if exists "Cadastro publico de feed_comentarios" on feed_comentarios;
create policy "Cadastro publico de feed_comentarios" on feed_comentarios for insert to anon, authenticated with check (true);

drop policy if exists "Exclusao publica de feed_comentarios" on feed_comentarios;
create policy "Exclusao publica de feed_comentarios" on feed_comentarios for delete to anon, authenticated using (true);

-- =====================================================================
-- Bucket "posts-media" — já criado e testado (upload/delete via anon key
-- confirmados ao vivo em 2026-09-16). Reafirmado aqui de forma idempotente
-- só por completude do script.
-- =====================================================================
insert into storage.buckets (id, name, public)
values ('posts-media', 'posts-media', true)
on conflict (id) do update set public = true;

drop policy if exists "Leitura publica posts-media" on storage.objects;
create policy "Leitura publica posts-media" on storage.objects for select to anon, authenticated using (bucket_id = 'posts-media');

drop policy if exists "Upload publico posts-media" on storage.objects;
create policy "Upload publico posts-media" on storage.objects for insert to anon, authenticated with check (bucket_id = 'posts-media');

drop policy if exists "Edicao publica posts-media" on storage.objects;
create policy "Edicao publica posts-media" on storage.objects for update to anon, authenticated using (bucket_id = 'posts-media') with check (bucket_id = 'posts-media');

drop policy if exists "Exclusao publica posts-media" on storage.objects;
create policy "Exclusao publica posts-media" on storage.objects for delete to anon, authenticated using (bucket_id = 'posts-media');

-- Confirmação — rode depois e confira o resultado (e reconfira de novo daqui
-- a ~1h, ver aviso no topo).
select table_name, column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_name in ('feed_posts', 'feed_curtidas', 'feed_comentarios')
order by table_name, ordinal_position;

select tablename, policyname, cmd, roles from pg_policies
where tablename in ('feed_posts', 'feed_curtidas', 'feed_comentarios');

select conname from pg_constraint where conname = 'feed_posts_tipo_check';

select id, name, public from storage.buckets where id = 'posts-media';
