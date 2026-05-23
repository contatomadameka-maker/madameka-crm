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
      obs TEXT, criado_em TIMESTAMP DEFAULT NOW()
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
}

init().catch(console.error);

module.exports = { pool };