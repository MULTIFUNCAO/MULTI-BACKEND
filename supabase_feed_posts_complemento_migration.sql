-- Rode este script no SQL Editor do painel do Supabase (Project > SQL Editor > New query).
-- Projeto "multifuncao", ref nlpfjkxqypveontunrxj.
--
-- Complemento de supabase_feed_posts_migration.sql (já rodada e confirmada
-- via API em 2026-09-16: posts/post_curtidas/post_comentarios lendo OK,
-- sem PGRST205). Faltavam 2 coisas pra fechar o backend do feed antes do
-- frontend começar a consumir:
--   1. Bucket de Storage "posts-media" (a migration original só criou as
--      tabelas — comentário no topo dela dizia explicitamente que storage
--      ficava pra próxima etapa).
--   2. Colunas likes_count/comments_count em "posts", denormalizadas e
--      atualizadas pelo client (insert/delete em post_curtidas/
--      post_comentarios -> update do contador), sem trigger — mesma
--      decisão já tomada antes (ver plano salvo em
--      ~/.claude/plans/functional-sauteeing-raven.md, decisão técnica 4):
--      esse banco tem histórico de trigger causando bug difícil de achar
--      (trg_lock_approved, trg_limita_troca_categoria), e sem contador
--      denormalizado o feed precisaria de 1 query de count(*) por post só
--      pra renderizar a lista, o que não escala pra scroll.
--
-- Este script é idempotente — seguro rodar mais de uma vez.
--
-- ⚠️ Projeto com histórico confirmado de DDL/RLS/dado revertendo sozinho
-- depois de confirmado (ver memória "Supabase multifuncao project", ticket
-- SU-456760 aberto). Depois de rodar, confira com os SELECTs no final —
-- e reconfira de novo daqui a ~1h antes de considerar definitivo.

-- =====================================================================
-- Contadores denormalizados em posts
-- =====================================================================
alter table posts add column if not exists likes_count integer not null default 0;
alter table posts add column if not exists comments_count integer not null default 0;

alter table posts alter column likes_count set default 0;
update posts set likes_count = 0 where likes_count is null;
alter table posts alter column likes_count set not null;

alter table posts alter column comments_count set default 0;
update posts set comments_count = 0 where comments_count is null;
alter table posts alter column comments_count set not null;

-- Backfill a partir do dado real já existente (posts migrados da fase 1
-- não têm curtida/comentário ainda, mas isso deixa o contador correto caso
-- alguma linha de teste já tenha sido inserida em post_curtidas/
-- post_comentarios antes desta migration rodar).
update posts p
set likes_count = coalesce((select count(*) from post_curtidas c where c.post_id = p.id), 0);

update posts p
set comments_count = coalesce((select count(*) from post_comentarios co where co.post_id = p.id), 0);

-- =====================================================================
-- Bucket de Storage "posts-media" — público, mesmo padrão de
-- "portfolio-fotos"/"pedidos-fotos" já usados em todo o app. Separado de
-- "portfolio-fotos" porque inclui vídeo (a subpasta dedicada evita
-- confundir com a feature de grid de fotos).
-- =====================================================================
insert into storage.buckets (id, name, public)
values ('posts-media', 'posts-media', true)
on conflict (id) do update set public = true;

drop policy if exists "Leitura publica posts-media" on storage.objects;
create policy "Leitura publica posts-media"
  on storage.objects
  for select
  to anon, authenticated
  using (bucket_id = 'posts-media');

drop policy if exists "Upload publico posts-media" on storage.objects;
create policy "Upload publico posts-media"
  on storage.objects
  for insert
  to anon, authenticated
  with check (bucket_id = 'posts-media');

drop policy if exists "Edicao publica posts-media" on storage.objects;
create policy "Edicao publica posts-media"
  on storage.objects
  for update
  to anon, authenticated
  using (bucket_id = 'posts-media')
  with check (bucket_id = 'posts-media');

drop policy if exists "Exclusao publica posts-media" on storage.objects;
create policy "Exclusao publica posts-media"
  on storage.objects
  for delete
  to anon, authenticated
  using (bucket_id = 'posts-media');

-- Confirmação — rode depois e confira o resultado (e reconfira de novo daqui
-- a ~1h, ver aviso no topo).
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_name = 'posts' and column_name in ('likes_count', 'comments_count');

select id, name, public from storage.buckets where id = 'posts-media';

select policyname, cmd, roles from pg_policies
where tablename = 'objects' and schemaname = 'storage' and policyname ilike '%posts-media%';
