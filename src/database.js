const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, '../data.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS contatos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    telefone TEXT UNIQUE NOT NULL,
    email TEXT,
    segmento TEXT DEFAULT 'Lead',
    valor_ultimo_pedido TEXT,
    data_ultimo_pedido TEXT,
    cidade TEXT,
    estado TEXT,
    origem TEXT,
    data_cadastro TEXT,
    nascimento TEXT,
    ultimo_disparo TEXT,
    total_mensagens INTEGER DEFAULT 0,
    respondeu INTEGER DEFAULT 0,
    obs TEXT,
    criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS campanhas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    mensagem TEXT NOT NULL,
    segmento TEXT DEFAULT 'todos',
    status TEXT DEFAULT 'rascunho',
    total_envios INTEGER DEFAULT 0,
    total_erros INTEGER DEFAULT 0,
    intervalo_segundos INTEGER DEFAULT 45,
    criado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
    disparado_em DATETIME
  );
  CREATE TABLE IF NOT EXISTS disparos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campanha_id INTEGER,
    contato_id INTEGER,
    telefone TEXT,
    mensagem TEXT,
    status TEXT DEFAULT 'pendente',
    erro TEXT,
    enviado_em DATETIME
  );
  CREATE TABLE IF NOT EXISTS fluxos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    tipo TEXT NOT NULL,
    mensagem TEXT NOT NULL,
    ativo INTEGER DEFAULT 1,
    delay_horas INTEGER DEFAULT 0,
    criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS conversas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telefone TEXT NOT NULL,
    nome TEXT,
    mensagem TEXT NOT NULL,
    de TEXT DEFAULT 'cliente',
    respondida_ia INTEGER DEFAULT 0,
    criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_contatos_telefone ON contatos(telefone);
  CREATE INDEX IF NOT EXISTS idx_contatos_segmento ON contatos(segmento);
`);
const total = db.prepare('SELECT COUNT(*) as c FROM fluxos').get();
if (total.c === 0) {
  const ins = db.prepare('INSERT INTO fluxos (nome,tipo,mensagem,delay_horas) VALUES (?,?,?,?)');
  ins.run('Boas-vindas + Cupom','boas_vindas','Oi {nome}! Seja bem-vinda a Madame Ka!\n\nVoce ganhou um cupom exclusivo:\n\n*ESPECIAL*\n\n10% de desconto na primeira compra!\n\nmadameka.com.br',0);
  ins.run('Carrinho Abandonado 1h','carrinho_abandonado','Oi {nome}!\n\nVoce deixou pecas no carrinho da Madame Ka...\n\nSua sacola ainda esta salva! Promocao termina hoje a meia-noite\n\nmadameka.com.br/cart',1);
  ins.run('Carrinho Abandonado 12h','carrinho_abandonado_2','Oi {nome}!\n\nUltima chance! Leve 2+ pecas com cupom *MADAME8* = 8% off\n\nmadameka.com.br/cart',12);
  ins.run('Pos-compra Confirmacao','pos_compra','Oi {nome}!\n\nPedido confirmado! Obrigada por comprar na Madame Ka! Seu pedido esta sendo preparado com carinho',0);
  ins.run('Review 7 dias','review','Oi {nome}!\n\nJa chegou seu pedido da Madame Ka? Conta pra gente como foi! Sua opiniao e muito importante',168);
}
module.exports = db;
