require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { createClient } = require('@libsql/client');
const Anthropic = require('@anthropic-ai/sdk');
const rateLimit = require('express-rate-limit');
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const app = express();

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.set('trust proxy', 1);

// Límite anti-abuso: máximo 15 consultas al Sommelier cada 10 minutos por visitante (por IP).
// Esto no afecta a un cliente normal (nadie hace 15 preguntas seguidas en 10 minutos),
// pero frena a alguien que entra a jugar/spamear el Sommelier sin intención de comprar.
const limiteSommelier = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Hiciste muchas consultas seguidas. Esperá unos minutos y volvé a intentar.' }
});
app.use(session({
  secret: process.env.SESSION_SECRET || 'vinovibe-cambiar-este-secreto',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 1000 * 60 * 60 * 24 * 7, // 7 días
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production'
  }
}));
app.use(express.static(path.join(__dirname, 'public')));

function requireAuth(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  return res.status(401).json({ error: 'No autorizado' });
}

// ── INIT DB ──────────────────────────────────────────────────────────────

async function initDb() {
  await db.executeMultiple(`
    CREATE TABLE IF NOT EXISTS vinos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL, bodega TEXT NOT NULL,
      region TEXT, varietal TEXT, anada INTEGER,
      precio REAL, stock INTEGER DEFAULT 0,
      tanino INTEGER DEFAULT 5, acidez INTEGER DEFAULT 5,
      cuerpo INTEGER DEFAULT 5, dulzor INTEGER DEFAULT 2,
      descripcion TEXT, imagen TEXT
    );
    CREATE TABLE IF NOT EXISTS clientes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL, email TEXT UNIQUE, telefono TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS pedidos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cliente_nombre TEXT, items TEXT, total REAL,
      estado TEXT DEFAULT 'nuevo', tipo TEXT DEFAULT 'retiro',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS productos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL, categoria TEXT NOT NULL, marca TEXT,
      precio REAL, stock INTEGER DEFAULT 0, descripcion TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS admin_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS sommelier_uso (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tipo TEXT,
      fecha DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Migración: agregar columna foto_url si todavía no existe (para bases ya creadas antes)
  for (const alter of [
    'ALTER TABLE vinos ADD COLUMN foto_url TEXT',
    'ALTER TABLE productos ADD COLUMN foto_url TEXT',
    'ALTER TABLE productos ADD COLUMN ficha_pdf_url TEXT',
    'ALTER TABLE pedidos ADD COLUMN metodo_pago TEXT',
    'ALTER TABLE pedidos ADD COLUMN telefono TEXT',
    'ALTER TABLE pedidos ADD COLUMN direccion TEXT',
    'ALTER TABLE productos ADD COLUMN tipo TEXT DEFAULT \'gourmet\'',
    'ALTER TABLE clientes ADD COLUMN direccion TEXT'
  ]) {
    try { await db.execute(alter); } catch (e) { /* ya existe, la ignoramos */ }
  }

  // Crear el usuario admin inicial si no existe ninguno (usando ADMIN_USERNAME / ADMIN_PASSWORD del .env)
  const adminCount = await db.execute('SELECT COUNT(*) as c FROM admin_users');
  if (Number(adminCount.rows[0].c) === 0) {
    const username = process.env.ADMIN_USERNAME || 'admin';
    const password = process.env.ADMIN_PASSWORD || 'vinovibe123';
    const hash = await bcrypt.hash(password, 10);
    await db.execute({ sql: 'INSERT INTO admin_users (username, password_hash) VALUES (?,?)', args: [username, hash] });
    console.log(`✓ Usuario admin creado: "${username}" (cambiá la contraseña en .env con ADMIN_USERNAME / ADMIN_PASSWORD)`);
  }

  const countResult = await db.execute('SELECT COUNT(*) as c FROM vinos');
  const count = Number(countResult.rows[0].c);
  if (count > 0) return;

  const ins = `INSERT INTO vinos (nombre,bodega,region,varietal,anada,precio,stock,tanino,acidez,cuerpo,dulzor,descripcion) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`;
  const seed = [
    ['Malbec Reserva','Achaval Ferrer','Mendoza','Malbec',2021,3200,48,7,5,8,2,'Frutos negros, tabaco y chocolate amargo.'],
    ['Valle de Uco','Zuccardi','Mendoza','Malbec',2022,4800,12,8,6,9,1,'Complejo y elegante. Notas minerales.'],
    ['Chardonnay','Catena Zapata','Mendoza','Chardonnay',2022,2900,24,2,7,6,3,'Fresco y frutal. Notas de durazno.'],
    ['Clos de los Siete','Michel Rolland','Tunuyán','Blend',2021,5400,18,7,5,8,2,'Blend potente y equilibrado.'],
    ['Torrontés Premium','Alta Vista','Salta','Torrontés',2023,2100,30,2,8,5,4,'Aromático y floral.'],
    ['Cabernet Sauvignon','Norton','Mendoza','Cabernet',2020,3800,20,9,6,9,1,'Taninos firmes, frutos negros.'],
  ];
  for (const args of seed) {
    await db.execute({ sql: ins, args });
  }
}

// ── CONFIG PÚBLICA ───────────────────────────────────────────────────────

// Registra cada consulta al Sommelier IA (para medir uso mensual por vinoteca)
async function registrarUsoSommelier(tipo) {
  try {
    await db.execute({ sql: 'INSERT INTO sommelier_uso (tipo) VALUES (?)', args: [tipo] });
  } catch (e) { console.error('No se pudo registrar uso del sommelier:', e.message); }
}

// Limpia asteriscos/guiones bajos de Markdown que la IA a veces agrega, aunque le pidamos texto plano
function limpiarMarkdown(texto) {
  if (!texto) return texto;
  return texto.replace(/\*\*(.*?)\*\*/g, '$1').replace(/\*(.*?)\*/g, '$1').replace(/__(.*?)__/g, '$1');
}

app.get('/api/config', (req, res) => {
  res.json({
    whatsapp: process.env.VINOTECA_WHATSAPP || null,
    alias_transferencia: process.env.VINOTECA_ALIAS || null,
    cbu_transferencia: process.env.VINOTECA_CBU || null,
    titular_transferencia: process.env.VINOTECA_TITULAR || null
  });
});

// ── AUTENTICACIÓN ────────────────────────────────────────────────────────

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.post('/api/admin/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const result = await db.execute({ sql: 'SELECT * FROM admin_users WHERE username=?', args: [username] });
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    req.session.isAdmin = true;
    req.session.username = username;
    res.json({ ok: true, username });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/admin/check', (req, res) => {
  res.json({ isAdmin: !!(req.session && req.session.isAdmin), username: req.session?.username || null });
});

// ── VINOS ──────────────────────────────────────────────────────────────────

app.get('/api/vinos', async (req, res) => {
  try {
    const result = await db.execute('SELECT * FROM vinos');
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/vinos/:id', async (req, res) => {
  try {
    const result = await db.execute({ sql: 'SELECT * FROM vinos WHERE id=?', args: [req.params.id] });
    const v = result.rows[0];
    if (!v) return res.status(404).json({ error: 'No encontrado' });
    try { v.extra = JSON.parse(v.imagen || '{}'); } catch { v.extra = {}; }
    res.json(v);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/vinos', requireAuth, async (req, res) => {
  const { nombre, bodega, region, varietal, anada, precio, stock, tanino, acidez, cuerpo, dulzor, descripcion, foto_url } = req.body;
  try {
    const result = await db.execute({
      sql: `INSERT INTO vinos (nombre,bodega,region,varietal,anada,precio,stock,tanino,acidez,cuerpo,dulzor,descripcion,foto_url) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [nombre, bodega, region, varietal, anada, precio, stock, tanino||5, acidez||5, cuerpo||5, dulzor||2, descripcion, foto_url || null]
    });
    res.json({ id: Number(result.lastInsertRowid) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/vinos/:id', requireAuth, async (req, res) => {
  try {
    await db.execute({ sql: 'DELETE FROM vinos WHERE id=?', args: [req.params.id] });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/vinos/:id', requireAuth, async (req, res) => {
  const { nombre, bodega, region, varietal, anada, precio, stock, tanino, acidez, cuerpo, dulzor, descripcion, foto_url } = req.body;
  try {
    await db.execute({
      sql: `UPDATE vinos SET nombre=?,bodega=?,region=?,varietal=?,anada=?,precio=?,stock=?,tanino=?,acidez=?,cuerpo=?,dulzor=?,descripcion=?,foto_url=? WHERE id=?`,
      args: [nombre, bodega, region, varietal, anada, precio, stock, tanino||5, acidez||5, cuerpo||5, dulzor||2, descripcion, foto_url || null, req.params.id]
    });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/vinos/:id/ficha', requireAuth, async (req, res) => {
  const { historia_bodega, notas_enologo, maridaje, temperatura, decantacion } = req.body;
  const extra = JSON.stringify({ historia_bodega, maridaje, temperatura, decantacion });
  try {
    await db.execute({
      sql: `UPDATE vinos SET descripcion=?, imagen=? WHERE id=?`,
      args: [notas_enologo, extra, req.params.id]
    });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── PRODUCTOS (aceites, aceitunas, otros) ───────────────────────────────────

app.get('/api/productos', async (req, res) => {
  try {
    const result = await db.execute('SELECT * FROM productos ORDER BY categoria, nombre');
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/productos', requireAuth, async (req, res) => {
  const { nombre, categoria, marca, precio, stock, descripcion, foto_url, ficha_pdf_url, tipo } = req.body;
  if (!nombre || !categoria) return res.status(400).json({ error: 'Nombre y categoría son obligatorios' });
  try {
    const result = await db.execute({
      sql: `INSERT INTO productos (nombre,categoria,marca,precio,stock,descripcion,foto_url,ficha_pdf_url,tipo) VALUES (?,?,?,?,?,?,?,?,?)`,
      args: [nombre, categoria, marca || null, precio || 0, stock || 0, descripcion || null, foto_url || null, ficha_pdf_url || null, tipo || 'gourmet']
    });
    res.json({ id: Number(result.lastInsertRowid) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/productos/:id', requireAuth, async (req, res) => {
  const { nombre, categoria, marca, precio, stock, descripcion, foto_url, ficha_pdf_url, tipo } = req.body;
  if (!nombre || !categoria) return res.status(400).json({ error: 'Nombre y categoría son obligatorios' });
  try {
    await db.execute({
      sql: `UPDATE productos SET nombre=?,categoria=?,marca=?,precio=?,stock=?,descripcion=?,foto_url=?,ficha_pdf_url=?,tipo=? WHERE id=?`,
      args: [nombre, categoria, marca || null, precio || 0, stock || 0, descripcion || null, foto_url || null, ficha_pdf_url || null, tipo || 'gourmet', req.params.id]
    });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/productos/:id', requireAuth, async (req, res) => {
  try {
    await db.execute({ sql: 'DELETE FROM productos WHERE id=?', args: [req.params.id] });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── CLIENTES ───────────────────────────────────────────────────────────────

app.get('/api/clientes', requireAuth, async (req, res) => {
  try {
    const result = await db.execute('SELECT * FROM clientes ORDER BY nombre');
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/clientes', async (req, res) => {
  const { nombre, email, telefono, direccion } = req.body;
  try {
    const result = await db.execute({
      sql: 'INSERT INTO clientes (nombre,email,telefono,direccion) VALUES (?,?,?,?)',
      args: [nombre, email||null, telefono||null, direccion||null]
    });
    res.json({ id: Number(result.lastInsertRowid) });
  } catch (err) {
    res.status(400).json({ error: 'Email ya registrado' });
  }
});

app.put('/api/clientes/:id', requireAuth, async (req, res) => {
  const { nombre, email, telefono, direccion } = req.body;
  try {
    await db.execute({
      sql: 'UPDATE clientes SET nombre=?, email=?, telefono=?, direccion=? WHERE id=?',
      args: [nombre, email||null, telefono||null, direccion||null, req.params.id]
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: 'No se pudo actualizar (¿email duplicado?)' });
  }
});

// Registra (o actualiza si ya existe por nombre) un cliente a partir de los datos de un pedido,
// para no tener que volver a tipear nombre/teléfono/dirección a mano en la pestaña Clientes.
app.post('/api/clientes/desde-pedido', requireAuth, async (req, res) => {
  const { nombre, telefono, direccion } = req.body;
  if (!nombre) return res.status(400).json({ error: 'Falta el nombre' });
  try {
    const existente = await db.execute({
      sql: 'SELECT id FROM clientes WHERE LOWER(nombre)=LOWER(?)',
      args: [nombre]
    });
    if (existente.rows.length) {
      const id = existente.rows[0].id;
      await db.execute({
        sql: 'UPDATE clientes SET telefono=COALESCE(?,telefono), direccion=COALESCE(?,direccion) WHERE id=?',
        args: [telefono || null, direccion || null, id]
      });
      return res.json({ id, actualizado: true });
    }
    const result = await db.execute({
      sql: 'INSERT INTO clientes (nombre,telefono,direccion) VALUES (?,?,?)',
      args: [nombre, telefono || null, direccion || null]
    });
    res.json({ id: Number(result.lastInsertRowid), actualizado: false });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/clientes/:nombre/historial', async (req, res) => {
  const nombre = decodeURIComponent(req.params.nombre);
  try {
    const result = await db.execute({
      sql: `SELECT * FROM pedidos WHERE LOWER(cliente_nombre) LIKE LOWER(?) ORDER BY created_at DESC`,
      args: ['%' + nombre + '%']
    });
    const pedidos = result.rows;
    const total = pedidos.reduce((s, p) => s + (p.total || 0), 0);
    res.json({ pedidos, total_gastado: total, cantidad_pedidos: pedidos.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── PEDIDOS ────────────────────────────────────────────────────────────────

app.get('/api/pedidos', requireAuth, async (req, res) => {
  try {
    const result = await db.execute('SELECT * FROM pedidos ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/sommelier-uso', requireAuth, async (req, res) => {
  try {
    const porTipo = await db.execute(
      `SELECT tipo, COUNT(*) as cantidad FROM sommelier_uso WHERE fecha >= date('now','start of month') GROUP BY tipo`
    );
    const totalRes = await db.execute(
      `SELECT COUNT(*) as total FROM sommelier_uso WHERE fecha >= date('now','start of month')`
    );
    res.json({ porTipo: porTipo.rows, total: Number(totalRes.rows[0]?.total || 0) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/pedidos', async (req, res) => {
  const { cliente_nombre, telefono, direccion, items, total, tipo } = req.body;
  try {
    const result = await db.execute({
      sql: 'INSERT INTO pedidos (cliente_nombre,telefono,direccion,items,total,tipo,estado,metodo_pago) VALUES (?,?,?,?,?,?,?,?)',
      args: [cliente_nombre, telefono||null, direccion||null, JSON.stringify(items), total, tipo||'retiro', 'pendiente_pago', 'transferencia']
    });
    const pedidoId = Number(result.lastInsertRowid);
    // El stock ya NO se descuenta acá. Se descuenta recién cuando el pedido pasa a "pagado"
    // (ver PUT /api/pedidos/:id/estado), así no se reserva stock de pedidos que nunca se pagan.
    res.json({ id: pedidoId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/pedidos/:id/estado', requireAuth, async (req, res) => {
  const nuevoEstado = req.body.estado;
  try {
    const actual = await db.execute({ sql: 'SELECT estado, items FROM pedidos WHERE id=?', args: [req.params.id] });
    const pedido = actual.rows[0];
    if (!pedido) return res.status(404).json({ error: 'Pedido no encontrado' });

    // Descontar stock recién al confirmar el pago (evita reservar stock de pedidos nunca pagados)
    if (nuevoEstado === 'pagado' && pedido.estado !== 'pagado') {
      const items = JSON.parse(pedido.items || '[]');
      for (const i of items) {
        if (i.producto_id) {
          await db.execute({ sql: 'UPDATE productos SET stock=stock-? WHERE id=?', args: [i.cantidad, i.producto_id] });
        } else if (i.vino_id) {
          await db.execute({ sql: 'UPDATE vinos SET stock=stock-? WHERE id=?', args: [i.cantidad, i.vino_id] });
        }
      }
    }

    await db.execute({ sql: 'UPDATE pedidos SET estado=? WHERE id=?', args: [nuevoEstado, req.params.id] });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── STATS ──────────────────────────────────────────────────────────────────

app.get('/api/stats', requireAuth, async (req, res) => {
  try {
    const stats = {};

    const vinosR = await db.execute('SELECT COUNT(*) as c FROM vinos');
    stats.totalVinos = Number(vinosR.rows[0].c);

    const clientesR = await db.execute('SELECT COUNT(*) as c FROM clientes');
    stats.totalClientes = Number(clientesR.rows[0].c);

    const pedidosHoyR = await db.execute("SELECT COUNT(*) as c FROM pedidos WHERE date(created_at)=date('now')");
    stats.pedidosHoy = Number(pedidosHoyR.rows[0].c);

    const ventasHoyR = await db.execute("SELECT SUM(total) as t FROM pedidos WHERE date(created_at)=date('now')");
    stats.ventasHoy = ventasHoyR.rows[0].t || 0;

    const stockBajoR = await db.execute('SELECT * FROM vinos WHERE stock<10');
    stats.stockBajo = stockBajoR.rows;

    res.json(stats);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── SOMMELIER ──────────────────────────────────────────────────────────────

// ── PREGUNTA DE SEGUIMIENTO SOBRE UN VINO YA RECOMENDADO ──
app.post('/api/sommelier/pregunta-vino', limiteSommelier, async (req, res) => {
  const { vino, pregunta } = req.body;
  if (!vino || !pregunta) return res.status(400).json({ error: 'Faltan datos' });
  registrarUsoSommelier('pregunta_vino');
  try {
    const prompt = `Sos un sommelier experto. Un cliente ya eligió este vino de nuestro catálogo:

Vino: ${vino.nombre || vino.vino_recomendado} (${vino.bodega})
Varietal: ${vino.varietal || '-'}
Notas: ${vino.descripcion || vino.razon || 'sin notas adicionales'}
Perfil de sabor: Tanino ${vino.tanino ?? '-'}, Acidez ${vino.acidez ?? '-'}, Cuerpo ${vino.cuerpo ?? '-'}, Dulzor ${vino.dulzor ?? '-'}

El cliente pregunta específicamente sobre este vino: "${pregunta}"

Respondé de forma breve, cálida y concreta (máximo 3-4 frases). Si pregunta por maridaje o con qué comida acompañarlo, sugerí 2-3 platos concretos. No hables de otros vinos del catálogo, solo de este. Respondé en texto plano, SIN usar formato Markdown (nada de asteriscos, guiones bajos ni símbolos de negrita/cursiva).`;

    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }]
    });
    let respuesta = msg.content.find(b => b.type === 'text')?.text || 'No pude generar una respuesta, probá de nuevo.';
    respuesta = limpiarMarkdown(respuesta);
    res.json({ respuesta });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sommelier', limiteSommelier, async (req, res) => {
  const { perfil, contexto, preferenciasGenerales, vinos } = req.body;
  if (!vinos || vinos.length === 0) return res.status(400).json({ error: 'Sin vinos' });
  registrarUsoSommelier('vino');
  const p = perfil || { tanino: 5, acidez: 5, cuerpo: 5, dulzor: 5 };

  const fallback = () => {
    const scored = vinos.map(v => {
      const diff = Math.abs(v.tanino - p.tanino) + Math.abs(v.acidez - p.acidez) + Math.abs(v.cuerpo - p.cuerpo) + Math.abs(v.dulzor - p.dulzor);
      return { ...v, match: Math.max(60, Math.round(100 - (diff / 40) * 100)) };
    }).sort((a, b) => b.match - a.match);
    const mejor = scored[0];
    return {
      vino_recomendado: mejor.nombre,
      bodega: mejor.bodega,
      match_porcentaje: mejor.match,
      razon: mejor.descripcion || 'Buena opción de nuestro catálogo para tu perfil.',
      maridaje: ['Carnes rojas', 'Quesos maduros']
    };
  };

  try {
    const catalogoTexto = vinos.map(v =>
      `- id:${v.id} | ${v.nombre} (${v.bodega}) | Varietal: ${v.varietal || '-'} | Tanino:${v.tanino} Acidez:${v.acidez} Cuerpo:${v.cuerpo} Dulzor:${v.dulzor} | Stock:${v.stock} | Notas: ${v.descripcion || 'sin notas'}`
    ).join('\n');

    const prompt = `Sos un sommelier experto ayudando a elegir el mejor vino de este catálogo específico para un cliente.

CATÁLOGO DISPONIBLE:
${catalogoTexto}

PERFIL DE SABOR DEL CLIENTE (escala 1-10): tanino ${p.tanino}, acidez ${p.acidez}, cuerpo ${p.cuerpo}, dulzor ${p.dulzor}

${preferenciasGenerales ? `PREFERENCIA GENERAL DEL CLIENTE (lo que suele tomar habitualmente, NO es el pedido de hoy): ${preferenciasGenerales}` : ''}

${contexto ? `LO QUE PIDE EL CLIENTE HOY, EN ESTE MOMENTO: "${contexto}"` : 'El cliente no dio un pedido específico para hoy, recomendá en base a su perfil de sabor y preferencia general.'}

Elegí hasta 3 vinos ADECUADOS de la lista de arriba (solo de esa lista, usando su id exacto), ordenados del más al menos recomendado. IMPORTANTE: si "lo que pide el cliente hoy" menciona una comida o un maridaje concreto, ese pedido puntual tiene PRIORIDAD ABSOLUTA por sobre el perfil numérico y por sobre la preferencia general — la preferencia general solo sirve de referencia cuando el cliente no especificó nada puntual hoy. Por ejemplo, si el cliente suele tomar tintos pero hoy pide algo para acompañar un pescado, recomendá lo que mejor acompañe el pescado, no un tinto por costumbre. Si el catálogo tiene menos de 3 vinos que realmente encajen bien, devolvé menos (no fuerces opciones malas).

Respondé ÚNICAMENTE con un array JSON válido, sin texto adicional, sin markdown, con este formato exacto:
[{"id": <id del vino>, "match_porcentaje": <número entre 60 y 99>, "razon": "<2-3 frases explicando por qué este vino es una buena opción, mencionando notas de cata reales del vino y el maridaje si corresponde>", "maridaje": ["<sugerencia 1, 2-4 palabras>", "<sugerencia 2, 2-4 palabras>", "<sugerencia 3, 2-4 palabras>"]}]

El campo "maridaje" tiene que ser un array de 2 a 3 sugerencias distintas y breves (por ejemplo ["Asado", "Quesos duros", "Picadas"]), no una sola frase larga.`;

    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 700,
      messages: [{ role: 'user', content: prompt }]
    });

    const textoRespuesta = msg.content.find(b => b.type === 'text')?.text || '[]';
    const limpio = textoRespuesta.replace(/```json|```/g, '').trim();
    const data = JSON.parse(limpio);
    const lista = Array.isArray(data) ? data : [data];

    const recomendaciones = lista
      .map(item => {
        const v = vinos.find(x => x.id === item.id);
        if (!v) return null;
        return {
          id: v.id,
          vino_recomendado: v.nombre,
          bodega: v.bodega,
          precio: v.precio,
          foto_url: v.foto_url || null,
          match_porcentaje: item.match_porcentaje || 85,
          razon: limpiarMarkdown(item.razon) || '',
          maridaje: Array.isArray(item.maridaje) ? item.maridaje : (item.maridaje ? [item.maridaje] : [])
        };
      })
      .filter(Boolean);

    if (!recomendaciones.length) throw new Error('La IA no eligió ningún vino válido del catálogo');

    // Se mantienen estos campos sueltos por compatibilidad con pantallas que esperan un solo resultado
    res.json({
      recomendaciones,
      vino_recomendado: recomendaciones[0].vino_recomendado,
      bodega: recomendaciones[0].bodega,
      match_porcentaje: recomendaciones[0].match_porcentaje,
      razon: recomendaciones[0].razon,
      maridaje: recomendaciones[0].maridaje
    });
  } catch (err) {
    console.error('Error en sommelier IA, usando respaldo:', err.message);
    const f = fallback();
    res.json({ recomendaciones: [{ ...f, foto_url: (vinos.find(v => v.nombre === f.vino_recomendado) || {}).foto_url || null }], ...f });
  }
});

// ── SOMMELIER DE PRODUCTOS (aceites, vinagres, aceitunas) ──────────────────

app.post('/api/sommelier-productos', limiteSommelier, async (req, res) => {
  const { contexto, productos } = req.body;
  if (!productos || productos.length === 0) return res.status(400).json({ error: 'Sin productos' });
  registrarUsoSommelier('producto');

  const fallback = () => {
    const disponibles = productos.filter(p => (p.stock || 0) > 0);
    const base = disponibles.length ? disponibles : productos;
    const elegido = base[Math.floor(Math.random() * base.length)];
    return {
      producto_recomendado: elegido.nombre,
      marca: elegido.marca,
      match_porcentaje: 70,
      razon: elegido.descripcion || 'Buena opción de nuestro catálogo.',
      uso_sugerido: 'Ideal como aderezo o acompañamiento'
    };
  };

  try {
    const catalogoTexto = productos.map(p =>
      `- id:${p.id} | ${p.nombre} (${p.marca || 'sin marca'}) | Categoría: ${p.categoria || '-'} | Stock:${p.stock} | Descripción: ${p.descripcion || 'sin notas'}`
    ).join('\n');

    const prompt = `Sos un sommelier experto en aceites de oliva, vinagres balsámicos y productos gourmet, ayudando a elegir el mejor producto de este catálogo específico para un cliente.

CATÁLOGO DISPONIBLE:
${catalogoTexto}

${contexto ? `LO QUE PIDE EL CLIENTE: "${contexto}"` : 'El cliente no dio un contexto específico, recomendá los productos más versátiles o destacados del catálogo.'}

Elegí hasta 3 productos ADECUADOS de la lista de arriba (solo de esa lista, usando su id exacto), ordenados del más al menos recomendado, considerando lo que el cliente pidió (plato, uso, tipo de sabor buscado, etc.) y las notas de cata/descripción de cada producto. Si el catálogo tiene menos de 3 productos que realmente encajen bien, devolvé menos (no fuerces opciones malas).

Respondé ÚNICAMENTE con un array JSON válido, sin texto adicional, sin markdown, con este formato exacto:
[{"id": <id del producto>, "match_porcentaje": <número entre 60 y 99>, "razon": "<2-3 frases explicando por qué este producto es una buena opción, mencionando notas de sabor reales del producto>", "uso_sugerido": "<breve sugerencia de uso o maridaje, 3-6 palabras>"}]`;

    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 700,
      messages: [{ role: 'user', content: prompt }]
    });

    const textoRespuesta = msg.content.find(b => b.type === 'text')?.text || '[]';
    const limpio = textoRespuesta.replace(/```json|```/g, '').trim();
    const data = JSON.parse(limpio);
    const lista = Array.isArray(data) ? data : [data];

    const recomendaciones = lista
      .map(item => {
        const p = productos.find(x => x.id === item.id);
        if (!p) return null;
        return {
          id: p.id,
          producto_recomendado: p.nombre,
          marca: p.marca,
          categoria: p.categoria,
          precio: p.precio,
          foto_url: p.foto_url || null,
          match_porcentaje: item.match_porcentaje || 85,
          razon: limpiarMarkdown(item.razon) || '',
          uso_sugerido: item.uso_sugerido || ''
        };
      })
      .filter(Boolean);

    if (!recomendaciones.length) throw new Error('La IA no eligió ningún producto válido del catálogo');

    // Se mantienen estos campos sueltos por compatibilidad con pantallas que esperan un solo resultado
    res.json({
      recomendaciones,
      producto_recomendado: recomendaciones[0].producto_recomendado,
      marca: recomendaciones[0].marca,
      match_porcentaje: recomendaciones[0].match_porcentaje,
      razon: recomendaciones[0].razon,
      uso_sugerido: recomendaciones[0].uso_sugerido
    });
  } catch (err) {
    console.error('Error en sommelier de productos IA, usando respaldo:', err.message);
    const f = fallback();
    res.json({ recomendaciones: [{ ...f, foto_url: (productos.find(p => p.nombre === f.producto_recomendado) || {}).foto_url || null }], ...f });
  }
});

// ── BARTENDER IA (whisky, vermut, aperitivos, fernet, etc.) ──
app.post('/api/bartender', limiteSommelier, async (req, res) => {
  const { contexto, bebidas } = req.body;
  if (!bebidas || bebidas.length === 0) return res.status(400).json({ error: 'Sin bebidas' });
  registrarUsoSommelier('bartender');

  const fallback = () => {
    const disponibles = bebidas.filter(b => (b.stock || 0) > 0);
    const base = disponibles.length ? disponibles : bebidas;
    const elegido = base[Math.floor(Math.random() * base.length)];
    return {
      producto_recomendado: elegido.nombre,
      marca: elegido.marca,
      match_porcentaje: 70,
      razon: elegido.descripcion || 'Buena opción de nuestra barra.',
      uso_sugerido: 'Ideal solo o en las rocas'
    };
  };

  try {
    const catalogoTexto = bebidas.map(b =>
      `- id:${b.id} | ${b.nombre} (${b.marca || 'sin marca'}) | Categoría: ${b.categoria || '-'} | Stock:${b.stock} | Notas: ${b.descripcion || 'sin notas'}`
    ).join('\n');

    const prompt = `Sos un bartender experto ayudando a elegir la mejor bebida de esta barra específica para un cliente.

BARRA DISPONIBLE:
${catalogoTexto}

${contexto ? `LO QUE PIDE EL CLIENTE: "${contexto}"` : 'El cliente no dio un contexto específico, recomendá las bebidas más versátiles o destacadas de la barra.'}

Elegí hasta 3 bebidas ADECUADAS de la lista de arriba (solo de esa lista, usando su id exacto), ordenadas de la más a la menos recomendada, considerando el momento/ocasión que describió el cliente (para tomar solo, para compartir, para un trago largo, etc.) y las notas reales de cada bebida. Si el cliente pide un trago mezclado (ej. "gin tonic", "fernet con cola"), recomendá la bebida base de la barra que mejor sirva para prepararlo, aclarando en la razón que el resto de los ingredientes (hielo, gaseosa, limón, etc.) no forman parte del catálogo. Si la barra tiene menos de 3 bebidas que realmente encajen bien, devolvé menos (no fuerces opciones malas).

Respondé ÚNICAMENTE con un array JSON válido, sin texto adicional, sin markdown, con este formato exacto:
[{"id": <id de la bebida>, "match_porcentaje": <número entre 60 y 99>, "razon": "<2-3 frases explicando por qué esta bebida es una buena opción, mencionando notas reales de la bebida>", "uso_sugerido": "<breve sugerencia de cómo tomarla, 3-6 palabras>"}]`;

    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 700,
      messages: [{ role: 'user', content: prompt }]
    });

    const textoRespuesta = msg.content.find(b => b.type === 'text')?.text || '[]';
    const limpio = textoRespuesta.replace(/```json|```/g, '').trim();
    const data = JSON.parse(limpio);
    const lista = Array.isArray(data) ? data : [data];

    const recomendaciones = lista
      .map(item => {
        const b = bebidas.find(x => x.id === item.id);
        if (!b) return null;
        return {
          id: b.id,
          producto_recomendado: b.nombre,
          marca: b.marca,
          categoria: b.categoria,
          precio: b.precio,
          foto_url: b.foto_url || null,
          match_porcentaje: item.match_porcentaje || 85,
          razon: limpiarMarkdown(item.razon) || '',
          uso_sugerido: item.uso_sugerido || ''
        };
      })
      .filter(Boolean);

    if (!recomendaciones.length) throw new Error('La IA no eligió ninguna bebida válida de la barra');

    res.json({
      recomendaciones,
      producto_recomendado: recomendaciones[0].producto_recomendado,
      marca: recomendaciones[0].marca,
      match_porcentaje: recomendaciones[0].match_porcentaje,
      razon: recomendaciones[0].razon,
      uso_sugerido: recomendaciones[0].uso_sugerido
    });
  } catch (err) {
    console.error('Error en el Bartender IA, usando respaldo:', err.message);
    const f = fallback();
    res.json({ recomendaciones: [{ ...f, foto_url: (bebidas.find(b => b.nombre === f.producto_recomendado) || {}).foto_url || null }], ...f });
  }
});

const PORT = process.env.PORT || 3000;
initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`✓ VinoVibe en http://localhost:${PORT}`));
  })
  .catch(err => {
    console.error('Error inicializando la base de datos:', err);
    process.exit(1);
  });
