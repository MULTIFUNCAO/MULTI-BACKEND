-- HANDOFF 2026-09-03: remove a trava de troca de categoria de serviço.
-- Regra antiga: 2 trocas na vida da conta, só quando a assinatura renova ou
-- o plano muda — gateada pelo trigger trg_limita_troca_categoria em
-- usuarios (criado direto no SQL Editor em algum momento anterior, nunca
-- ficou registrado em migration nenhuma deste repo — não existe CREATE
-- TRIGGER trg_limita_troca_categoria em nenhum arquivo supabase_*.sql local,
-- só o nome dele em comentários no App.jsx). Regra nova: profissional pode
-- editar a categoria de serviço a qualquer momento, sem limite de trocas e
-- sem depender de ciclo/renovação. Ver App.jsx (categoriaElegivel = true) e
-- MULTI-BACKEND/server.js (endpoint /api/pedidos/confirmar-servico não
-- dependia dessa trigger, então não precisa de mudança lá pra este item).
--
-- Rode isto no SQL Editor do Supabase (projeto multifuncao,
-- nlpfjkxqypveontunrxj) — e RE-VERIFIQUE depois (SELECT no fim), esse
-- projeto tem um bug de durabilidade recorrente em DDL/trigger que já fez
-- "sucesso" aparente não persistir antes.

drop trigger if exists trg_limita_troca_categoria on usuarios;

-- Não sabemos o nome exato da função associada (não documentada em
-- nenhuma migration local) — dropar só o trigger é suficiente pra remover
-- o bloqueio; a função, se existir separada, fica órfã e inofensiva.
-- Se quiser limpar de vez, ache o nome com a query abaixo (comentada) e
-- dropdrop manualmente depois de confirmar que não é usada em mais nada:
-- select tgname, pg_get_triggerdef(oid) from pg_trigger where tgrelid = 'usuarios'::regclass and not tgisinternal;

-- Verificação: não deve sobrar nenhum trigger com esse nome em "usuarios".
select tgname
from pg_trigger
where tgrelid = 'usuarios'::regclass
  and tgname = 'trg_limita_troca_categoria';
-- ↑ Esperado: 0 linhas. Se voltar 1 linha depois de rodar o DROP, é o bug
-- de durabilidade de novo — rode o DROP TRIGGER de novo e reconfira.
