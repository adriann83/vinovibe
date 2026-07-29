require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { createClient } = require('@libsql/client');

const app = express();

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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
  `);

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

app.post('/api/vinos', async (req, res) => {
  const { nombre, bodega, region, varietal, anada, precio, stock, tanino, acidez, cuerpo, dulzor, descripcion } = req.body;
  try {
    const result = await db.execute({
      sql: `INSERT INTO vinos (nombre,bodega,region,varietal,anada,precio,stock,tanino,acidez,cuerpo,dulzor,descripcion) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [nombre, bodega, region, varietal, anada, precio, stock, tanino||5, acidez||5, cuerpo||5, dulzor||2, descripcion]
    });
    res.json({ id: Number(result.lastInsertRowid) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/vinos/:id', async (req, res) => {
  try {
    await db.execute({ sql: 'DELETE FROM vinos WHERE id=?', args: [req.params.id] });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/vinos/:id/ficha', async (req, res) => {
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

// ── CLIENTES ───────────────────────────────────────────────────────────────

app.get('/api/clientes', async (req, res) => {
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

app.get('/api/pedidos', async (req, res) => {
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
      await db.execute({ sql: 'UPDATE vinos SET stock=stock-? WHERE id=?', args: [i.cantidad, i.vino_id] });
    }
    res.json({ id: pedidoId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/pedidos/:id/estado', async (req, res) => {
  try {
    await db.execute({ sql: 'UPDATE pedidos SET estado=? WHERE id=?', args: [req.body.estado, req.params.id] });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── STATS ──────────────────────────────────────────────────────────────────

app.get('/api/stats', async (req, res) => {
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

app.post('/api/sommelier', (req, res) => {
  const { perfil, contexto, vinos } = req.body;
  if (!vinos || vinos.length === 0) return res.status(400).json({ error: 'Sin vinos' });

  const scored = vinos.map(v => {
    const diff =
      Math.abs(v.tanino - perfil.tanino) +
      Math.abs(v.acidez - perfil.acidez) +
      Math.abs(v.cuerpo - perfil.cuerpo) +
      Math.abs(v.dulzor - perfil.dulzor);
    const match = Math.round(100 - (diff / 40) * 100);
    return { ...v, match };
  }).sort((a, b) => b.match - a.match);

  const mejor = scored[0];
  const notas = mejor.descripcion || 'Excelente equilibrio y carácter.';
  const ctx = contexto ? ` Ideal para ${contexto}.` : '';
  const razon = `${notas}${ctx} Con un perfil de tanino ${mejor.tanino}/10 y cuerpo ${mejor.cuerpo}/10, es la mejor opción de tu catálogo para este cliente.`;

  const maridajes = {
    'Malbec': 'Carnes rojas, asado, quesos duros',
    'Cabernet Sauvignon': 'Cordero, costillas, pasta con carne',
    'Chardonnay': 'Pollo, pescado, mariscos, pasta con crema',
    'Torrontés': 'Mariscos, comida picante, ensaladas',
    'Blend': 'Carnes rojas, guisos, quesos maduros',
  };
  const maridaje = maridajes[mejor.varietal] || 'Carnes rojas y quesos maduros';

  res.json({
    vino_recomendado: mejor.nombre,
    bodega: mejor.bodega,
    match_porcentaje: Math.max(mejor.match, 60),
    razon,
    maridaje
  });
});

// ── START ────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`✓ VinoVibe en http://localhost:${PORT}`));
  })
  .catch(err => {
    console.error('Error inicializando la base de datos:', err);
    process.exit(1);
  });
