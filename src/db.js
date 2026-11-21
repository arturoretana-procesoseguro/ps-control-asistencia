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
addColumn('dispositivos', 'enviar_altas', 'INTEGER DEFAULT 0'); // recibir altas de empleados de Odoo
addColumn('empleados', 'odoo_id', 'INTEGER');
addColumn('empleados', 'pin_checador', 'TEXT');      // PIN para checar en el equipo mientras registra huella
db.exec(`CREATE TABLE IF NOT EXISTS huellas (
  empleado_id INTEGER NOT NULL REFERENCES empleados(id) ON DELETE CASCADE,
  dispositivo_id INTEGER NOT NULL REFERENCES dispositivos(id) ON DELETE CASCADE,
  estado TEXT NOT NULL CHECK (estado IN ('sin_alta','sin_huella','pendiente','registrada')),
  huellas INTEGER,
  solicitado_por TEXT, solicitado_en TEXT, registrado_en TEXT, revisado_en TEXT,
  PRIMARY KEY (empleado_id, dispositivo_id)
)`);
db.exec(`CREATE TABLE IF NOT EXISTS odoo_asistencias (
  empleado_id INTEGER NOT NULL REFERENCES empleados(id),
  fecha TEXT NOT NULL,
  odoo_id INTEGER,
  check_in TEXT, check_out TEXT,
  error TEXT,
  enviado_en TEXT,
  PRIMARY KEY (empleado_id, fecha)
)`);

db.exec(`CREATE TABLE IF NOT EXISTS odoo_pares (
  empleado_id INTEGER NOT NULL REFERENCES empleados(id),
  fecha TEXT NOT NULL, idx INTEGER NOT NULL,
  odoo_id INTEGER, check_in TEXT, check_out TEXT, error TEXT, enviado_en TEXT,
  PRIMARY KEY (empleado_id, fecha, idx)
)`);
// migración: los registros enviados con el esquema anterior (un registro por día) se toman como el par 0
db.exec(`INSERT OR IGNORE INTO odoo_pares (empleado_id, fecha, idx, odoo_id, check_in, check_out, error, enviado_en)
         SELECT empleado_id, fecha, 0, odoo_id, check_in, check_out, error, enviado_en FROM odoo_asistencias WHERE odoo_id IS NOT NULL`);

// ---- cumplimiento (LFT art. 132 fr. XXXIV y art. 804): conservar, anular en vez de borrar, bitácora ----
addColumn('registros', 'anulado', 'INTEGER DEFAULT 0');
addColumn('registros', 'anulado_por', 'TEXT');
addColumn('registros', 'anulado_motivo', 'TEXT');
addColumn('registros', 'anulado_en', 'TEXT');
addColumn('empleados', 'fecha_baja', 'TEXT');
addColumn('empleados', 'archivado', 'INTEGER DEFAULT 0');
addColumn('empleados', 'curp', 'TEXT');
addColumn('empleados', 'rfc', 'TEXT');
addColumn('empleados', 'nss', 'TEXT');
addColumn('empresas', 'razon_social', 'TEXT');
addColumn('empresas', 'rfc', 'TEXT');
addColumn('empresas', 'registro_patronal', 'TEXT');
db.exec(`
CREATE TABLE IF NOT EXISTS registros_archivo (
  id INTEGER PRIMARY KEY,
  empleado_numero TEXT NOT NULL, fecha_hora TEXT NOT NULL, tipo TEXT, origen TEXT NOT NULL,
  dispositivo_id INTEGER, lat REAL, lng REAL, precision_m REAL, distancia_m REAL, dentro_geocerca INTEGER,
  foto TEXT, nota TEXT, creado_por TEXT, creado_en TEXT,
  anulado INTEGER DEFAULT 0, anulado_por TEXT, anulado_motivo TEXT, anulado_en TEXT,
  archivado_en TEXT DEFAULT (datetime('now','localtime')),
  UNIQUE (empleado_numero, fecha_hora, origen)
);
CREATE INDEX IF NOT EXISTS idx_archivo_emp ON registros_archivo(empleado_numero, fecha_hora);
CREATE TABLE IF NOT EXISTS bitacora (
  id INTEGER PRIMARY KEY,
  fecha TEXT DEFAULT (datetime('now','localtime')),
  usuario TEXT, accion TEXT NOT NULL, entidad TEXT, entidad_id TEXT, detalle TEXT
);
CREATE INDEX IF NOT EXISTS idx_bitacora_fecha ON bitacora(fecha);
CREATE TRIGGER IF NOT EXISTS bitacora_sin_cambios BEFORE UPDATE ON bitacora BEGIN SELECT RAISE(ABORT, 'La bitácora no se puede modificar'); END;
CREATE TRIGGER IF NOT EXISTS bitacora_sin_borrar BEFORE DELETE ON bitacora BEGIN SELECT RAISE(ABORT, 'La bitácora no se puede borrar'); END;
CREATE TABLE IF NOT EXISTS conformidades (
  id INTEGER PRIMARY KEY,
  empleado_id INTEGER NOT NULL REFERENCES empleados(id),
  semana TEXT NOT NULL,            -- lunes de la semana YYYY-MM-DD
  resumen TEXT,                    -- horas y días confirmados (JSON)
  huella TEXT,                     -- hash del detalle confirmado
  fecha TEXT DEFAULT (datetime('now','localtime')),
  ip TEXT,
  comentario TEXT,
  UNIQUE (empleado_id, semana)
);
`);

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
