'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'asistencia.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS empresas (
  id INTEGER PRIMARY KEY,
  nombre TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS sedes (
  id INTEGER PRIMARY KEY,
  empresa_id INTEGER REFERENCES empresas(id),
  nombre TEXT NOT NULL,
  direccion TEXT,
  lat REAL, lng REAL,
  radio_m INTEGER DEFAULT 200
);
CREATE TABLE IF NOT EXISTS horarios (
  id INTEGER PRIMARY KEY,
  nombre TEXT NOT NULL,
  entrada TEXT NOT NULL,          -- HH:MM
  salida TEXT NOT NULL,           -- HH:MM
  tolerancia_min INTEGER DEFAULT 10,
  dias TEXT DEFAULT '1,2,3,4,5'   -- 0=domingo ... 6=sábado
);
CREATE TABLE IF NOT EXISTS empleados (
  id INTEGER PRIMARY KEY,
  numero TEXT NOT NULL UNIQUE,    -- mismo ID que en el checador
  nombre TEXT NOT NULL,
  puesto TEXT,
  empresa_id INTEGER REFERENCES empresas(id),
  sede_id INTEGER REFERENCES sedes(id),
  horario_id INTEGER REFERENCES horarios(id),
  tipo TEXT DEFAULT 'oficina' CHECK (tipo IN ('oficina','campo','mixto')),
  pin_hash TEXT,
  activo INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS dispositivos (
  id INTEGER PRIMARY KEY,
  nombre TEXT NOT NULL,
  marca TEXT NOT NULL CHECK (marca IN ('zkteco','hikvision')),
  serie TEXT UNIQUE,              -- SN del ZKTeco / serie del Hikvision
  token TEXT UNIQUE,              -- token de la URL de recepción (Hikvision)
  sede_id INTEGER REFERENCES sedes(id),
  estado TEXT DEFAULT 'activo' CHECK (estado IN ('activo','pendiente','inactivo')),
  ip TEXT,
  ultimo_contacto TEXT
);
CREATE TABLE IF NOT EXISTS registros (
  id INTEGER PRIMARY KEY,
  empleado_numero TEXT NOT NULL,
  fecha_hora TEXT NOT NULL,       -- 'YYYY-MM-DD HH:MM:SS' hora local
  tipo TEXT,                      -- entrada / salida / null (checador sin tipo)
  origen TEXT NOT NULL CHECK (origen IN ('zkteco','hikvision','campo','manual','importacion')),
  dispositivo_id INTEGER REFERENCES dispositivos(id),
  lat REAL, lng REAL, precision_m REAL,
  distancia_m REAL,
  dentro_geocerca INTEGER,
  foto TEXT,
  nota TEXT,
  creado_por TEXT,
  creado_en TEXT DEFAULT (datetime('now','localtime')),
  UNIQUE (empleado_numero, fecha_hora, origen)
);
CREATE INDEX IF NOT EXISTS idx_registros_fecha ON registros(fecha_hora);
CREATE INDEX IF NOT EXISTS idx_registros_emp ON registros(empleado_numero, fecha_hora);
CREATE TABLE IF NOT EXISTS usuarios (
  id INTEGER PRIMARY KEY,
  usuario TEXT NOT NULL UNIQUE,
  nombre TEXT,
  pass_hash TEXT NOT NULL,
  rol TEXT DEFAULT 'admin' CHECK (rol IN ('admin','supervisor')),
  empresa_id INTEGER REFERENCES empresas(id)  -- supervisor limitado a una empresa (opcional)
);
CREATE TABLE IF NOT EXISTS ajustes (
  clave TEXT PRIMARY KEY,
  valor TEXT
);
`);

// ---- migraciones de columnas nuevas ----
function addColumn(tabla, col, def) {
  const cols = db.prepare(`PRAGMA table_info(${tabla})`).all().map((c) => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${tabla} ADD COLUMN ${col} ${def}`);
}
addColumn('dispositivos', 'ip_lectura', 'TEXT');            // IP para lectura directa TCP 4370 (ZKTeco sin ADMS)
addColumn('dispositivos', 'puerto', 'INTEGER DEFAULT 4370');
addColumn('dispositivos', 'ultima_sincronizacion', 'TEXT');
addColumn('dispositivos', 'ultimo_error', 'TEXT');

function seed(hashPassword) {
  const count = db.prepare('SELECT COUNT(*) c FROM empresas').get().c;
  if (count === 0) {
    const ins = db.prepare('INSERT INTO empresas (nombre) VALUES (?)');
    for (const n of ['Grupo Proceso Seguro', 'Proceso Seguro', 'Enfermería']) ins.run(n);
    db.prepare(`INSERT INTO horarios (nombre, entrada, salida, tolerancia_min, dias)
                VALUES ('Oficina L-V 9:00 a 18:00', '09:00', '18:00', 10, '1,2,3,4,5')`).run();
    db.prepare(`INSERT INTO horarios (nombre, entrada, salida, tolerancia_min, dias)
                VALUES ('Campo L-S 8:00 a 17:00', '08:00', '17:00', 15, '1,2,3,4,5,6')`).run();
  }
  const users = db.prepare('SELECT COUNT(*) c FROM usuarios').get().c;
  if (users === 0) {
    const pass = process.env.ADMIN_PASSWORD || require('node:crypto').randomBytes(6).toString('base64url');
    db.prepare(`INSERT INTO usuarios (usuario, nombre, pass_hash, rol) VALUES ('admin','Administrador',?, 'admin')`)
      .run(hashPassword(pass));
    console.log('\n==============================================');
    console.log(' Usuario inicial creado:  admin');
    console.log(' Contraseña:              ' + pass);
    console.log(' Cámbiala en Usuarios después de entrar.');
    console.log('==============================================\n');
  }
}

module.exports = { db, seed, DATA_DIR };
