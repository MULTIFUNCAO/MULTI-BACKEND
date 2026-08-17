-- Rode este script no SQL Editor do painel do Supabase (Project > SQL Editor > New query).
--
-- Fase 2 da monetização por moedas: gasto de moeda ao responder uma
-- oportunidade (o que os comentários da Fase 1/da migration do motor de
-- precificação chamavam de "Fase 3" — nenhum lugar debitava nada até agora,
-- só existia saldo e compra). Profissional sem plano pago ativo que quer
-- responder um serviço paga custo_moedas daquele pedido (calculado pelo
-- trigger de supabase_motor_precificacao_migration.sql) em vez de assinar.
--
-- Mesmo padrão de creditar_moedas() (supabase_moedas_carteira_migration.sql):
-- security definer, só service_role pode chamar (nunca exposta direto pro
-- client via supabase.rpc — quem chama é sempre o backend, ver
-- POST /api/moedas/responder-oportunidade em server.js).
--
-- IMPORTANTE (bug conhecido deste projeto Supabase): DDL/UPDATE já reverteram
-- sozinhos depois de "confirmados". Rode o teste de sanidade no fim, espere
-- alguns minutos, e rode de novo (reler com a chave anon) antes de
-- considerar concluído.

-- ─── 1. Função que debita moeda (única forma de gasto por oportunidade) ───
-- Nunca recebe o custo do client — sempre lê pedidos.custo_moedas (gravado
-- pelo trigger trg_precificar_pedido), então não dá pra manipular quanto vai
-- ser cobrado mandando um valor diferente no payload do endpoint.
create or replace function debitar_moedas(
  p_email     text,
  p_pedido_id uuid
) returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_saldo        int;
  v_custo_moedas int;
begin
  select custo_moedas into v_custo_moedas from pedidos where id = p_pedido_id;
  if v_custo_moedas is null then
    raise exception 'pedido_sem_custo';
  end if;

  select saldo_moedas into v_saldo from usuarios where email = p_email for update;
  if not found then
    raise exception 'usuario_nao_encontrado';
  end if;

  -- Idempotência: mesmo profissional respondendo o mesmo pedido de novo
  -- (duplo clique, retry de rede) não cobra duas vezes — só devolve o saldo
  -- atual, sem debitar de novo.
  if exists (
    select 1 from moedas_transacoes
    where pedido_id = p_pedido_id and usuario_email = p_email and tipo = 'debito_oportunidade'
  ) then
    return v_saldo;
  end if;

  if v_saldo < v_custo_moedas then
    raise exception 'saldo_insuficiente';
  end if;

  v_saldo := v_saldo - v_custo_moedas;
  update usuarios set saldo_moedas = v_saldo where email = p_email;
  insert into moedas_transacoes (usuario_email, tipo, quantidade, saldo_apos, pedido_id, descricao)
  values (p_email, 'debito_oportunidade', -v_custo_moedas, v_saldo, p_pedido_id, 'Resposta a oportunidade sem plano ativo');

  return v_saldo;
end;
$$;

-- Só o backend (service_role) pode chamar — mesmo motivo de creditar_moedas:
-- sendo security definer, exposta pra anon/authenticated deixaria qualquer
-- client chamar supabase.rpc('debitar_moedas', ...) e decidir sozinho quando
-- se debitar (ou nunca), sem nunca de fato criar a candidatura depois.
revoke execute on function debitar_moedas(text, uuid) from public;
revoke execute on function debitar_moedas(text, uuid) from anon, authenticated;
grant execute on function debitar_moedas(text, uuid) to service_role;

-- ─── 2. Índice único — backstop de idempotência ───────────────────────────
-- Mesmo padrão do índice de payment_id em moedas_transacoes (Fase 1): o
-- check-then-insert dentro da função já é serializado pelo "for update" na
-- linha do usuário, isso aqui é só o backstop caso isso um dia não valer.
create unique index if not exists moedas_transacoes_debito_oportunidade_key
  on moedas_transacoes (pedido_id, usuario_email) where tipo = 'debito_oportunidade';

-- ─── Confirme que tudo existe ──────────────────────────────────────────────
select proname from pg_proc where proname = 'debitar_moedas';
select indexname from pg_indexes where indexname = 'moedas_transacoes_debito_oportunidade_key';

-- Teste de sanidade (manual, opcional) — contra um usuário e pedido de
-- teste reais (usuário com saldo_moedas conhecido, pedido com custo_moedas
-- conhecido):
-- select debitar_moedas('<email-de-teste>', '<pedido-id-de-teste>');
-- select saldo_moedas from usuarios where email = '<email-de-teste>'; -- deve ter caído exatamente custo_moedas
-- select debitar_moedas('<email-de-teste>', '<pedido-id-de-teste>'); -- chamar de novo
-- select saldo_moedas from usuarios where email = '<email-de-teste>'; -- não pode ter caído de novo (idempotência)
