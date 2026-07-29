const express = require('express');
const cors = require('cors');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const app = express();
const db = new sqlite3.Database('./vinovibe.db');

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Helper para serializar operaciones de init
db.serialize(() => {
  db.exec(`
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
  `, (err) => {
    if (err) { console.error('Error creando tablas:', err); return; }

    db.get('SELECT COUNT(*) as c FROM vinos', [], (err, row) => {
      if (err || row.c > 0) return;

      const ins = `INSERT INTO vinos (nombre,bodega,region,varietal,anada,precio,stock,tanino,acidez,cuerpo,dulzor,descripcion) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`;
      db.run(ins, ['Malbec Reserva','Achaval Ferrer','Mendoza','Malbec',2021,3200,48,7,5,8,2,'Frutos negros, tabaco y chocolate amargo.']);
      db.run(ins, ['Valle de Uco','Zuccardi','Mendoza','Malbec',2022,4800,12,8,6,9,1,'Complejo y elegante. Notas minerales.']);
      db.run(ins, ['Chardonnay','Catena Zapata','Mendoza','Chardonnay',2022,2900,24,2,7,6,3,'Fresco y frutal. Notas de durazno.']);
      db.run(ins, ['Clos de los Siete','Michel Rolland','Tunuyán','Blend',2021,5400,18,7,5,8,2,'Blend potente y equilibrado.']);
      db.run(ins, ['Torrontés Premium','Alta Vista','Salta','Torrontés',2023,2100,30,2,8,5,4,'Aromático y floral.']);
      db.run(ins, ['Cabernet Sauvignon','Norton','Mendoza','Cabernet',2020,3800,20,9,6,9,1,'Taninos firmes, frutos negros.']);
    });
  });
});

// ── VINOS ──────────────────────────────────────────────────────────────────

app.get('/api/vinos', (req, res) => {
  db.all('SELECT * FROM vinos', [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.get('/api/vinos/:id', (req, res) => {
  db.get('SELECT * FROM vinos WHERE id=?', [req.params.id], (err, v) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!v) return res.status(404).json({ error: 'No encontrado' });
    try { v.extra = JSON.parse(v.imagen || '{}'); } catch { v.extra = {}; }
    res.json(v);
  });
});

app.post('/api/vinos', (req, res) => {
  const { nombre, bodega, region, varietal, anada, precio, stock, tanino, acidez, cuerpo, dulzor, descripcion } = req.body;
  db.run(
    `INSERT INTO vinos (nombre,bodega,region,varietal,anada,precio,stock,tanino,acidez,cuerpo,dulzor,descripcion) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [nombre, bodega, region, varietal, anada, precio, stock, tanino||5, acidez||5, cuerpo||5, dulzor||2, descripcion],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ id: this.lastID });
    }
  );
});

app.delete('/api/vinos/:id', (req, res) => {
  db.run('DELETE FROM vinos WHERE id=?', [req.params.id], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ ok: true });
  });
});

app.put('/api/vinos/:id/ficha', (req, res) => {
  const { historia_bodega, notas_enologo, maridaje, temperatura, decantacion } = req.body;
  const extra = JSON.stringify({ historia_bodega, maridaje, temperatura, decantacion });
  db.run(
    `UPDATE vinos SET descripcion=?, imagen=? WHERE id=?`,
    [notas_enologo, extra, req.params.id],
    (err) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ ok: true });
    }
  );
});

// ── CLIENTES ───────────────────────────────────────────────────────────────

app.get('/api/clientes', (req, res) => {
  db.all('SELECT * FROM clientes ORDER BY nombre', [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/clientes', (req, res) => {
  const { nombre, email, telefono } = req.body;
  db.run(
    'INSERT INTO clientes (nombre,email,telefono) VALUES (?,?,?)',
    [nombre, email||null, telefono||null],
    function(err) {
      if (err) return res.status(400).json({ error: 'Email ya registrado' });
      res.json({ id: this.lastID });
    }
  );
});

app.get('/api/clientes/:nombre/historial', (req, res) => {
  const nombre = decodeURIComponent(req.params.nombre);
  db.all(
    `SELECT * FROM pedidos WHERE LOWER(cliente_nombre) LIKE LOWER(?) ORDER BY created_at DESC`,
    ['%' + nombre + '%'],
    (err, pedidos) => {
      if (err) return res.status(500).json({ error: err.message });
      const total = pedidos.reduce((s, p) => s + (p.total || 0), 0);
      res.json({ pedidos, total_gastado: total, cantidad_pedidos: pedidos.length });
    }
  );
});

// ── PEDIDOS ────────────────────────────────────────────────────────────────

app.get('/api/pedidos', (req, res) => {
  db.all('SELECT * FROM pedidos ORDER BY created_at DESC', [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/pedidos', (req, res) => {
  const { cliente_nombre, items, total, tipo } = req.body;
  db.run(
    'INSERT INTO pedidos (cliente_nombre,items,total,tipo) VALUES (?,?,?,?)',
    [cliente_nombre, JSON.stringify(items), total, tipo||'retiro'],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      const pedidoId = this.lastID;
      const arr = Array.isArray(items) ? items : JSON.parse(items);
      arr.forEach(i => {
        db.run('UPDATE vinos SET stock=stock-? WHERE id=?', [i.cantidad, i.vino_id]);
      });
      res.json({ id: pedidoId });
    }
  );
});

app.put('/api/pedidos/:id/estado', (req, res) => {
  db.run('UPDATE pedidos SET estado=? WHERE id=?', [req.body.estado, req.params.id], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ ok: true });
  });
});

// ── STATS ──────────────────────────────────────────────────────────────────

app.get('/api/stats', (req, res) => {
  const stats = {};
  db.get('SELECT COUNT(*) as c FROM vinos', [], (err, r) => {
    if (err) return res.status(500).json({ error: err.message });
    stats.totalVinos = r.c;

    db.get('SELECT COUNT(*) as c FROM clientes', [], (err, r) => {
      if (err) return res.status(500).json({ error: err.message });
      stats.totalClientes = r.c;

      db.get("SELECT COUNT(*) as c FROM pedidos WHERE date(created_at)=date('now')", [], (err, r) => {
        if (err) return res.status(500).json({ error: err.message });
        stats.pedidosHoy = r.c;

        db.get("SELECT SUM(total) as t FROM pedidos WHERE date(created_at)=date('now')", [], (err, r) => {
          if (err) return res.status(500).json({ error: err.message });
          stats.ventasHoy = r.t || 0;

          db.all('SELECT * FROM vinos WHERE stock<10', [], (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            stats.stockBajo = rows;
            res.json(stats);
          });
        });
      });
    });
  });
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

app.listen(process.env.PORT || 3000, () => console.log('✓ VinoVibe en http://localhost:3000'));