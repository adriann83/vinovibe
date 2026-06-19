const express = require('express');
const cors = require('cors');
const path = require('path');
const Database = require('better-sqlite3');

const app = express();
const db = new Database('vinovibe.db');

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

db.exec(`
  CREATE TABLE IF NOT EXISTS vinos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL, bodega TEXT NOT NULL,
    region TEXT, varietal TEXT, anada INTEGER,
    precio REAL, stock INTEGER DEFAULT 0,
    tanino INTEGER DEFAULT 5, acidez INTEGER DEFAULT 5,
    cuerpo INTEGER DEFAULT 5, dulzor INTEGER DEFAULT 2,
    descripcion TEXT
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

const count = db.prepare('SELECT COUNT(*) as c FROM vinos').get();
if (count.c === 0) {
  const ins = db.prepare(`INSERT INTO vinos (nombre,bodega,region,varietal,anada,precio,stock,tanino,acidez,cuerpo,dulzor,descripcion) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  ins.run('Malbec Reserva','Achaval Ferrer','Mendoza','Malbec',2021,3200,48,7,5,8,2,'Frutos negros, tabaco y chocolate amargo.');
  ins.run('Valle de Uco','Zuccardi','Mendoza','Malbec',2022,4800,12,8,6,9,1,'Complejo y elegante. Notas minerales.');
  ins.run('Chardonnay','Catena Zapata','Mendoza','Chardonnay',2022,2900,24,2,7,6,3,'Fresco y frutal. Notas de durazno.');
  ins.run('Clos de los Siete','Michel Rolland','Tunuyán','Blend',2021,5400,18,7,5,8,2,'Blend potente y equilibrado.');
  ins.run('Torrontés Premium','Alta Vista','Salta','Torrontés',2023,2100,30,2,8,5,4,'Aromático y floral.');
  ins.run('Cabernet Sauvignon','Norton','Mendoza','Cabernet',2020,3800,20,9,6,9,1,'Taninos firmes, frutos negros.');
}
app.get('/api/vinos/:id', (req, res) => {
  const v = db.prepare('SELECT * FROM vinos WHERE id=?').get(req.params.id);
  if(!v) return res.status(404).json({error:'No encontrado'});
  try{ v.extra = JSON.parse(v.imagen||'{}'); } catch{ v.extra={}; }
  res.json(v);
});

app.get('/api/vinos', (req, res) => res.json(db.prepare('SELECT * FROM vinos').all()));
app.post('/api/vinos', (req, res) => {
  const {nombre,bodega,region,varietal,anada,precio,stock,tanino,acidez,cuerpo,dulzor,descripcion} = req.body;
  const r = db.prepare(`INSERT INTO vinos (nombre,bodega,region,varietal,anada,precio,stock,tanino,acidez,cuerpo,dulzor,descripcion) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(nombre,bodega,region,varietal,anada,precio,stock,tanino||5,acidez||5,cuerpo||5,dulzor||2,descripcion);
  res.json({id:r.lastInsertRowid});
});
app.delete('/api/vinos/:id', (req, res) => {
  db.prepare('DELETE FROM vinos WHERE id=?').run(req.params.id);
  res.json({ok:true});
});

app.get('/api/clientes', (req, res) => res.json(db.prepare('SELECT * FROM clientes ORDER BY nombre').all()));
app.post('/api/clientes', (req, res) => {
  const {nombre,email,telefono} = req.body;
  try {
    const r = db.prepare('INSERT INTO clientes (nombre,email,telefono) VALUES (?,?,?)').run(nombre,email||null,telefono||null);
    res.json({id:r.lastInsertRowid});
  } catch(e) { res.status(400).json({error:'Email ya registrado'}); }
});

app.get('/api/pedidos', (req, res) => res.json(db.prepare('SELECT * FROM pedidos ORDER BY created_at DESC').all()));
app.post('/api/pedidos', (req, res) => {
  const {cliente_nombre,items,total,tipo} = req.body;
  const r = db.prepare('INSERT INTO pedidos (cliente_nombre,items,total,tipo) VALUES (?,?,?,?)').run(cliente_nombre,JSON.stringify(items),total,tipo||'retiro');
  const arr = Array.isArray(items)?items:JSON.parse(items);
  arr.forEach(i => db.prepare('UPDATE vinos SET stock=stock-? WHERE id=?').run(i.cantidad,i.vino_id));
  res.json({id:r.lastInsertRowid});
});
app.put('/api/pedidos/:id/estado', (req, res) => {
  db.prepare('UPDATE pedidos SET estado=? WHERE id=?').run(req.body.estado,req.params.id);
  res.json({ok:true});
});

app.get('/api/stats', (req, res) => {
  const totalVinos = db.prepare('SELECT COUNT(*) as c FROM vinos').get().c;
  const totalClientes = db.prepare('SELECT COUNT(*) as c FROM clientes').get().c;
  const pedidosHoy = db.prepare("SELECT COUNT(*) as c FROM pedidos WHERE date(created_at)=date('now')").get().c;
  const ventasHoy = db.prepare("SELECT SUM(total) as t FROM pedidos WHERE date(created_at)=date('now')").get().t||0;
  const stockBajo = db.prepare('SELECT * FROM vinos WHERE stock<10').all();
  res.json({totalVinos,totalClientes,pedidosHoy,ventasHoy,stockBajo});
});

// Sommelier sin API key — lógica propia
app.post('/api/sommelier', (req, res) => {
  const {perfil, contexto, vinos} = req.body;
  if (!vinos || vinos.length === 0) return res.status(400).json({error:'Sin vinos'});

  // Calcular match por diferencia de perfil
  const scored = vinos.map(v => {
    const diff =
      Math.abs(v.tanino - perfil.tanino) +
      Math.abs(v.acidez - perfil.acidez) +
      Math.abs(v.cuerpo - perfil.cuerpo) +
      Math.abs(v.dulzor - perfil.dulzor);
    const match = Math.round(100 - (diff / 40) * 100);
    return {...v, match};
  }).sort((a,b) => b.match - a.match);

  const mejor = scored[0];

  // Generar razón automática
  const notas = mejor.descripcion || 'Excelente equilibrio y carácter.';
  const ctx = contexto ? ` Ideal para ${contexto}.` : '';
  const razon = `${notas}${ctx} Con un perfil de tanino ${mejor.tanino}/10 y cuerpo ${mejor.cuerpo}/10, es la mejor opción de tu catálogo para este cliente.`;

  // Maridaje automático por varietal
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
app.get('/api/clientes/:nombre/historial', (req, res) => {
  const nombre = decodeURIComponent(req.params.nombre);
  const pedidos = db.prepare(`
    SELECT * FROM pedidos 
    WHERE LOWER(cliente_nombre) LIKE LOWER(?) 
    ORDER BY created_at DESC
  `).all('%'+nombre+'%');
  const total = pedidos.reduce((s,p) => s + (p.total||0), 0);
  res.json({ pedidos, total_gastado: total, cantidad_pedidos: pedidos.length });
});
app.put('/api/vinos/:id/ficha', (req, res) => {
  const {historia_bodega, notas_enologo, maridaje, temperatura, decantacion} = req.body;
  db.prepare(`UPDATE vinos SET descripcion=? WHERE id=?`).run(notas_enologo, req.params.id);
  // Guardar datos extra en JSON
  const extra = JSON.stringify({historia_bodega, maridaje, temperatura, decantacion});
  db.prepare(`UPDATE vinos SET imagen=? WHERE id=?`).run(extra, req.params.id);
  res.json({ok:true});
});

app.listen(process.env.PORT||3000, () => console.log('✓ VinoVibe en http://localhost:3000'));