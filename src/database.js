const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://evolution_db_zv4y_user:WCYgoFusJb6oJRabhbZK8GXpdDIjxIkB@dpg-d88qta0jo6nc73d7jvr0-a/evolution_db_zv4y',
  ssl: { rejectUnauthorized: false }
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS contatos (
      id SERIAL PRIMARY KEY, nome TEXT NOT NULL, telefone TEXT UNIQUE NOT NULL,
      email TEXT, segmento TEXT DEFAULT 'Lead', valor_ultimo_pedido TEXT,
      data_ultimo_pedido TEXT, cidade TEXT, estado TEXT, origem TEXT,
      data_cadastro TEXT, nascimento TEXT, ultimo_disparo TIMESTAMP,
      total_mensagens INTEGER DEFAULT 0, respondeu INTEGER DEFAULT 0,
      total_compras INTEGER DEFAULT 0, obs TEXT, criado_em TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS campanhas (
      id SERIAL PRIMARY KEY, nome TEXT NOT NULL, mensagem TEXT NOT NULL,
      segmento TEXT DEFAULT 'todos', status TEXT DEFAULT 'rascunho',
      total_envios INTEGER DEFAULT 0, total_erros INTEGER DEFAULT 0,
      intervalo_segundos INTEGER DEFAULT 45, criado_em TIMESTAMP DEFAULT NOW(), disparado_em TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS disparos (
      id SERIAL PRIMARY KEY, campanha_id INTEGER, contato_id INTEGER,
      telefone TEXT, mensagem TEXT, status TEXT DEFAULT 'pendente',
      erro TEXT, enviado_em TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS fluxos (
      id SERIAL PRIMARY KEY, nome TEXT NOT NULL, tipo TEXT NOT NULL,
      mensagem TEXT NOT NULL, ativo INTEGER DEFAULT 1,
      delay_horas INTEGER DEFAULT 0, criado_em TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS conversas (
      id SERIAL PRIMARY KEY, telefone TEXT NOT NULL, nome TEXT,
      mensagem TEXT NOT NULL, de TEXT DEFAULT 'cliente',
      respondida_ia INTEGER DEFAULT 0, criado_em TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS sequencias (
      id SERIAL PRIMARY KEY, nome TEXT NOT NULL, descricao TEXT,
      gatilho TEXT NOT NULL, segmento TEXT DEFAULT 'todos',
      ativo INTEGER DEFAULT 0, criado_em TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS sequencia_passos (
      id SERIAL PRIMARY KEY,
      sequencia_id INTEGER REFERENCES sequencias(id) ON DELETE CASCADE,
      ordem INTEGER NOT NULL, mensagem TEXT NOT NULL,
      delay_horas INTEGER DEFAULT 0, delay_label TEXT DEFAULT 'Imediato',
      midia_tipo TEXT DEFAULT 'texto', midia_url TEXT DEFAULT '',
      criado_em TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS sequencia_execucoes (
      id SERIAL PRIMARY KEY, sequencia_id INTEGER, contato_id INTEGER,
      telefone TEXT, passo_atual INTEGER DEFAULT 0,
      status TEXT DEFAULT 'ativo', iniciado_em TIMESTAMP DEFAULT NOW(),
      proximo_envio TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS configuracoes (
      chave TEXT PRIMARY KEY,
      valor TEXT NOT NULL,
      atualizado_em TIMESTAMP DEFAULT NOW()
    );
  `);

  const { rows } = await pool.query('SELECT COUNT(*) as c FROM fluxos');
  if (rows[0].c === '0' || rows[0].c === 0) {
    const ins = (n,t,m,d) => pool.query('INSERT INTO fluxos (nome,tipo,mensagem,delay_horas) VALUES ($1,$2,$3,$4)',[n,t,m,d]);
    await ins('Boas-vindas + Cupom','boas_vindas','Oi {nome}! Seja bem-vinda a Madame Ka!\n\nVoce ganhou um cupom exclusivo:\n\n*ESPECIAL*\n\n10% de desconto na primeira compra!\n\nmadameka.com.br',0);
    await ins('Carrinho Abandonado 1h','carrinho_abandonado','Oi {nome}!\n\nVoce deixou pecas no carrinho da Madame Ka...\n\nSua sacola ainda esta salva!\n\nmadameka.com.br/cart',1);
    await ins('Carrinho Abandonado 12h','carrinho_abandonado_2','Oi {nome}!\n\nUltima chance! Leve 2+ pecas com cupom *MADAME8* = 8% off\n\nmadameka.com.br/cart',12);
    await ins('Pos-compra','pos_compra','Oi {nome}!\n\nPedido confirmado! Obrigada por comprar na Madame Ka! Seu pedido esta sendo preparado com carinho',0);
    await ins('Review 7 dias','review','Oi {nome}!\n\nJa chegou seu pedido? Conta pra gente como foi!',168);
  }

  // Configurações padrão
  await pool.query(`INSERT INTO configuracoes (chave, valor) VALUES ('limite_diario', '200') ON CONFLICT (chave) DO NOTHING`);
  await pool.query(`INSERT INTO configuracoes (chave, valor) VALUES ('horario_inicio', '9') ON CONFLICT (chave) DO NOTHING`);
  await pool.query(`INSERT INTO configuracoes (chave, valor) VALUES ('horario_fim', '20') ON CONFLICT (chave) DO NOTHING`);

  // Sempre roda — adiciona colunas se não existirem
  await pool.query(`ALTER TABLE sequencia_passos ADD COLUMN IF NOT EXISTS midia_tipo TEXT DEFAULT 'texto'`);
  await pool.query(`ALTER TABLE sequencia_passos ADD COLUMN IF NOT EXISTS midia_url TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE fluxos ADD COLUMN IF NOT EXISTS midia_tipo TEXT DEFAULT 'texto'`);
  await pool.query(`ALTER TABLE fluxos ADD COLUMN IF NOT EXISTS midia_url TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE campanhas ADD COLUMN IF NOT EXISTS midia_tipo TEXT DEFAULT 'texto'`);
  await pool.query(`ALTER TABLE campanhas ADD COLUMN IF NOT EXISTS midia_url TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE contatos ADD COLUMN IF NOT EXISTS total_compras INTEGER DEFAULT 0`);
}

async function calcularSegmento(contato) {
  const hoje = new Date();
  if (contato.nascimento) {
    const nasc = new Date(contato.nascimento);
    if (nasc.getDate() === hoje.getDate() && nasc.getMonth() === hoje.getMonth()) return 'Aniversariante';
  }
  if ((contato.total_compras || 0) >= 3) return 'Alta Frequencia';
  const valor = parseFloat((contato.valor_ultimo_pedido || '0').replace(/[^0-9.]/g, '')) || 0;
  if (valor >= 500) return 'VIP';
  if (contato.data_ultimo_pedido) {
    const ultimaCompra = new Date(contato.data_ultimo_pedido);
    const dias = (hoje - ultimaCompra) / (1000 * 60 * 60 * 24);
    if (dias <= 7) return 'Compradora Recente';
    if (dias <= 60) return 'Compradora Ativa';
    if (dias <= 90) return 'Em Risco';
    return 'Compradora Inativa';
  }
  return contato.segmento || 'Lead';
}

async function buscarPorSegmento(segmento) {
  if (segmento === 'todos') {
    const { rows } = await pool.query('SELECT * FROM contatos');
    return rows;
  }
  if (segmento === 'Aniversariante') {
    const hoje = new Date();
    const mes = String(hoje.getMonth() + 1).padStart(2, '0');
    const dia = String(hoje.getDate()).padStart(2, '0');
    const { rows } = await pool.query(
      `SELECT * FROM contatos WHERE nascimento LIKE $1 OR nascimento LIKE $2`,
      [`%-${mes}-${dia}`, `${dia}/${mes}%`]
    );
    return rows;
  }
  if (segmento === 'Alta Frequencia') {
    const { rows } = await pool.query('SELECT * FROM contatos WHERE total_compras >= 3');
    return rows;
  }
  if (segmento === 'Compradora Recente') {
    const { rows } = await pool.query(
      `SELECT * FROM contatos WHERE data_ultimo_pedido IS NOT NULL AND data_ultimo_pedido != '' AND criado_em >= NOW() - INTERVAL '7 days'`
    );
    return rows;
  }
  if (segmento === 'Em Risco') {
    const { rows } = await pool.query(
      `SELECT * FROM contatos WHERE segmento IN ('Compradora Ativa','Compradora Inativa') AND (ultimo_disparo IS NULL OR ultimo_disparo < NOW() - INTERVAL '45 days')`
    );
    return rows;
  }
  const { rows } = await pool.query('SELECT * FROM contatos WHERE segmento=$1', [segmento]);
  return rows;
}

async function getConfig() {
  const { rows } = await pool.query('SELECT * FROM configuracoes');
  const cfg = {};
  rows.forEach(r => cfg[r.chave] = r.valor);
  return {
    limite_diario: parseInt(cfg.limite_diario || '200'),
    horario_inicio: parseInt(cfg.horario_inicio || '9'),
    horario_fim: parseInt(cfg.horario_fim || '20'),
  };
}
await pool.query(`
  CREATE TABLE IF NOT EXISTS instancias (
    id SERIAL PRIMARY KEY,
    nome TEXT NOT NULL,
    instance_id TEXT NOT NULL,
    token TEXT NOT NULL,
    client_token TEXT NOT NULL,
    status TEXT DEFAULT 'desconectado',
    ativo INTEGER DEFAULT 1,
    criado_em TIMESTAMP DEFAULT NOW()
  );
`);
// Instância principal já existente
await pool.query(`
  INSERT INTO instancias (nome, instance_id, token, client_token)
  VALUES ('Principal', '3F3B33A2992E1162E39B6627BE24201D', 'C8C9AEE300AE3E2B586CF1B3', 'F8d6cdf1bbebe419abdb464fbf2c74bb2S')
  ON CONFLICT DO NOTHING
`);
await pool.query(`ALTER TABLE campanhas ADD COLUMN IF NOT EXISTS instancia_id INTEGER DEFAULT 1`);

init().catch(console.error);

module.exports = { pool, calcularSegmento, buscarPorSegmento, getConfig };