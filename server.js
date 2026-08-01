require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { createClient } = require('@libsql/client');
const Anthropic = require('@anthropic-ai/sdk');
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const app = express();

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.set('trust proxy', 1);
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
  `);

  // Migración: agregar columna foto_url si todavía no existe (para bases ya creadas antes)
  for (const alter of [
    'ALTER TABLE vinos ADD COLUMN foto_url TEXT',
    'ALTER TABLE productos ADD COLUMN foto_url TEXT'
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

app.get('/api/config', (req, res) => {
  res.json({ whatsapp: process.env.VINOTECA_WHATSAPP || null });
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
  const { nombre, categoria, marca, precio, stock, descripcion, foto_url } = req.body;
  if (!nombre || !categoria) return res.status(400).json({ error: 'Nombre y categoría son obligatorios' });
  try {
    const result = await db.execute({
      sql: `INSERT INTO productos (nombre,categoria,marca,precio,stock,descripcion,foto_url) VALUES (?,?,?,?,?,?,?)`,
      args: [nombre, categoria, marca || null, precio || 0, stock || 0, descripcion || null, foto_url || null]
    });
    res.json({ id: Number(result.lastInsertRowid) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/productos/:id', requireAuth, async (req, res) => {
  const { nombre, categoria, marca, precio, stock, descripcion, foto_url } = req.body;
  if (!nombre || !categoria) return res.status(400).json({ error: 'Nombre y categoría son obligatorios' });
  try {
    await db.execute({
      sql: `UPDATE productos SET nombre=?,categoria=?,marca=?,precio=?,stock=?,descripcion=?,foto_url=? WHERE id=?`,
      args: [nombre, categoria, marca || null, precio || 0, stock || 0, descripcion || null, foto_url || null, req.params.id]
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
  const { nombre, email, telefono } = req.body;
  try {
    const result = await db.execute({
      sql: 'INSERT INTO clientes (nombre,email,telefono) VALUES (?,?,?)',
      args: [nombre, email||null, telefono||null]
    });
    res.json({ id: Number(result.lastInsertRowid) });
  } catch (err) {
    res.status(400).json({ error: 'Email ya registrado' });
  }
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

app.post('/api/pedidos', async (req, res) => {
  const { cliente_nombre, items, total, tipo } = req.body;
  try {
    const result = await db.execute({
      sql: 'INSERT INTO pedidos (cliente_nombre,items,total,tipo) VALUES (?,?,?,?)',
      args: [cliente_nombre, JSON.stringify(items), total, tipo||'retiro']
    });
    const pedidoId = Number(result.lastInsertRowid);
    const arr = Array.isArray(items) ? items : JSON.parse(items);
    for (const i of arr) {
      if (i.producto_id) {
        await db.execute({ sql: 'UPDATE productos SET stock=stock-? WHERE id=?', args: [i.cantidad, i.producto_id] });
      } else if (i.vino_id) {
        await db.execute({ sql: 'UPDATE vinos SET stock=stock-? WHERE id=?', args: [i.cantidad, i.vino_id] });
      }
    }
    res.json({ id: pedidoId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/pedidos/:id/estado', requireAuth, async (req, res) => {
  try {
    await db.execute({ sql: 'UPDATE pedidos SET estado=? WHERE id=?', args: [req.body.estado, req.params.id] });
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

app.post('/api/sommelier', async (req, res) => {
  const { perfil, contexto, vinos } = req.body;
  if (!vinos || vinos.length === 0) return res.status(400).json({ error: 'Sin vinos' });
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
      maridaje: 'Carnes rojas y quesos maduros'
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

${contexto ? `LO QUE PIDE EL CLIENTE: "${contexto}"` : 'El cliente no dio un contexto específico, recomendá en base a su perfil de sabor.'}

Elegí el vino MÁS ADECUADO de la lista de arriba (solo de esa lista, usando su id exacto) considerando tanto el perfil de sabor como lo que el cliente pidió. Si mencionó una comida o maridaje, priorizá eso por sobre el perfil numérico.

Respondé ÚNICAMENTE con un objeto JSON válido, sin texto adicional, sin markdown, con este formato exacto:
{"id": <id del vino elegido>, "match_porcentaje": <número entre 60 y 99>, "razon": "<2-3 frases explicando por qué este vino es la mejor opción, mencionando notas de cata reales del vino y el maridaje si corresponde>", "maridaje": "<breve sugerencia de maridaje, 3-6 palabras>"}`;

    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }]
    });

    const textoRespuesta = msg.content.find(b => b.type === 'text')?.text || '{}';
    const limpio = textoRespuesta.replace(/```json|```/g, '').trim();
    const data = JSON.parse(limpio);
    const elegido = vinos.find(v => v.id === data.id);
    if (!elegido) throw new Error('El vino elegido por la IA no está en el catálogo');

    res.json({
      vino_recomendado: elegido.nombre,
      bodega: elegido.bodega,
      match_porcentaje: data.match_porcentaje || 85,
      razon: data.razon || '',
      maridaje: data.maridaje || ''
    });
  } catch (err) {
    console.error('Error en sommelier IA, usando respaldo:', err.message);
    res.json(fallback());
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
