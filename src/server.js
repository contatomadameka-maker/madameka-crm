require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const fs = require('fs');
const { pool, buscarPorSegmento, getConfig } = require('./database');
const wpp = require('./whatsapp');
const { responderIA } = require('./ia');
const cloudinary = require('cloudinary').v2;
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const app = express();
const PORT = process.env.PORT || 3000;
const PASS = process.env.ADMIN_PASSWORD || 'madameka2026';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));
const upload = multer({ dest: '/tmp/uploads/' });

const EMOJIS_FINAL = ['💛','✨','🌟','💕','🛍️','👗'];
function variarMensagem(msg, nome, idx) {
  let m = msg.replace(/{nome}/g, nome||'Cliente');
  const emoji = EMOJIS_FINAL[idx % EMOJIS_FINAL.length];
  if (!m.endsWith(emoji)) m = m + ' ' + emoji;
  return m;
}

function horaBrasilia() {
  const hora = new Date().toLocaleString('en-US', {
    timeZone: 'America/Sao_Paulo', hour: 'numeric', hour12: false
  });
  return parseInt(hora);
}

function horarioPermitido() {
  return horaBrasilia() >= 9 && horaBrasilia() < 20;
}

async function enviosHoje() {
  const { rows } = await pool.query(
    "SELECT COUNT(*) as c FROM disparos WHERE status='enviado' AND enviado_em >= (NOW() AT TIME ZONE 'America/Sao_Paulo')::date"
  );
  return parseInt(rows[0].c);
}

// ─── NORMALIZAR TELEFONE ──────────────────────────────────────────────────────
function normalizarTelefone(tel) {
  if (!tel) return tel;
  let t = tel.replace(/\D/g, '');
  if (!t.startsWith('55')) t = '55' + t;
  return t;
}

// Busca contato tanto com 55 quanto sem
async function buscarContatoPorTelefone(tel) {
  const norm = normalizarTelefone(tel);
  const semDDI = norm.slice(2);
  const { rows } = await pool.query(
    'SELECT * FROM contatos WHERE telefone=$1 OR telefone=$2 OR telefone LIKE $3',
    [norm, semDDI, '%' + semDDI.slice(-9)]
  );
  return rows[0] || null;
}

async function initExtras() {
  await pool.query(`CREATE TABLE IF NOT EXISTS etiquetas (id SERIAL PRIMARY KEY, nome TEXT NOT NULL, cor TEXT NOT NULL DEFAULT '#888888', criado_em TIMESTAMP DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS contato_etiquetas (id SERIAL PRIMARY KEY, telefone TEXT NOT NULL, etiqueta_id INTEGER REFERENCES etiquetas(id) ON DELETE CASCADE, criado_em TIMESTAMP DEFAULT NOW(), UNIQUE(telefone, etiqueta_id))`);
  await pool.query(`ALTER TABLE conversas ADD COLUMN IF NOT EXISTS lida INTEGER DEFAULT 0`);
  await pool.query(`ALTER TABLE conversas ADD COLUMN IF NOT EXISTS tipo TEXT DEFAULT 'mensagem'`);

  // ── MIGRAÇÃO: normaliza todos os telefones sem DDI 55 no banco ──────────────
  await pool.query(`
    UPDATE conversas
    SET telefone = '55' || telefone
    WHERE telefone NOT LIKE '55%'
      AND LENGTH(REGEXP_REPLACE(telefone, '\\D', '', 'g')) >= 10
  `);
  await pool.query(`
    UPDATE contatos
    SET telefone = '55' || telefone
    WHERE telefone NOT LIKE '55%'
      AND LENGTH(REGEXP_REPLACE(telefone, '\\D', '', 'g')) >= 10
  `);
  await pool.query(`
    UPDATE contato_etiquetas
    SET telefone = '55' || telefone
    WHERE telefone NOT LIKE '55%'
      AND LENGTH(REGEXP_REPLACE(telefone, '\\D', '', 'g')) >= 10
  `);
  await pool.query(`
    UPDATE disparos
    SET telefone = '55' || telefone
    WHERE telefone NOT LIKE '55%'
      AND LENGTH(REGEXP_REPLACE(telefone, '\\D', '', 'g')) >= 10
  `);
  console.log('✅ Telefones normalizados com DDI 55');

  await pool.query(`ALTER TABLE campanhas ADD COLUMN IF NOT EXISTS template_name TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE campanhas ADD COLUMN IF NOT EXISTS etiqueta_id INTEGER DEFAULT NULL`);

  // ── MIGRAÇÃO: adiciona coluna midia_url em conversas para áudios e mídias ───
  await pool.query(`ALTER TABLE conversas ADD COLUMN IF NOT EXISTS midia_url TEXT DEFAULT NULL`);
  await pool.query(`ALTER TABLE conversas ADD COLUMN IF NOT EXISTS midia_tipo TEXT DEFAULT NULL`);

  console.log('DB extras inicializados');
}
initExtras().catch(console.error);

// ── RETOMA campanhas que estavam disparando antes do redeploy ─────────────────
async function retomarCampanhasInterrompidas() {
  try {
    const { rows } = await pool.query("SELECT * FROM campanhas WHERE status='disparando'");
    for (const c of rows) {
      await pool.query("UPDATE campanhas SET status='pausado' WHERE id=$1", [c.id]);
      console.log(`Campanha ${c.nome} (${c.id}) marcada como pausada após redeploy — reative manualmente`);
    }
    if (rows.length > 0) console.log(`⚠️ ${rows.length} campanha(s) interrompida(s) pelo redeploy. Reative no painel.`);
  } catch(e) { console.error('Erro retomarCampanhas:', e.message); }
}
retomarCampanhasInterrompidas();

// ─── AUTH ─────────────────────────────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { senha } = req.body;
  if (senha === PASS) return res.json({ ok: true });
  res.status(401).json({ ok: false, erro: 'Senha incorreta' });
});

// ─── WHATSAPP ─────────────────────────────────────────────────────────────────
app.get('/api/wpp/status', async (req, res) => res.json(await wpp.getStatus()));
app.get('/api/wpp/qr', async (req, res) => res.json(await wpp.getQRCode()));
app.post('/api/wpp/criar', async (req, res) => res.json(await wpp.criarInstancia()));
app.post('/api/wpp/desconectar', async (req, res) => res.json(await wpp.desconectar()));
app.post('/api/wpp/reset', async (req, res) => {
  try {
    const sessionDir = path.join(__dirname, '../sessions');
    if (fs.existsSync(sessionDir)) { fs.rmSync(sessionDir, { recursive: true, force: true }); fs.mkdirSync(sessionDir); }
    res.json({ ok: true, msg: 'Sessao resetada' });
  } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
});

// ─── STATS ────────────────────────────────────────────────────────────────────
app.get('/api/seguranca/stats', async (req, res) => {
  try {
    const hoje = await enviosHoje();
    res.json({ ok: true, enviosHoje: hoje, limiteHoje: 200, horarioPermitido: horarioPermitido(), horaAtual: horaBrasilia() });
  } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
});

// ─── WEBHOOK WPP ──────────────────────────────────────────────────────────────
app.post('/webhook/wpp', async (req, res) => {
  res.json({ ok: true });
  try {
    const body = req.body;
    if (!body?.data?.message) return;
    const fromRaw = body.data.key?.remoteJid?.replace('@s.whatsapp.net', '');
    const from = normalizarTelefone(fromRaw);
    const text = body.data.message.conversation || body.data.message.extendedTextMessage?.text || '';
    if (!text || !from) return;
    const contato = await buscarContatoPorTelefone(from);
    const nome = contato?.nome || 'Cliente';
    await pool.query('INSERT INTO conversas (telefone, nome, mensagem, de, lida) VALUES ($1,$2,$3,$4,0)', [from, nome, text, 'cliente']);
    const hist = await pool.query('SELECT * FROM conversas WHERE telefone=$1 ORDER BY criado_em DESC LIMIT 10', [from]);
    const resposta = await responderIA(hist.rows.reverse(), text);
    if (resposta) {
      await new Promise(r => setTimeout(r, 2000));
      const enviou = await wpp.enviarMensagem(from, resposta);
      if (enviou.ok) await pool.query('INSERT INTO conversas (telefone, nome, mensagem, de, respondida_ia, lida) VALUES ($1,$2,$3,$4,$5,1)', [from, 'Madame Ka', resposta, 'bot', 1]);
    }
  } catch (e) { console.error(e); }
});

// ─── CONTATOS ─────────────────────────────────────────────────────────────────
app.get('/api/contatos/stats', async (req, res) => {
  try {
    const total = await pool.query('SELECT COUNT(*) as c FROM contatos');
    const vip = await pool.query("SELECT COUNT(*) as c FROM contatos WHERE segmento='VIP'");
    const ativas = await pool.query("SELECT COUNT(*) as c FROM contatos WHERE segmento='Compradora Ativa'");
    const inativas = await pool.query("SELECT COUNT(*) as c FROM contatos WHERE segmento='Compradora Inativa'");
    const leads = await pool.query("SELECT COUNT(*) as c FROM contatos WHERE segmento='Lead'");
    const disparos = await pool.query("SELECT COUNT(*) as c FROM disparos WHERE status='enviado'");
    const hoje = new Date();
    const mes = String(hoje.getMonth() + 1).padStart(2, '0');
    const dia = String(hoje.getDate()).padStart(2, '0');
    const aniv = await pool.query(`SELECT COUNT(*) as c FROM contatos WHERE nascimento LIKE $1 OR nascimento LIKE $2`, [`%-${mes}-${dia}`, `${dia}/${mes}%`]);
    const envHoje = await enviosHoje();
    res.json({ ok: true, total: parseInt(total.rows[0].c), vip: parseInt(vip.rows[0].c), ativas: parseInt(ativas.rows[0].c), inativas: parseInt(inativas.rows[0].c), leads: parseInt(leads.rows[0].c), disparos: parseInt(disparos.rows[0].c), aniversariantes: parseInt(aniv.rows[0].c), enviosHoje: envHoje });
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

app.get('/api/contatos', async (req, res) => {
  try {
    const { segmento, busca, etiqueta, limit = 50, offset = 0 } = req.query;
    let sql = 'SELECT c.* FROM contatos c';
    const params = [];
    let i = 1;
    if (etiqueta) {
      sql += ' JOIN contato_etiquetas ce ON ce.telefone=c.telefone AND ce.etiqueta_id=$' + i++;
      params.push(parseInt(etiqueta));
    }
    sql += ' WHERE 1=1';
    if (segmento && segmento !== 'todos') { sql += ` AND c.segmento=$${i++}`; params.push(segmento); }
    if (busca && busca.trim() !== '') { sql += ` AND (c.nome ILIKE $${i} OR c.telefone ILIKE $${i} OR c.email ILIKE $${i})`; params.push(`%${busca.trim()}%`); i++; }
    sql += ` ORDER BY c.criado_em DESC LIMIT $${i++} OFFSET $${i++}`;
    params.push(parseInt(limit), parseInt(offset));
    const { rows } = await pool.query(sql, params);
    let countSql = 'SELECT COUNT(*) as c FROM contatos c WHERE 1=1';
    const countParams = [];
    let j = 1;
    if (segmento && segmento !== 'todos') { countSql += ` AND c.segmento=$${j++}`; countParams.push(segmento); }
    if (etiqueta) { countSql += ` AND EXISTS (SELECT 1 FROM contato_etiquetas ce2 WHERE ce2.telefone=c.telefone AND ce2.etiqueta_id=$${j++})`; countParams.push(parseInt(etiqueta)); }
    const count = await pool.query(countSql, countParams);
    res.json({ ok: true, contatos: rows, total: parseInt(count.rows[0].c) });
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

// Criar contato avulso (pelo chat de conversas)
app.post('/api/contatos', async (req, res) => {
  try {
    const { nome, telefone, segmento } = req.body;
    const tel = normalizarTelefone(telefone);
    if (!tel) return res.json({ ok: false, erro: 'Telefone obrigatório' });
    const { rows } = await pool.query(
      `INSERT INTO contatos (nome, telefone, segmento) VALUES ($1, $2, $3) RETURNING id`,
      [nome || 'Cliente', tel, segmento || 'Lead']
    );
    res.json({ ok: true, id: rows[0].id });
  } catch(e) {
    if (e.code === '23505') return res.json({ ok: false, erro: 'Já existe' });
    res.status(500).json({ ok: false, erro: e.message });
  }
});

// Atualizar nome do contato
app.put('/api/contatos/:telefone', async (req, res) => {
  try {
    const tel = normalizarTelefone(req.params.telefone);
    const semDDI = tel.slice(2);
    const { nome } = req.body;
    await pool.query(
      'UPDATE contatos SET nome=$1 WHERE telefone=$2 OR telefone=$3',
      [nome, tel, semDDI]
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
});

app.post('/api/contatos/importar', upload.single('arquivo'), async (req, res) => {
  try {
    const content = fs.readFileSync(req.file.path, 'utf-8');
    const rows = parse(content, { columns: true, skip_empty_lines: true });
    let importados = 0;
    for (const r of rows) {
      const tel = normalizarTelefone((r['whatsapp'] || r['WhatsApp'] || r['telefone'] || r['telefone_com_ddd'] || r['phone'] || '').replace(/\D/g, ''));
      if (!tel) continue;
      try {
        await pool.query(
          `INSERT INTO contatos (nome,telefone,email,segmento,valor_ultimo_pedido,data_ultimo_pedido,cidade,estado,origem,data_cadastro,nascimento)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT (telefone) DO UPDATE SET
             nome = CASE WHEN contatos.nome = '' OR contatos.nome IS NULL THEN EXCLUDED.nome ELSE contatos.nome END,
             segmento = CASE WHEN EXCLUDED.segmento != 'Lead' THEN EXCLUDED.segmento ELSE contatos.segmento END,
             valor_ultimo_pedido = CASE WHEN EXCLUDED.valor_ultimo_pedido != '' THEN EXCLUDED.valor_ultimo_pedido ELSE contatos.valor_ultimo_pedido END,
             data_ultimo_pedido = CASE WHEN EXCLUDED.data_ultimo_pedido != '' THEN EXCLUDED.data_ultimo_pedido ELSE contatos.data_ultimo_pedido END,
             cidade = CASE WHEN EXCLUDED.cidade != '' THEN EXCLUDED.cidade ELSE contatos.cidade END,
             nascimento = CASE WHEN EXCLUDED.nascimento != '' THEN EXCLUDED.nascimento ELSE contatos.nascimento END`,
          [r['nome']||r['Nome']||'', tel, r['Email']||r['email']||'', r['Segmento']||r['segmento']||'Lead',
           r['Valor Último Pedido']||r['valor_ultimo_pedido']||'', r['Data Último Pedido']||r['data_ultimo_pedido']||'',
           r['Cidade']||r['cidade']||'', r['Estado']||r['estado']||'', r['Origem']||r['utm_source']||'',
           r['Data Cadastro']||r['criado_em']||'', r['Nascimento']||r['data_nascimento']||'']);
        importados++;
      } catch(e) {}
    }
    fs.unlinkSync(req.file.path);
    res.json({ ok: true, importados });
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

// ─── ETIQUETAS ────────────────────────────────────────────────────────────────
app.get('/api/etiquetas', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM etiquetas ORDER BY nome');
    res.json({ ok: true, etiquetas: rows });
  } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
});

app.post('/api/etiquetas', async (req, res) => {
  try {
    const { nome, cor } = req.body;
    if (!nome) return res.json({ ok: false, erro: 'Nome obrigatorio' });
    const { rows } = await pool.query('INSERT INTO etiquetas (nome,cor) VALUES ($1,$2) RETURNING *', [nome, cor||'#888888']);
    res.json({ ok: true, etiqueta: rows[0] });
  } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
});

app.delete('/api/etiquetas/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM etiquetas WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
});

app.get('/api/contatos/:telefone/etiquetas', async (req, res) => {
  try {
    const tel = normalizarTelefone(req.params.telefone);
    const semDDI = tel.slice(2);
    const { rows } = await pool.query(
      `SELECT e.* FROM etiquetas e JOIN contato_etiquetas ce ON ce.etiqueta_id=e.id 
       WHERE ce.telefone=$1 OR ce.telefone=$2`,
      [tel, semDDI]
    );
    res.json({ ok: true, etiquetas: rows });
  } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
});

app.post('/api/contatos/:telefone/etiquetas', async (req, res) => {
  try {
    const { etiqueta_id } = req.body;
    const tel = normalizarTelefone(req.params.telefone);
    await pool.query(
      'INSERT INTO contato_etiquetas (telefone, etiqueta_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [tel, etiqueta_id]
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
});

app.delete('/api/contatos/:telefone/etiquetas/:etiqueta_id', async (req, res) => {
  try {
    const tel = normalizarTelefone(req.params.telefone);
    const semDDI = tel.slice(2);
    await pool.query('DELETE FROM contato_etiquetas WHERE (telefone=$1 OR telefone=$2) AND etiqueta_id=$3', [tel, semDDI, req.params.etiqueta_id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
});

// ─── CAMPANHAS ────────────────────────────────────────────────────────────────
app.get('/api/campanhas', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM campanhas ORDER BY criado_em DESC');
    res.json({ ok: true, campanhas: rows });
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

app.post('/api/campanhas', async (req, res) => {
  try {
    const { nome, mensagem, segmento, intervalo_segundos, midia_tipo, midia_url, limite, template_name, etiqueta_id } = req.body;
    const { rows } = await pool.query(
      'INSERT INTO campanhas (nome,mensagem,segmento,intervalo_segundos,midia_tipo,midia_url,template_name,etiqueta_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
      [nome, mensagem||'', segmento||'todos', intervalo_segundos||60, midia_tipo||'texto', midia_url||'', template_name||'', etiqueta_id||null]
    );
    res.json({ ok: true, id: rows[0].id });
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

app.delete('/api/campanhas/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM disparos WHERE campanha_id=$1', [req.params.id]);
    await pool.query('DELETE FROM campanhas WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
});

app.put('/api/campanhas/:id', async (req, res) => {
  try {
    const { nome, template_name, mensagem, intervalo_segundos } = req.body;
    await pool.query(
      'UPDATE campanhas SET nome=$1, template_name=$2, mensagem=$3, intervalo_segundos=$4 WHERE id=$5',
      [nome, template_name||'', mensagem||'', intervalo_segundos||90, req.params.id]
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
});

app.post('/api/campanhas/:id/pausar', async (req, res) => {
  try {
    await pool.query("UPDATE campanhas SET status='pausado' WHERE id=$1", [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
});

app.post('/api/campanhas/:id/disparar', async (req, res) => {
  try {
    const { rows: camp } = await pool.query('SELECT * FROM campanhas WHERE id=$1', [req.params.id]);
    if (!camp.length) return res.json({ ok: false, erro: 'Nao encontrada' });
    const campanha = camp[0];
    const { limite } = req.body;

    const cfg = await getConfig();
    const hora = horaBrasilia();
    if (hora < cfg.horario_inicio || hora >= cfg.horario_fim) {
      return res.json({ ok: false, erro: `Fora do horário permitido (${cfg.horario_inicio}h-${cfg.horario_fim}h). Agora são ${hora}h.` });
    }
    const envHoje = await enviosHoje();
    const restante = cfg.limite_diario - envHoje;
    if (restante <= 0) return res.json({ ok: false, erro: `Limite diário atingido.` });

    const { rows: jaEnviados } = await pool.query("SELECT telefone FROM disparos WHERE campanha_id=$1 AND status='enviado'", [campanha.id]);
    const jaEnviadosSet = new Set(jaEnviados.map(r => r.telefone));

    let contatos = [];
    if (campanha.etiqueta_id) {
      const { rows: porEtiqueta } = await pool.query(
        'SELECT c.* FROM contatos c JOIN contato_etiquetas ce ON ce.telefone=c.telefone WHERE ce.etiqueta_id=$1',
        [campanha.etiqueta_id]
      );
      contatos = porEtiqueta.filter(c => !jaEnviadosSet.has(c.telefone));
    } else {
      const todosContatos = await buscarPorSegmento(campanha.segmento);
      contatos = todosContatos.filter(c => !jaEnviadosSet.has(c.telefone));
    }

    const limiteNum = parseInt(limite) || 0;
    if (limiteNum > 0) contatos = contatos.slice(0, limiteNum);
    if (contatos.length > restante) contatos = contatos.slice(0, restante);

    if (!contatos.length) {
      await pool.query('UPDATE campanhas SET status=$1 WHERE id=$2', ['concluido', campanha.id]);
      return res.json({ ok: true, total: 0, mensagem: 'Todos já receberam ou limite atingido!' });
    }

    await pool.query('UPDATE campanhas SET status=$1, disparado_em=NOW() WHERE id=$2', ['disparando', campanha.id]);
    res.json({ ok: true, total: contatos.length, mensagem: `Disparando para ${contatos.length} contatos · ${restante} restantes hoje` });

    let i = 0;
    const intervalo = (campanha.intervalo_segundos || 60) * 1000;

    async function enviarProximo() {
      const { rows: statusRows } = await pool.query('SELECT status FROM campanhas WHERE id=$1', [campanha.id]);
      if (statusRows[0]?.status === 'pausado') return;
      const horaAtual = horaBrasilia();
      if (horaAtual < cfg.horario_inicio || horaAtual >= cfg.horario_fim) {
        await pool.query("UPDATE campanhas SET status='pausado' WHERE id=$1", [campanha.id]); return;
      }
      if (await enviosHoje() >= cfg.limite_diario) {
        await pool.query("UPDATE campanhas SET status='pausado' WHERE id=$1", [campanha.id]); return;
      }
      if (i >= contatos.length) {
        await pool.query('UPDATE campanhas SET status=$1 WHERE id=$2', ['concluido', campanha.id]); return;
      }

      const c = contatos[i++];
      const nomeCliente = (c.nome||'').split(' ')[0] || 'Cliente';
      const msg = variarMensagem(campanha.mensagem || '', nomeCliente, i);

      let resultado;
      if (campanha.template_name) {
        resultado = await wpp.enviarTemplate(c.telefone, campanha.template_name, 'pt_BR', [
          { type: 'body', parameters: [{ type: 'text', text: nomeCliente }] }
        ]);
      } else {
        const { rows: instRows } = await pool.query('SELECT * FROM instancias WHERE id=$1 AND ativo=1', [campanha.instancia_id || 1]);
        const inst = instRows[0];
        if (inst) {
          resultado = campanha.midia_tipo && campanha.midia_tipo !== 'texto' && campanha.midia_url
            ? await wpp.enviarMidiaInstancia(inst, c.telefone, campanha.midia_tipo, campanha.midia_url, msg)
            : await wpp.enviarMensagemInstancia(inst, c.telefone, msg);
        } else {
          resultado = { ok: false, erro: 'Instância não encontrada' };
        }
      }

      const statusEnvio = resultado.ok ? 'enviado' : 'erro';
      const msgSalva = campanha.template_name ? 'template:' + campanha.template_name : msg;
      await pool.query(
        'INSERT INTO disparos (campanha_id,contato_id,telefone,mensagem,status,erro,enviado_em) VALUES ($1,$2,$3,$4,$5,$6,NOW())',
        [campanha.id, c.id, c.telefone, msgSalva, statusEnvio, resultado.erro||null]
      );
      await pool.query('UPDATE campanhas SET total_envios=total_envios+$1, total_erros=total_erros+$2 WHERE id=$3', [resultado.ok?1:0, resultado.ok?0:1, campanha.id]);
      await pool.query('UPDATE contatos SET ultimo_disparo=NOW(), total_mensagens=total_mensagens+1 WHERE id=$1', [c.id]);
      console.log(`Campanha ${campanha.id} [${i}/${contatos.length}] -> ${c.telefone}: ${resultado.ok?'OK':'ERRO'}`);
      setTimeout(enviarProximo, intervalo);
    }

    enviarProximo();
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

// ─── FLUXOS ───────────────────────────────────────────────────────────────────
app.get('/api/fluxos', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM fluxos ORDER BY id');
    res.json({ ok: true, fluxos: rows });
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

app.put('/api/fluxos/:id', async (req, res) => {
  try {
    const { nome, mensagem, ativo, delay_horas, midia_tipo, midia_url } = req.body;
    await pool.query(
      'UPDATE fluxos SET nome=$1, mensagem=$2, ativo=$3, delay_horas=$4, midia_tipo=$5, midia_url=$6 WHERE id=$7',
      [nome, mensagem, ativo?1:0, delay_horas, midia_tipo||'texto', midia_url||'', req.params.id]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

// ─── CONVERSAS ────────────────────────────────────────────────────────────────
app.get('/api/conversas', async (req, res) => {
  try {
    const { filtro, etiqueta } = req.query;

    let whereExtra = '';
    if (filtro === 'nao_lidas') whereExtra += `
      AND EXISTS (
        SELECT 1 FROM conversas c2
        WHERE c2.telefone = c.telefone
          AND c2.de = 'cliente'
          AND c2.lida = 0
      )`;
    if (filtro === 'clientes') whereExtra += `
      AND EXISTS (
        SELECT 1 FROM conversas c2
        WHERE c2.telefone = c.telefone
          AND c2.de = 'cliente'
      )`;
    if (etiqueta) whereExtra += `
      AND EXISTS (
        SELECT 1 FROM contato_etiquetas ce
        WHERE ce.telefone = c.telefone
          AND ce.etiqueta_id = ${parseInt(etiqueta)}
      )`;

    // ── MELHORIA: inclui mensagens dos últimos 60 dias ─────────────────────────
    const { rows } = await pool.query(`
      SELECT
        c.telefone,
        MAX(
          CASE WHEN c.nome IS NOT NULL AND c.nome <> '' AND c.nome <> 'Cliente' AND c.nome <> 'Madame Ka'
               THEN c.nome ELSE NULL END
        ) AS nome,
        MAX(c.criado_em) AS ultima,
        COUNT(*) AS total,
        COUNT(CASE WHEN c.de = 'cliente' AND c.lida = 0 THEN 1 END) AS nao_lidas,
        MAX(CASE WHEN c.de = 'cliente' THEN c.mensagem END) AS ultima_msg_cliente
      FROM conversas c
      WHERE c.criado_em >= NOW() - INTERVAL '60 days'
      ${whereExtra}
      GROUP BY c.telefone
      ORDER BY MAX(c.criado_em) DESC
      LIMIT 100
    `);
    res.json({ ok: true, conversas: rows });
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

// ── MELHORIA: retorna TODAS as mensagens (cliente + bot) dos últimos 60 dias ──
app.get('/api/conversas/:telefone', async (req, res) => {
  try {
    const tel = normalizarTelefone(req.params.telefone);
    const semDDI = tel.slice(2);
    const { rows } = await pool.query(
      `SELECT * FROM conversas 
       WHERE (telefone=$1 OR telefone=$2)
         AND criado_em >= NOW() - INTERVAL '60 days'
       ORDER BY criado_em ASC`,
      [tel, semDDI]
    );
    res.json({ ok: true, mensagens: rows });
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

app.post('/api/conversas/:telefone/lida', async (req, res) => {
  try {
    const tel = normalizarTelefone(req.params.telefone);
    const semDDI = tel.slice(2);
    await pool.query("UPDATE conversas SET lida=1 WHERE (telefone=$1 OR telefone=$2) AND de='cliente'", [tel, semDDI]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
});

// ── NOVO: apagar conversa manualmente ─────────────────────────────────────────
app.delete('/api/conversas/:telefone', async (req, res) => {
  try {
    const tel = normalizarTelefone(req.params.telefone);
    const semDDI = tel.slice(2);
    const { rows } = await pool.query(
      'DELETE FROM conversas WHERE telefone=$1 OR telefone=$2 RETURNING id',
      [tel, semDDI]
    );
    res.json({ ok: true, apagadas: rows.length });
  } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
});

// ─── ENVIAR MENSAGEM DIRETA ───────────────────────────────────────────────────
app.post('/api/enviar-direto', async (req, res) => {
  try {
    const { telefone, mensagem, template_name } = req.body;
    if (!telefone) return res.json({ ok: false, erro: 'Telefone obrigatório' });
    const tel = normalizarTelefone(telefone);
    let resultado;
    if (template_name) {
      resultado = await wpp.enviarTemplate(tel, template_name, 'pt_BR', [
        { type: 'body', parameters: [{ type: 'text', text: 'Cliente' }] }
      ]);
    } else {
      resultado = await wpp.enviarMensagem(tel, mensagem);
    }
    if (resultado.ok) {
      await pool.query('INSERT INTO conversas (telefone, nome, mensagem, de, lida) VALUES ($1,$2,$3,$4,1)',
        [tel, 'Madame Ka', mensagem || template_name, 'bot']);
    }
    res.json(resultado);
  } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
});

// ── NOVO: enviar áudio via Meta Cloud API ─────────────────────────────────────
const uploadAudio = multer({
  dest: '/tmp/audio/',
  fileFilter: (req, file, cb) => {
    const allowed = ['audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/wav', 'audio/webm'];
    cb(null, allowed.includes(file.mimetype) || file.originalname.match(/\.(ogg|mp3|m4a|aac|wav|webm)$/i) ? true : false);
  }
});

app.post('/api/enviar-audio', uploadAudio.single('audio'), async (req, res) => {
  try {
    const { telefone } = req.body;
    if (!telefone || !req.file) return res.json({ ok: false, erro: 'Telefone e áudio obrigatórios' });
    const tel = normalizarTelefone(telefone);

    // Faz upload do áudio para Cloudinary
    const uploadResult = await cloudinary.uploader.upload(req.file.path, {
      folder: 'madameka-crm/audios',
      resource_type: 'video', // Cloudinary usa 'video' para áudio também
      format: 'mp3'
    });
    fs.unlinkSync(req.file.path);

    const audioUrl = uploadResult.secure_url;

    // Envia via Meta Cloud API
    const META_TOKEN = process.env.META_TOKEN;
    const PHONE_ID = process.env.META_PHONE_ID || '1207148405807761';

    const metaRes = await fetch(`https://graph.facebook.com/v18.0/${PHONE_ID}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${META_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: tel,
        type: 'audio',
        audio: { link: audioUrl }
      })
    });

    const metaData = await metaRes.json();

    if (metaData.messages && metaData.messages[0]) {
      console.log('Audio enviado, salvando conversa:', tel, audioUrl);
      try {
        await pool.query(
          'INSERT INTO conversas (telefone, nome, mensagem, de, lida, midia_url, midia_tipo) VALUES ($1,$2,$3,$4,1,$5,$6)',
          [tel, 'Madame Ka', '🎵 Áudio enviado', 'bot', audioUrl, 'audio']
        );
      } catch(dbErr) {
        console.error('Erro ao salvar audio com midia_url, tentando fallback:', dbErr.message);
        await pool.query(
          'INSERT INTO conversas (telefone, nome, mensagem, de, lida) VALUES ($1,$2,$3,$4,1)',
          [tel, 'Madame Ka', '🎵 Áudio: ' + audioUrl, 'bot']
        );
      }
      res.json({ ok: true, url: audioUrl });
    } else {
      console.error('Meta audio erro:', metaData);
      res.json({ ok: false, erro: metaData.error?.message || 'Erro ao enviar áudio' });
    }
  } catch(e) {
    console.error('Erro enviar audio:', e.message);
    res.status(500).json({ ok: false, erro: e.message });
  }
});

// ─── WEBHOOK YAMPI ────────────────────────────────────────────────────────────
app.post('/webhook/yampi', async (req, res) => {
  res.json({ ok: true });
  try {
    const { event, resource } = req.body;
    const data = resource || req.body.data || req.body;
    const telefoneRaw = (data.customer?.phone || data.phone || '').replace(/\D/g, '');
    const telefone = normalizarTelefone(telefoneRaw);
    const nome = data.customer?.name || data.name || 'Cliente';
    const email = data.customer?.email || data.email || '';
    const nascimento = data.customer?.birthdate || data.birthdate || '';
    if (!telefone) return;
    await pool.query(
      `INSERT INTO contatos (nome,telefone,email,segmento,nascimento) VALUES ($1,$2,$3,'Compradora Ativa',$4)
       ON CONFLICT (telefone) DO UPDATE SET nome=EXCLUDED.nome, segmento='Compradora Ativa', nascimento=COALESCE(NULLIF(EXCLUDED.nascimento,''), contatos.nascimento)`,
      [nome, telefone, email, nascimento]
    );
    if (['order.created','order.approved','payment.approved'].includes(event)) {
      await pool.query('UPDATE contatos SET total_compras=COALESCE(total_compras,0)+1 WHERE telefone=$1', [telefone]);
    }
    const primeiro = nome.split(' ')[0];
    let mensagem = null;
    if (['order.created','order.approved','payment.approved'].includes(event)) {
      const { rows } = await pool.query("SELECT * FROM fluxos WHERE tipo='pos_compra' AND ativo=1");
      if (rows[0]) mensagem = rows[0].mensagem.replace(/{nome}/g, primeiro);
    }
    if (['order.payment_failed','transaction.denied'].includes(event)) {
      mensagem = `Oi ${primeiro}! Vi que houve um problema com o pagamento. Posso te ajudar? 💜`;
    }
    if (['checkout.abandoned','cart.abandoned'].includes(event)) {
      setTimeout(async () => {
        try {
          const { rows: check } = await pool.query("SELECT segmento FROM contatos WHERE telefone=$1", [telefone]);
          if (['Compradora Ativa','VIP','Compradora Recente'].includes(check[0]?.segmento)) return;
          await wpp.enviarTemplate(telefone, 'carrinho_surpresa', 'pt_BR', [
            { type: 'body', parameters: [{ type: 'text', text: primeiro }] }
          ]);
          await pool.query('INSERT INTO disparos (telefone,mensagem,status,enviado_em) VALUES ($1,$2,$3,NOW())',
            [telefone, 'template:carrinho_surpresa', 'enviado']);
          console.log(`Carrinho abandonado -> template enviado para ${telefone}`);
        } catch(e) { console.error('Erro carrinho abandonado:', e.message); }
      }, 1 * 60 * 60 * 1000);
      return;
    }
    if (mensagem) { await new Promise(r => setTimeout(r, 3000)); await wpp.enviarMensagem(telefone, mensagem); }
    if (['order.created','order.approved','payment.approved'].includes(event)) await iniciarSequencia('pos_compra', telefone, nome);
  } catch (e) { console.error('Webhook Yampi erro:', e.message); }
});

// ─── WEBHOOK POPUP ────────────────────────────────────────────────────────────
app.post('/webhook/popup', async (req, res) => {
  res.json({ ok: true });
  try {
    const { nome, whatsapp, email } = req.body;
    if (!whatsapp) return;
    const tel = normalizarTelefone(whatsapp);
    await pool.query(
      `INSERT INTO contatos (nome,telefone,email,segmento,origem) VALUES ($1,$2,$3,'Lead','popup')
       ON CONFLICT (telefone) DO UPDATE SET nome = CASE WHEN contatos.nome = '' OR contatos.nome IS NULL THEN EXCLUDED.nome ELSE contatos.nome END`,
      [nome||'', tel, email||'']
    );
    const { rows: check } = await pool.query('SELECT segmento FROM contatos WHERE telefone=$1', [tel]);
    const jaComprou = ['Compradora Ativa','VIP','Compradora Recente'].includes(check[0]?.segmento);
    const { rows } = await pool.query("SELECT * FROM fluxos WHERE tipo='boas_vindas' AND ativo=1");
    if (rows[0]) {
      await new Promise(r => setTimeout(r, 3000));
      let msg = jaComprou
        ? `Oi ${(nome||'Cliente').split(' ')[0]}! Que bom ter você aqui! 💛\n\nSeja bem-vinda de volta à Madame Ka!\nmadameka.com.br`
        : rows[0].mensagem.replace(/{nome}/g, (nome||'Cliente').split(' ')[0]);
      await wpp.enviarMensagem(tel, msg);
    }
    await iniciarSequencia('boas_vindas', tel, nome||'Cliente');
  } catch (e) { console.error(e); }
});

// ─── SEQUÊNCIAS ───────────────────────────────────────────────────────────────
app.get('/api/sequencias', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM sequencias ORDER BY criado_em DESC');
    for (const s of rows) {
      const { rows: passos } = await pool.query('SELECT * FROM sequencia_passos WHERE sequencia_id=$1 ORDER BY ordem', [s.id]);
      s.passos = passos;
    }
    res.json({ ok: true, sequencias: rows });
  } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
});

app.post('/api/sequencias', async (req, res) => {
  try {
    const { nome, descricao, gatilho, segmento, passos } = req.body;
    const { rows } = await pool.query('INSERT INTO sequencias (nome,descricao,gatilho,segmento) VALUES ($1,$2,$3,$4) RETURNING id', [nome, descricao||'', gatilho, segmento||'todos']);
    const seqId = rows[0].id;
    for (let i = 0; i < passos.length; i++) {
      const p = passos[i];
      await pool.query('INSERT INTO sequencia_passos (sequencia_id,ordem,mensagem,delay_horas,delay_label,midia_tipo,midia_url) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [seqId, i+1, p.mensagem, p.delay_horas, p.delay_label||'', p.midia_tipo||'texto', p.midia_url||'']);
    }
    res.json({ ok: true, id: seqId });
  } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
});

app.put('/api/sequencias/:id', async (req, res) => {
  try {
    const { nome, descricao, gatilho, segmento, ativo, passos } = req.body;
    await pool.query('UPDATE sequencias SET nome=$1,descricao=$2,gatilho=$3,segmento=$4,ativo=$5 WHERE id=$6',
      [nome||'', descricao||'', gatilho||'manual', segmento||'todos', ativo?1:0, req.params.id]);
    if (passos && passos.length > 0) {
      await pool.query('DELETE FROM sequencia_passos WHERE sequencia_id=$1', [req.params.id]);
      for (let i = 0; i < passos.length; i++) {
        const p = passos[i];
        await pool.query('INSERT INTO sequencia_passos (sequencia_id,ordem,mensagem,delay_horas,delay_label,midia_tipo,midia_url) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [req.params.id, i+1, p.mensagem, p.delay_horas, p.delay_label||'', p.midia_tipo||'texto', p.midia_url||'']);
      }
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
});

app.delete('/api/sequencias/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM sequencias WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
});

async function iniciarSequencia(gatilho, telefone, nome) {
  try {
    const tel = normalizarTelefone(telefone);
    const { rows: seqs } = await pool.query('SELECT * FROM sequencias WHERE gatilho=$1 AND ativo=1', [gatilho]);
    for (const seq of seqs) {
      const { rows: passos } = await pool.query('SELECT * FROM sequencia_passos WHERE sequencia_id=$1 ORDER BY ordem', [seq.id]);
      if (!passos.length) continue;
      const { rows: exec } = await pool.query("SELECT id FROM sequencia_execucoes WHERE sequencia_id=$1 AND telefone=$2 AND status='ativo'", [seq.id, tel]);
      if (exec.length) continue;
      const proximo = new Date(Date.now() + (passos[0].delay_horas || 0) * 3600000);
      await pool.query('INSERT INTO sequencia_execucoes (sequencia_id,telefone,passo_atual,status,proximo_envio) VALUES ($1,$2,$3,$4,$5)', [seq.id, tel, 0, 'ativo', proximo]);
      console.log(`Sequencia ${seq.nome} iniciada para ${tel}`);
    }
  } catch(e) { console.error('Erro iniciarSequencia:', e.message); }
}

// ─── UPLOAD MÍDIA ─────────────────────────────────────────────────────────────
const uploadMidia = multer({ dest: '/tmp/midia/' });
app.post('/api/upload', uploadMidia.single('arquivo'), async (req, res) => {
  try {
    const resultado = await cloudinary.uploader.upload(req.file.path, { folder: 'madameka-crm', resource_type: 'auto' });
    fs.unlinkSync(req.file.path);
    res.json({ ok: true, url: resultado.secure_url, tipo: resultado.resource_type === 'video' ? 'video' : 'imagem' });
  } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
});

// ─── CRON ─────────────────────────────────────────────────────────────────────
const cron = require('node-cron');

cron.schedule('* * * * *', async () => {
  try {
    const { rows: execucoes } = await pool.query(`
      SELECT se.*, sp.mensagem, sp.delay_horas, sp.ordem, sp.midia_tipo, sp.midia_url, s.nome as seq_nome, s.gatilho
      FROM sequencia_execucoes se
      JOIN sequencias s ON s.id = se.sequencia_id
      JOIN sequencia_passos sp ON sp.sequencia_id = se.sequencia_id AND sp.ordem = se.passo_atual + 1
      WHERE se.status = 'ativo' AND se.proximo_envio <= NOW()
    `);
    for (const exec of execucoes) {
      try {
        if (['carrinho_abandonado','resposta_carrinho','resposta_leads','resposta_reativacao'].includes(exec.gatilho)) {
          const { rows: check } = await pool.query("SELECT segmento FROM contatos WHERE telefone=$1", [exec.telefone]);
          if (['Compradora Ativa','VIP','Compradora Recente'].includes(check[0]?.segmento)) {
            await pool.query("UPDATE sequencia_execucoes SET status='cancelado' WHERE id=$1", [exec.id]);
            continue;
          }
        }
        const { rows: contato } = await pool.query('SELECT nome FROM contatos WHERE telefone=$1', [exec.telefone]);
        const nome = contato[0]?.nome || 'Cliente';
        const msg = exec.mensagem.replace(/{nome}/g, nome.split(' ')[0]);
        let resultado;
        if (exec.midia_tipo && exec.midia_tipo !== 'texto' && exec.midia_url) {
          resultado = await wpp.enviarMidia(exec.telefone, exec.midia_tipo, exec.midia_url, msg);
        } else {
          resultado = await wpp.enviarMensagem(exec.telefone, msg);
        }
        if (resultado.ok) {
          await pool.query('INSERT INTO conversas (telefone, nome, mensagem, de, lida) VALUES ($1,$2,$3,$4,1)',
            [exec.telefone, 'Madame Ka', msg, 'bot']);
        }
        console.log(`Seq ${exec.seq_nome} passo ${exec.ordem} -> ${exec.telefone}: ${resultado.ok?'OK':'ERRO'}`);
        const { rows: proximo } = await pool.query('SELECT * FROM sequencia_passos WHERE sequencia_id=$1 AND ordem=$2', [exec.sequencia_id, exec.ordem + 1]);
        if (proximo.length) {
          const proximoEnvio = new Date(Date.now() + (proximo[0].delay_horas || 1) * 3600000);
          await pool.query('UPDATE sequencia_execucoes SET passo_atual=$1, proximo_envio=$2 WHERE id=$3', [exec.ordem, proximoEnvio, exec.id]);
        } else {
          await pool.query("UPDATE sequencia_execucoes SET status='concluido', passo_atual=$1 WHERE id=$2", [exec.ordem, exec.id]);
        }
      } catch(e) { console.error('Erro exec:', e.message); }
    }
  } catch(e) { console.error('Erro cron sequencias:', e.message); }
});

cron.schedule('0 12 * * *', async () => {
  try {
    const hoje = new Date();
    const mes = String(hoje.getMonth() + 1).padStart(2, '0');
    const dia = String(hoje.getDate()).padStart(2, '0');
    const { rows } = await pool.query(`
      SELECT c.* FROM contatos c
      WHERE (c.nascimento LIKE $1 OR c.nascimento LIKE $2)
      AND NOT EXISTS (SELECT 1 FROM disparos d WHERE d.telefone = c.telefone AND d.enviado_em >= NOW() - INTERVAL '20 hours' AND d.mensagem LIKE '%aniversario%')
    `, [`%-${mes}-${dia}`, `${dia}/${mes}%`]);
    for (const c of rows) {
      const nome = (c.nome||'Cliente').split(' ')[0];
      const result = await wpp.enviarTemplate(c.telefone, 'aniversario_madameka', 'pt_BR', [
        { type: 'body', parameters: [{ type: 'text', text: nome }] }
      ]);
      if (result.ok) {
        await pool.query('INSERT INTO disparos (telefone,mensagem,status,enviado_em) VALUES ($1,$2,$3,NOW())',
          [c.telefone, 'aniversario_madameka', 'enviado']);
      }
      await new Promise(r => setTimeout(r, 45000));
    }
  } catch(e) { console.error('Erro cron aniversariantes:', e.message); }
});

// ── CRON: limpeza automática de conversas com mais de 60 dias ─────────────────
cron.schedule('0 3 * * *', async () => {
  try {
    const { rows } = await pool.query(
      "DELETE FROM conversas WHERE criado_em < NOW() - INTERVAL '60 days' RETURNING id"
    );
    if (rows.length > 0) console.log(`🧹 Limpeza automática: ${rows.length} mensagens com +60 dias removidas`);
  } catch(e) { console.error('Erro cron limpeza:', e.message); }
});

// ─── CONFIGURAÇÕES ────────────────────────────────────────────────────────────
app.get('/api/config', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM configuracoes');
    const config = {};
    rows.forEach(r => config[r.chave] = r.valor);
    res.json({ ok: true, config });
  } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
});

app.post('/api/config', async (req, res) => {
  try {
    const { chave, valor } = req.body;
    await pool.query('INSERT INTO configuracoes (chave, valor) VALUES ($1,$2) ON CONFLICT (chave) DO UPDATE SET valor=$2, atualizado_em=NOW()', [chave, valor]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
});

// ─── INSTÂNCIAS ───────────────────────────────────────────────────────────────
app.get('/api/instancias', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM instancias ORDER BY id');
    for (const inst of rows) {
      try { await pool.query('UPDATE instancias SET status=$1 WHERE id=$2', ['conectado', inst.id]); inst.status = 'conectado'; }
      catch(e) { inst.status = 'erro'; }
    }
    res.json({ ok: true, instancias: rows });
  } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
});

app.post('/api/instancias', async (req, res) => {
  try {
    const { nome, instance_id, token, client_token } = req.body;
    if (!nome||!instance_id||!token||!client_token) return res.json({ ok: false, erro: 'Preencha todos' });
    const { rows } = await pool.query('INSERT INTO instancias (nome,instance_id,token,client_token) VALUES ($1,$2,$3,$4) RETURNING id', [nome, instance_id, token, client_token]);
    res.json({ ok: true, id: rows[0].id });
  } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
});

app.delete('/api/instancias/:id', async (req, res) => {
  try {
    if (req.params.id === '1') return res.json({ ok: false, erro: 'Não pode excluir a instância principal' });
    await pool.query('DELETE FROM instancias WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
});

// ─── WEBHOOK META ─────────────────────────────────────────────────────────────
app.get('/webhook/meta', (req, res) => {
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (token === 'madameka2026') res.status(200).send(challenge);
  else res.sendStatus(403);
});

app.post('/webhook/meta', async (req, res) => {
  res.sendStatus(200);
  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value;
        for (const msg of value.messages || []) {
          const fromRaw = msg.from;
          const from = normalizarTelefone(fromRaw);
          const text = (msg.text?.body || msg.button?.text || '').toLowerCase().trim();
          if (!text) continue;

          const contato = await buscarContatoPorTelefone(from);
          const nome = contato?.nome || 'Cliente';
          const primeiro = nome.split(' ')[0];

          await pool.query('INSERT INTO conversas (telefone, nome, mensagem, de, lida) VALUES ($1,$2,$3,$4,0)', [from, nome, text, 'cliente']);
          console.log(`Meta webhook: ${from} disse: ${text}`);

          const pareceAutomatica = [
            'aguardando atendimento', 'fora do horário', 'horário de atendimento',
            'mensagem automática', 'resposta automática', 'atendimento automático',
            'obrigada por entrar em contato', 'obrigado por entrar em contato',
            'em breve retornaremos', 'retornaremos em breve', 'será atendido em breve',
            'nossa equipe entrará em contato', 'instagram.com', 'cardápio',
            'acesse nosso site', 'confira nosso', 'dá uma olhadinha'
          ].some(p => text.includes(p));
          if (pareceAutomatica) { console.log(`Msg automática ignorada de ${from}`); continue; }

          const respondeuPositivo = ['sim','quero','ok','surpresa','s','quero minha surpresa','quero ver','pode abrir','quero meu presente'].some(p => text.includes(p));
          if (!respondeuPositivo) continue;

          const { rows: dispLanc } = await pool.query(
            "SELECT id FROM disparos WHERE (telefone=$1 OR telefone=$2) AND (mensagem LIKE '%lancamento%' OR mensagem LIKE '%template:lancamento%') AND enviado_em >= NOW() - INTERVAL '48 hours'",
            [from, from.slice(2)]
          );
          const { rows: dispCarrinho } = await pool.query(
            "SELECT id FROM disparos WHERE (telefone=$1 OR telefone=$2) AND mensagem LIKE '%carrinho_surpresa%' AND enviado_em >= NOW() - INTERVAL '48 hours'",
            [from, from.slice(2)]
          );
          const { rows: dispLeads } = await pool.query(
            "SELECT id FROM disparos WHERE (telefone=$1 OR telefone=$2) AND mensagem LIKE '%leads_surpresa%' AND enviado_em >= NOW() - INTERVAL '48 hours'",
            [from, from.slice(2)]
          );
          const { rows: dispReativacao } = await pool.query(
            "SELECT id FROM disparos WHERE (telefone=$1 OR telefone=$2) AND mensagem LIKE '%reativacao_surpresa%' AND enviado_em >= NOW() - INTERVAL '48 hours'",
            [from, from.slice(2)]
          );

          if (dispLeads.length > 0) {
            const { rows: seqLeads } = await pool.query("SELECT id FROM sequencias WHERE gatilho='resposta_leads' AND ativo=1");
            if (seqLeads.length) {
              await iniciarSequencia('resposta_leads', from, nome);
            } else {
              await new Promise(r => setTimeout(r, 1500));
              await wpp.enviarMensagem(from,
                `Oi ${primeiro}! 🎁 Sua surpresa chegou!\n\nUse o cupom *FERIADO10* e ganhe *10% de desconto* em tudo!\n\n🎀 E nas compras acima de R$299 você ainda ganha um *Relógio surpresa* de brinde!\n\n👗 madameka.com.br\n\n⏰ Válido só hoje!`
              );
              await pool.query('INSERT INTO conversas (telefone, nome, mensagem, de, lida) VALUES ($1,$2,$3,$4,1)',
                [from, 'Madame Ka', 'Mensagem leads_surpresa enviada', 'bot']);
            }
          } else if (dispReativacao.length > 0) {
            const { rows: seqReativ } = await pool.query("SELECT id FROM sequencias WHERE gatilho='resposta_reativacao' AND ativo=1");
            if (seqReativ.length) {
              await iniciarSequencia('resposta_reativacao', from, nome);
            } else {
              await new Promise(r => setTimeout(r, 1500));
              await wpp.enviarMensagem(from,
                `Oi ${primeiro}! Que saudade! 💛\n\nComo você já é nossa cliente, separamos um desconto especial: use o cupom *VIP15* e ganhe *15% de desconto*!\n\n🎀 Compras acima de R$299 também ganham um *Relógio surpresa* de brinde!\n\n👗 madameka.com.br\n\n⏰ Válido só hoje!`
              );
              await pool.query('INSERT INTO conversas (telefone, nome, mensagem, de, lida) VALUES ($1,$2,$3,$4,1)',
                [from, 'Madame Ka', 'Mensagem reativacao_surpresa enviada', 'bot']);
            }
          } else if (dispLanc.length > 0) {
            await iniciarSequencia('resposta_lancamento', from, nome);
            const { rows: seqExiste } = await pool.query("SELECT id FROM sequencias WHERE gatilho='resposta_lancamento' AND ativo=1");
            if (!seqExiste.length) {
              await new Promise(r => setTimeout(r, 1500));
              await wpp.enviarMensagem(from,
                `Oi ${primeiro}! Que alegria! 🎉\n\nHoje é dia de lançamento na Madame Ka e você tem uma surpresa especial:\n\n🎁 Compras acima de R$299 → Ganhe um *Relógio surpresa*!\n💧 Compras acima de R$350 → Ganhe uma *Garrafa exclusiva* no lugar do relógio!\n\nE ainda use o cupom *MADAME12* para ganhar *12% de desconto* em tudo!\n\n👗 madameka.com.br\n\n⏰ Válido somente hoje!`
              );
              await pool.query('INSERT INTO conversas (telefone, nome, mensagem, de, lida) VALUES ($1,$2,$3,$4,1)',
                [from, 'Madame Ka', 'Mensagem lancamento enviada', 'bot']);
            }
          } else if (dispCarrinho.length > 0) {
            const { rows: seqExiste } = await pool.query("SELECT id FROM sequencias WHERE gatilho='resposta_carrinho' AND ativo=1");
            if (seqExiste.length) {
              await iniciarSequencia('resposta_carrinho', from, nome);
            } else {
              await new Promise(r => setTimeout(r, 1500));
              await wpp.enviarMensagem(from,
                `Oi ${primeiro}! 🎁 Sua surpresa chegou!\n\nUse o cupom *MADAME10* e ganhe *10% de desconto*!\n\n✅ Válido só hoje!\n\n👗 madameka.com.br`
              );
              setTimeout(async () => {
                try {
                  const { rows: comprou } = await pool.query("SELECT segmento FROM contatos WHERE telefone=$1", [from]);
                  if (['Compradora Ativa','VIP','Compradora Recente'].includes(comprou[0]?.segmento)) return;
                  await wpp.enviarMensagem(from, `${primeiro}, o cupom *MADAME10* ainda está ativo! ⏰\n\n👗 madameka.com.br`);
                } catch(e) {}
              }, 3 * 3600 * 1000);
              setTimeout(async () => {
                try {
                  const { rows: comprou } = await pool.query("SELECT segmento FROM contatos WHERE telefone=$1", [from]);
                  if (['Compradora Ativa','VIP','Compradora Recente'].includes(comprou[0]?.segmento)) return;
                  await wpp.enviarMensagem(from, `${primeiro}, última chance! 🎀\n\nCupom *BRINDE10* = 10% + brinde surpresa! 🎁\n\n👗 madameka.com.br`);
                } catch(e) {}
              }, 20 * 3600 * 1000);
            }
          }
        }
      }
    }
  } catch(e) { console.error('Webhook Meta erro:', e.message); }
});

app.listen(PORT, () => console.log(`Madame Ka CRM porta ${PORT}`));