-- Rode este script no SQL Editor do painel do Supabase (Project > SQL Editor > New query).
--
-- Fase 2 da monetização por moedas: motor de precificação automática.
-- Calcula sozinho, no momento da criação do pedido, uma faixa de valor
-- estimado (R$) e o custo em moedas da oportunidade — o cliente não define
-- isso (spec seção 5). O cálculo roda num trigger BEFORE INSERT (não num
-- endpoint de backend) porque o insert de "pedidos" hoje é direto do client
-- (RLS permissiva, with check(true)) — um trigger sobrescreve os campos
-- calculados incondicionalmente, então não importa o que o client mande no
-- payload. Mesmo padrão já usado no projeto pra travar campos sensíveis sem
-- mudar o call site do insert (trg_lock_aceite_formal_profissional,
-- usuarios_lock_saldo_moedas da Fase 1).
--
-- Aditivo: não mexe na etapa de "Valor do serviço" que já existe no Novo
-- Pedido (negociação de R$ direto com o profissional via
-- chat_propostas_valor) — isso é ortogonal ao custo em moeda (taxa de
-- acesso à oportunidade).
--
-- IMPORTANTE (bug conhecido deste projeto Supabase): DDL/UPDATE já reverteram
-- sozinhos depois de "confirmados". Rode o teste de sanidade no fim e
-- reconfira via chave anon antes de considerar concluído.
--
-- ─── EXTENSÃO (mesmo dia): campo guiado por categoria, piloto Montador ────
-- Categoria → nível fixo (seção 2 abaixo) é um chute de negócio, não uma
-- leitura do pedido em si — spec pede um sinal melhor que isso pra
-- categorias onde a variação de escopo é grande e mensurável por um campo
-- guiado (não confiar só na descrição livre). Piloto: Montador de Móveis
-- (quantidade de portas/módulos). Regra de segurança: sem o campo guiado
-- preenchido, assume o nível MAIS ALTO, nunca o mais baixo — pior o
-- profissional receber pouco por um serviço grande do que "economizar
-- moeda" errando pra baixo. Ver seção 4 (trigger) e a coluna
-- pedidos.escopo_montador (seção 3) pra a implementação. Restrito a
-- montador_de_moveis por enquanto — aplicar essa regra de segurança a
-- categorias sem nenhum campo guiado ainda deixaria toda a base sempre no
-- nível mais caro, o que não foi pedido.

-- ─── 1. Tabela de níveis de complexidade (config admin-editável) ─────────
-- A "tabela inicial de moedas" da seção 6 da spec.
create table if not exists moedas_niveis_complexidade (
  nivel        text primary key check (nivel in ('muito_simples','simples','medio','complexo','muito_complexo')),
  custo_moedas integer not null check (custo_moedas > 0),
  valor_min    numeric not null check (valor_min >= 0),
  valor_max    numeric not null check (valor_max >= valor_min)
);

insert into moedas_niveis_complexidade (nivel, custo_moedas, valor_min, valor_max)
select v.nivel, v.custo_moedas, v.valor_min, v.valor_max
from (values
  ('muito_simples', 2, 50,  120),
  ('simples',       3, 100, 250),
  ('medio',         4, 150, 400),
  ('complexo',      6, 350, 800),
  ('muito_complexo',8, 700, 1800)
) as v(nivel, custo_moedas, valor_min, valor_max)
where not exists (select 1 from moedas_niveis_complexidade);

alter table moedas_niveis_complexidade enable row level security;

drop policy if exists "Leitura publica de niveis de complexidade" on moedas_niveis_complexidade;
create policy "Leitura publica de niveis de complexidade"
  on moedas_niveis_complexidade
  for select
  to anon, authenticated
  using (true);

-- ─── 2. Categoria -> nível (config admin-editável) ────────────────────────
-- Todas as categorias nascem em 'medio' — a spec é explícita que isso é pra
-- o admin ajustar com o tempo, não pra chutar complexidade por profissão
-- sem dado de negócio real (seção 6: "NÃO FIXAR definitivamente 4 moedas
-- pra todos os guarda-roupas").
create table if not exists moedas_categorias_nivel (
  categoria text primary key,
  nivel     text not null default 'medio' references moedas_niveis_complexidade(nivel)
);

insert into moedas_categorias_nivel (categoria)
select c.categoria
from (values
  ('adestrador'),
  ('ajudante_de_mudanca'),
  ('ajudante_de_pedreiro'),
  ('animador'),
  ('arquiteto'),
  ('artesao'),
  ('banhista'),
  ('barbeiro'),
  ('barman'),
  ('borracheiro'),
  ('cabeleireiro'),
  ('calheiro'),
  ('carpinteiro'),
  ('carregador'),
  ('cerimonialista'),
  ('chaveiro'),
  ('chef_particular'),
  ('churrasqueiro'),
  ('cinegrafista'),
  ('confeiteiro'),
  ('consultor_de_seguranca_do_trabalho'),
  ('controlador_de_acesso'),
  ('controlador_de_pragas'),
  ('copywriter'),
  ('cortador_de_grama'),
  ('cozinheiro'),
  ('criador_de_conteudo'),
  ('cuidador_de_pets'),
  ('customizador'),
  ('decorador'),
  ('depilador'),
  ('desentupidor'),
  ('desenvolvedor'),
  ('designer_de_sobrancelhas'),
  ('designer_grafico'),
  ('diarista'),
  ('dj'),
  ('dog_walker'),
  ('editor_de_fotos'),
  ('editor_de_video'),
  ('eletricista'),
  ('eletricista_automotivo'),
  ('eletricista_industrial'),
  ('encanador'),
  ('engenheiro'),
  ('engenheiro_de_seguranca_do_trabalho'),
  ('entregador'),
  ('esteticista'),
  ('esteticista_automotivo'),
  ('estofador'),
  ('fotografo'),
  ('fotografo_de_produtos'),
  ('freteiro'),
  ('funileiro'),
  ('garcom'),
  ('gesseiro'),
  ('gestor_de_trafego'),
  ('guincheiro'),
  ('hidrojatista'),
  ('higienizador_automotivo'),
  ('higienizador_de_estofados'),
  ('impermeabilizador'),
  ('instalador'),
  ('instalador_de_acessorios_automotivos'),
  ('instalador_de_carregador_para_veiculos_eletricos'),
  ('instalador_de_cortinas_e_persianas'),
  ('instalador_de_drywall'),
  ('instalador_de_energia_solar'),
  ('instalador_de_irrigacao'),
  ('instalador_de_pisos'),
  ('instalador_de_prateleiras_e_suportes'),
  ('instalador_de_redes_de_protecao'),
  ('instalador_de_tv'),
  ('instalador_de_varais'),
  ('instrutor'),
  ('jardineiro'),
  ('lash_designer'),
  ('lavador_automotivo'),
  ('limpador_de_caixa_d_agua'),
  ('limpador_de_fachadas'),
  ('limpador_de_vidros'),
  ('manicure'),
  ('maquiador'),
  ('marceneiro'),
  ('marido_de_aluguel'),
  ('marmorista'),
  ('martelinho_de_ouro'),
  ('massoterapeuta'),
  ('mecanico'),
  ('mecanico_de_motos'),
  ('mestre_de_obras'),
  ('micropigmentador'),
  ('montador_de_eventos'),
  ('montador_de_moveis'),
  ('motoboy'),
  ('motorista_de_mudanca'),
  ('motorista_particular'),
  ('nail_designer'),
  ('padeiro'),
  ('paisagista'),
  ('pedicure'),
  ('pedreiro'),
  ('penteadista'),
  ('personal_organizer'),
  ('pet_sitter'),
  ('pet_taxi'),
  ('pintor'),
  ('pintor_automotivo'),
  ('piscineiro'),
  ('podador'),
  ('polidor'),
  ('porteiro'),
  ('professor_de_idiomas'),
  ('professor_de_informatica'),
  ('professor_de_musica'),
  ('professor_de_reforco_escolar'),
  ('professor_particular'),
  ('profissional_de_limpeza_comercial'),
  ('profissional_de_limpeza_pos_obra'),
  ('projetista'),
  ('projetista_de_moveis'),
  ('recepcionista_de_eventos'),
  ('recreador'),
  ('restaurador'),
  ('restaurador_de_moveis'),
  ('rocador'),
  ('salgadeiro'),
  ('sapateiro'),
  ('seguranca'),
  ('seguranca_de_eventos'),
  ('serralheiro'),
  ('social_media'),
  ('soldador'),
  ('sushiman'),
  ('tapeceiro'),
  ('tecnico_de_ar_condicionado'),
  ('tecnico_de_bombas'),
  ('tecnico_de_caca_vazamento'),
  ('tecnico_de_celulares'),
  ('tecnico_de_eletrodomesticos'),
  ('tecnico_de_eletronicos'),
  ('tecnico_de_informatica'),
  ('tecnico_de_refrigeracao'),
  ('tecnico_de_seguranca_eletronica'),
  ('tecnico_em_automacao'),
  ('tecnico_em_edificacoes'),
  ('tecnico_em_seguranca_do_trabalho'),
  ('telhadista'),
  ('topografo'),
  ('tosador'),
  ('trancista'),
  ('transportador'),
  ('tutor'),
  ('videomaker'),
  ('vidraceiro'),
  ('vigilante'),
  ('web_designer')
) as c(categoria)
on conflict (categoria) do nothing;

alter table moedas_categorias_nivel enable row level security;

drop policy if exists "Leitura publica de categoria nivel" on moedas_categorias_nivel;
create policy "Leitura publica de categoria nivel"
  on moedas_categorias_nivel
  for select
  to anon, authenticated
  using (true);

-- ─── 3. Colunas novas em pedidos ──────────────────────────────────────────
alter table pedidos add column if not exists custo_moedas integer;
alter table pedidos add column if not exists valor_estimado_min numeric;
alter table pedidos add column if not exists valor_estimado_max numeric;

-- Campo guiado do piloto Montador — preenchido no Novo Pedido só quando
-- categoria = 'montador_de_moveis' (ver App.jsx). Nullable de propósito:
-- ausência dele é o sinal que aciona a regra de segurança no trigger abaixo.
alter table pedidos add column if not exists escopo_montador text
  check (escopo_montador in ('peca_pequena','ate_2_portas','3_a_4_portas','mais_de_4_portas'));

-- ─── 4. Trigger que calcula tudo no insert ────────────────────────────────
-- Sobrescreve os 3 campos incondicionalmente — não importa o que o client
-- mande no payload do insert, o valor final é sempre o calculado aqui.
create or replace function pedidos_precificar()
returns trigger as $$
declare
  v_nivel        text;
  v_custo_moedas int;
  v_valor_min    numeric;
  v_valor_max    numeric;
begin
  -- Piloto Montador: campo guiado manda mais que o chute fixo de categoria.
  -- Sem o campo preenchido (descrição vaga, cliente pulou o campo) cai no
  -- nível mais alto de propósito — regra de segurança da seção 5 do pedido,
  -- nunca assume o nível mais barato por falta de informação.
  if new.categoria = 'montador_de_moveis' then
    v_nivel := case new.escopo_montador
      when 'peca_pequena'    then 'muito_simples'
      when 'ate_2_portas'    then 'medio'
      when '3_a_4_portas'    then 'complexo'
      when 'mais_de_4_portas' then 'muito_complexo'
      else 'muito_complexo' -- vazio/nulo = assume o mais caro, nunca o mais barato
    end;
  else
    select nivel into v_nivel from moedas_categorias_nivel where categoria = new.categoria;
    if v_nivel is null then
      v_nivel := 'medio';
    end if;
  end if;

  select custo_moedas, valor_min, valor_max
  into v_custo_moedas, v_valor_min, v_valor_max
  from moedas_niveis_complexidade
  where nivel = v_nivel;

  -- Fallback duro se as tabelas de config estiverem vazias/indisponíveis —
  -- nunca deixa um pedido ser criado sem preço nenhum.
  if v_custo_moedas is null then
    v_custo_moedas := 4;
    v_valor_min := 150;
    v_valor_max := 400;
  end if;

  if new.urgencia = 'urgente' then
    v_valor_min := v_valor_min * 1.25;
    v_valor_max := v_valor_max * 1.25;
    v_custo_moedas := v_custo_moedas + 1;
  elsif new.urgencia = 'muito_urgente' then
    v_valor_min := v_valor_min * 1.5;
    v_valor_max := v_valor_max * 1.5;
    v_custo_moedas := v_custo_moedas + 2;
  end if;

  if new.tipo_atendimento = 'empresarial' then
    v_valor_min := v_valor_min * 1.3;
    v_valor_max := v_valor_max * 1.3;
  end if;

  new.custo_moedas := ceil(v_custo_moedas);
  new.valor_estimado_min := round(v_valor_min);
  new.valor_estimado_max := round(v_valor_max);

  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists trg_precificar_pedido on pedidos;
create trigger trg_precificar_pedido
  before insert on pedidos
  for each row execute function pedidos_precificar();

-- ─── Confirme que tudo existe ──────────────────────────────────────────────
select count(*) as niveis from moedas_niveis_complexidade;
select count(*) as categorias from moedas_categorias_nivel;
select column_name from information_schema.columns where table_name = 'pedidos' and column_name in ('custo_moedas','valor_estimado_min','valor_estimado_max','escopo_montador');
select tgname from pg_trigger where tgname = 'trg_precificar_pedido';

-- Teste de sanidade (manual, opcional) — insira um pedido de teste mandando
-- custo_moedas forjado no payload e confirme que o trigger sobrescreve:
-- insert into pedidos (cliente_id, categoria, descricao, status, custo_moedas)
--   values ('teste@teste.com', 'encanador', 'teste motor de precificação', 'aberto', 999)
--   returning categoria, custo_moedas, valor_estimado_min, valor_estimado_max;
-- (custo_moedas deve voltar 4, não 999 — depois apague a linha de teste)

-- Teste de sanidade do piloto Montador — sem escopo_montador preenchido tem
-- que cair no nível mais caro (8 moedas), não no "médio" default de outras
-- categorias:
-- insert into pedidos (cliente_id, categoria, descricao, status)
--   values ('teste@teste.com', 'montador_de_moveis', 'teste sem campo guiado', 'aberto')
--   returning custo_moedas, valor_estimado_min, valor_estimado_max; -- espera 8
-- insert into pedidos (cliente_id, categoria, descricao, status, escopo_montador)
--   values ('teste@teste.com', 'montador_de_moveis', 'teste peça pequena', 'aberto', 'peca_pequena')
--   returning custo_moedas, valor_estimado_min, valor_estimado_max; -- espera 2
-- (depois apague as linhas de teste)
