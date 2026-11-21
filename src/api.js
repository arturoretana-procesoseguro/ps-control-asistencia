'use strict';
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { db, DATA_DIR } = require('./db');
const U = require('./util');
const { calcularAsistencia, resumen } = require('./reporte');
const { interpretar } = require('./importar');
const { nuevoToken } = require('./dispositivos');
const zkSync = require('./zk-sync');
const odooSync = require('./odoo-sync');
const depurar = require('./depurar');

const FOTOS_DIR = path.join(DATA_DIR, 'fotos');
fs.mkdirSync(FOTOS_DIR, { recursive: true });

const api = express.Router();
api.use(express.json({ limit: '25mb' }));

const wrap = (fn) => (req, res) => {
  try { fn(req, res); } catch (e) {
    const msg = String(e.message || e);
    if (/UNIQUE/.test(msg)) return res.status(409).json({ error: 'Ya existe un registro con esos datos (valor duplicado).' });
    if (/FOREIGN KEY/.test(msg)) return res.status(409).json({ error: 'No se puede eliminar: hay información relacionada.' });
    console.error(e);
    res.status(500).json({ error: msg });
  }
};
const nn = (v) => (v === '' || v === undefined ? null : v);

// ---------- intentos de login (protección simple contra fuerza bruta) ----------
const intentos = new Map();
function bloqueado(key) {
  const x = intentos.get(key);
  return x && x.n >= 5 && Date.now() - x.t < 10 * 60e3;
}
function fallo(key) { const x = intentos.get(key) || { n: 0, t: 0 }; intentos.set(key, { n: x.n + 1, t: Date.now() }); }

// ======================= Autenticación de administración =======================
api.post('/login', wrap((req, res) => {
  const { usuario, password } = req.body || {};
  const key = 'u:' + usuario;
  if (bloqueado(key)) return res.status(429).json({ error: 'Demasiados intentos. Espera 10 minutos.' });
  const u = db.prepare('SELECT * FROM usuarios WHERE usuario = ?').get(String(usuario || ''));
  if (!u || !U.checkPassword(password, u.pass_hash)) { fallo(key); return res.status(401).json({ error: 'Usuario o contraseña incorrectos' }); }
  intentos.delete(key);
  U.setCookie(res, 'sid', U.sign({ kind: 'admin', id: u.id, usuario: u.usuario, nombre: u.nombre, rol: u.rol, empresa_id: u.empresa_id }));
  res.json({ ok: true });
}));
api.post('/logout', (req, res) => { U.clearCookie(res, 'sid'); res.json({ ok: true }); });

// ======================= Personal de campo =======================
api.post('/campo/login', wrap((req, res) => {
  const { numero, pin } = req.body || {};
  const key = 'e:' + numero;
  if (bloqueado(key)) return res.status(429).json({ error: 'Demasiados intentos. Espera 10 minutos.' });
  const e = db.prepare('SELECT * FROM empleados WHERE numero = ? AND activo = 1').get(String(numero || '').trim());
  if (!e || !e.pin_hash || !U.checkPassword(pin, e.pin_hash)) { fallo(key); return res.status(401).json({ error: 'Número de empleado o PIN incorrectos' }); }
  if (e.tipo === 'oficina') return res.status(403).json({ error: 'Tu perfil está configurado sólo para checador de oficina. Consulta a Recursos Humanos.' });
  intentos.delete(key);
  U.setCookie(res, 'eid', U.sign({ kind: 'empleado', id: e.id, numero: e.numero }, 24 * 30), 24 * 30);
  res.json({ ok: true });
}));
api.post('/campo/logout', (req, res) => { U.clearCookie(res, 'eid'); res.json({ ok: true }); });

api.get('/campo/me', U.requireEmpleado, wrap((req, res) => {
  const e = db.prepare(`SELECT e.id, e.numero, e.nombre, e.puesto, em.nombre empresa, s.nombre sede, s.lat, s.lng, s.radio_m,
                               h.entrada h_entrada, h.salida h_salida
                        FROM empleados e LEFT JOIN empresas em ON em.id=e.empresa_id
                        LEFT JOIN sedes s ON s.id=e.sede_id LEFT JOIN horarios h ON h.id=e.horario_id
                        WHERE e.id = ? AND e.activo = 1`).get(req.empleado.id);
  if (!e) return res.status(401).json({ error: 'Empleado inactivo' });
  const hoy = U.nowLocal().slice(0, 10);
  const registros = db.prepare(`SELECT fecha_hora, tipo, origen, dentro_geocerca FROM registros
                                WHERE empleado_numero = ? AND fecha_hora >= ? ORDER BY fecha_hora`).all(e.numero, hoy + ' 00:00:00');
  res.json({ empleado: e, hoy: registros });
}));

api.post('/campo/checar', U.requireEmpleado, wrap((req, res) => {
  const e = db.prepare(`SELECT e.*, s.lat s_lat, s.lng s_lng, s.radio_m FROM empleados e
                        LEFT JOIN sedes s ON s.id=e.sede_id WHERE e.id = ? AND e.activo = 1`).get(req.empleado.id);
  if (!e) return res.status(401).json({ error: 'Empleado inactivo' });
  const { tipo, lat, lng, precision, foto, nota } = req.body || {};
  if (!['entrada', 'salida'].includes(tipo)) return res.status(400).json({ error: 'Indica entrada o salida' });
  if (typeof lat !== 'number' || typeof lng !== 'number') return res.status(400).json({ error: 'Se requiere la ubicación GPS para registrar asistencia' });

  let distancia = null, dentro = null;
  if (e.s_lat != null && e.s_lng != null) {
    distancia = Math.round(U.distanciaMetros(lat, lng, e.s_lat, e.s_lng));
    dentro = distancia <= (e.radio_m || 200) + Math.min(Number(precision) || 0, 100) ? 1 : 0;
  }
  if (process.env.CAMPO_EXIGIR_FOTO === '1' && !foto) return res.status(400).json({ error: 'Se requiere una foto' });
  let archivo = null;
  if (foto) {
    const m = String(foto).match(/^data:image\/(jpeg|jpg|png|webp);base64,(.+)$/);
    if (!m) return res.status(400).json({ error: 'Foto inválida' });
    archivo = `${e.numero}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${m[1] === 'png' ? 'png' : m[1] === 'webp' ? 'webp' : 'jpg'}`;
    fs.writeFileSync(path.join(FOTOS_DIR, archivo), Buffer.from(m[2], 'base64'));
  }
  const fh = U.nowLocal();
  const n = U.guardarRegistro({
    empleado_numero: e.numero, fecha_hora: fh, tipo, origen: 'campo', lat, lng,
    precision_m: precision ?? null, distancia_m: distancia, dentro_geocerca: dentro, foto: archivo,
    nota: nn(String(nota || '').slice(0, 300)),
  });
  if (!n) return res.status(409).json({ error: 'Acabas de registrar. Espera unos segundos e intenta de nuevo.' });
  res.json({ ok: true, fecha_hora: fh, tipo, distancia_m: distancia, dentro_geocerca: dentro });
}));

// ======================= Todo lo demás requiere sesión de administración =======================
api.use(U.requireAdmin);
const soloAdmin = U.requireRole('admin');
const empresaForzada = (req, v) => req.user.empresa_id || nn(v);

api.get('/me', (req, res) => res.json(req.user));

api.get('/fotos/:archivo', (req, res) => {
  const f = path.basename(req.params.archivo);
  const p = path.join(FOTOS_DIR, f);
  if (!fs.existsSync(p)) return res.status(404).end();
  res.sendFile(p);
});

// ---------- Catálogos genéricos ----------
function crud(nombre, campos, { orden = 'id', listSql, soloAdminEscribe = true } = {}) {
  const guard = soloAdminEscribe ? [soloAdmin] : [];
  api.get('/' + nombre, wrap((req, res) => res.json(db.prepare(listSql || `SELECT * FROM ${nombre} ORDER BY ${orden}`).all())));
  api.post('/' + nombre, ...guard, wrap((req, res) => {
    const vals = campos.map((c) => nn(req.body[c]));
    const r = db.prepare(`INSERT INTO ${nombre} (${campos.join(',')}) VALUES (${campos.map(() => '?').join(',')})`).run(...vals);
    res.json({ id: Number(r.lastInsertRowid) });
  }));
  api.put('/' + nombre + '/:id', ...guard, wrap((req, res) => {
    const sets = campos.filter((c) => c in req.body);
    if (!sets.length) return res.json({ ok: true });
    db.prepare(`UPDATE ${nombre} SET ${sets.map((c) => c + '=?').join(',')} WHERE id = ?`).run(...sets.map((c) => nn(req.body[c])), Number(req.params.id));
    res.json({ ok: true });
  }));
  api.delete('/' + nombre + '/:id', ...guard, wrap((req, res) => {
    db.prepare(`DELETE FROM ${nombre} WHERE id = ?`).run(Number(req.params.id));
    res.json({ ok: true });
  }));
}
crud('empresas', ['nombre'], { orden: 'nombre' });
crud('sedes', ['empresa_id', 'nombre', 'direccion', 'lat', 'lng', 'radio_m'], {
  listSql: 'SELECT s.*, e.nombre empresa FROM sedes s LEFT JOIN empresas e ON e.id = s.empresa_id ORDER BY s.nombre',
});
crud('horarios', ['nombre', 'entrada', 'salida', 'tolerancia_min', 'dias'], { orden: 'nombre' });

// ---------- Empleados ----------
const EMP = ['numero', 'nombre', 'puesto', 'empresa_id', 'sede_id', 'horario_id', 'tipo', 'activo'];
api.get('/empleados', wrap((req, res) => {
  const emp = empresaForzada(req, req.query.empresa_id);
  res.json(db.prepare(`SELECT e.id, e.numero, e.nombre, e.puesto, e.empresa_id, e.sede_id, e.horario_id, e.tipo, e.activo,
                              (e.pin_hash IS NOT NULL) tiene_pin, em.nombre empresa, s.nombre sede, h.nombre horario
                       FROM empleados e LEFT JOIN empresas em ON em.id=e.empresa_id
                       LEFT JOIN sedes s ON s.id=e.sede_id LEFT JOIN horarios h ON h.id=e.horario_id
                       ${emp ? 'WHERE e.empresa_id = ?' : ''} ORDER BY e.nombre`).all(...(emp ? [Number(emp)] : [])));
}));
api.get('/empleados.csv', wrap((req, res) => {
  const emp = empresaForzada(req, req.query.empresa_id);
  const rows = db.prepare(`SELECT e.numero, e.nombre, e.puesto, em.nombre empresa, s.nombre sede, h.nombre horario, e.tipo,
                                  CASE e.activo WHEN 1 THEN 'Activo' ELSE 'Inactivo' END estado, e.odoo_id
                           FROM empleados e LEFT JOIN empresas em ON em.id=e.empresa_id
                           LEFT JOIN sedes s ON s.id=e.sede_id LEFT JOIN horarios h ON h.id=e.horario_id
                           ${emp ? 'WHERE e.empresa_id = ?' : ''} ORDER BY e.nombre`).all(...(emp ? [Number(emp)] : []));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="empleados.csv"');
  res.send(U.toCSV([
    { key: 'numero', label: 'No. empleado' }, { key: 'nombre', label: 'Nombre' }, { key: 'puesto', label: 'Puesto' },
    { key: 'empresa', label: 'Empresa' }, { key: 'sede', label: 'Sede' }, { key: 'horario', label: 'Horario' },
    { key: 'tipo', label: 'Tipo' }, { key: 'estado', label: 'Estado' }, { key: 'odoo_id', label: 'ID Odoo' },
  ], rows));
}));
api.post('/empleados', soloAdmin, wrap((req, res) => {
  const b = req.body;
  if (!b.numero || !b.nombre) return res.status(400).json({ error: 'Número y nombre son obligatorios' });
  const r = db.prepare(`INSERT INTO empleados (${EMP.join(',')}, pin_hash) VALUES (${EMP.map(() => '?').join(',')}, ?)`)
    .run(...EMP.map((c) => (c === 'activo' ? (b.activo === 0 || b.activo === false ? 0 : 1) : c === 'tipo' ? b.tipo || 'oficina' : nn(b[c]))),
      b.pin ? U.hashPassword(b.pin) : null);
  res.json({ id: Number(r.lastInsertRowid) });
}));
api.put('/empleados/:id', soloAdmin, wrap((req, res) => {
  const b = req.body;
  const sets = EMP.filter((c) => c in b);
  const vals = sets.map((c) => (c === 'activo' ? (b.activo ? 1 : 0) : nn(b[c])));
  if (b.pin) { sets.push('pin_hash'); vals.push(U.hashPassword(b.pin)); }
  if (sets.length) db.prepare(`UPDATE empleados SET ${sets.map((c) => c + '=?').join(',')} WHERE id = ?`).run(...vals, Number(req.params.id));
  res.json({ ok: true });
}));
api.delete('/empleados/:id', soloAdmin, wrap((req, res) => {
  // Se desactiva para conservar el historial de asistencia
  db.prepare('UPDATE empleados SET activo = 0 WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
}));

// ---------- Dispositivos ----------
api.get('/dispositivos', wrap((req, res) => {
  res.json(db.prepare(`SELECT d.*, s.nombre sede,
                         (SELECT COUNT(*) FROM registros r WHERE r.dispositivo_id = d.id) total_registros,
                         (SELECT MAX(fecha_hora) FROM registros r WHERE r.dispositivo_id = d.id) ultimo_registro
                       FROM dispositivos d LEFT JOIN sedes s ON s.id=d.sede_id ORDER BY d.nombre`).all());
}));
api.post('/dispositivos', soloAdmin, wrap((req, res) => {
  const b = req.body;
  if (!['zkteco', 'hikvision'].includes(b.marca)) return res.status(400).json({ error: 'Marca inválida' });
  if (b.marca === 'zkteco' && !b.serie && !b.ip_lectura) return res.status(400).json({ error: 'Captura el número de serie (SN) o la IP del checador' });
  const r = db.prepare('INSERT INTO dispositivos (nombre, marca, serie, token, sede_id, estado, ip_lectura, puerto) VALUES (?,?,?,?,?,?,?,?)')
    .run(b.nombre || b.marca, b.marca, nn(b.serie), b.marca === 'hikvision' ? nuevoToken() : null, nn(b.sede_id), b.estado || 'activo',
      b.marca === 'zkteco' ? nn(b.ip_lectura) : null, Number(b.puerto) || 4370);
  res.json({ id: Number(r.lastInsertRowid) });
}));
api.put('/dispositivos/:id', soloAdmin, wrap((req, res) => {
  const sets = ['nombre', 'serie', 'sede_id', 'estado', 'ip_lectura', 'puerto', 'enviar_altas'].filter((c) => c in req.body);
  if (sets.length) db.prepare(`UPDATE dispositivos SET ${sets.map((c) => c + '=?').join(',')} WHERE id = ?`)
    .run(...sets.map((c) => nn(req.body[c])), Number(req.params.id));
  if (req.body.regenerar_token) db.prepare("UPDATE dispositivos SET token = ? WHERE id = ? AND marca='hikvision'").run(nuevoToken(), Number(req.params.id));
  res.json({ ok: true });
}));
const devZk = (id) => {
  const d = db.prepare("SELECT * FROM dispositivos WHERE id = ? AND marca = 'zkteco'").get(Number(id));
  if (!d) throw new Error('Checador ZKTeco no encontrado');
  return d;
};
const wrapAsync = (fn) => (req, res) => fn(req, res).catch((e) => res.status(400).json({ error: String(e.message || e) }));
api.post('/dispositivos/:id/probar', soloAdmin, wrapAsync(async (req, res) => res.json(await zkSync.probar(devZk(req.params.id)))));
api.post('/dispositivos/:id/sincronizar', soloAdmin, wrapAsync(async (req, res) => res.json(await zkSync.sincronizar(devZk(req.params.id)))));
api.post('/dispositivos/:id/importar-usuarios', soloAdmin, wrapAsync(async (req, res) => {
  const b = req.body || {};
  res.json(await zkSync.importarUsuarios(devZk(req.params.id), {
    empresa_id: nn(b.empresa_id), sede_id: nn(b.sede_id), horario_id: nn(b.horario_id), tipo: b.tipo || 'oficina' }));
}));
api.delete('/dispositivos/:id', soloAdmin, wrap((req, res) => {
  db.prepare('UPDATE registros SET dispositivo_id = NULL WHERE dispositivo_id = ?').run(Number(req.params.id));
  db.prepare('DELETE FROM dispositivos WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
}));

// ---------- Odoo ----------
api.get('/odoo', soloAdmin, wrap((req, res) => res.json(odooSync.getConfig())));
api.put('/odoo', soloAdmin, wrap((req, res) => { odooSync.setConfig(req.body || {}); res.json(odooSync.getConfig()); }));
api.post('/odoo/probar', soloAdmin, wrapAsync(async (req, res) => res.json(await odooSync.probar())));
api.post('/odoo/sincronizar', soloAdmin, wrapAsync(async (req, res) => res.json(await odooSync.sincronizarTodo())));
api.post('/odoo/vincular', soloAdmin, wrapAsync(async (req, res) => res.json(await odooSync.vincular(req.body.empleado_id, req.body.odoo_id))));

// ---------- Depuración ----------
api.post('/depurar/vista-previa', soloAdmin, wrapAsync(async (req, res) => res.json(await depurar.vistaPrevia(req.body || {}))));
api.post('/depurar/aplicar', soloAdmin, wrapAsync(async (req, res) => {
  if (req.body?.confirmacion !== 'DEPURAR') throw new Error('Falta la confirmación');
  res.json(await depurar.aplicar(req.body));
}));
api.get('/depurar/ultima', soloAdmin, wrap((req, res) => {
  const v = db.prepare("SELECT valor FROM ajustes WHERE clave IN ('ultima_depuracion','asistencia_desde') ORDER BY clave").all();
  res.json({ asistencia_desde: db.prepare("SELECT valor FROM ajustes WHERE clave='asistencia_desde'").get()?.valor || null,
    ultima: JSON.parse(db.prepare("SELECT valor FROM ajustes WHERE clave='ultima_depuracion'").get()?.valor || 'null') });
}));

// ---------- Usuarios ----------
api.get('/usuarios', soloAdmin, wrap((req, res) => res.json(db.prepare(
  'SELECT u.id, u.usuario, u.nombre, u.rol, u.empresa_id, e.nombre empresa FROM usuarios u LEFT JOIN empresas e ON e.id=u.empresa_id ORDER BY u.usuario').all())));
api.post('/usuarios', soloAdmin, wrap((req, res) => {
  const b = req.body;
  if (!b.usuario || !b.password || b.password.length < 8) return res.status(400).json({ error: 'Usuario y contraseña (mínimo 8 caracteres) son obligatorios' });
  const r = db.prepare('INSERT INTO usuarios (usuario, nombre, pass_hash, rol, empresa_id) VALUES (?,?,?,?,?)')
    .run(b.usuario, nn(b.nombre), U.hashPassword(b.password), b.rol || 'supervisor', nn(b.empresa_id));
  res.json({ id: Number(r.lastInsertRowid) });
}));
api.put('/usuarios/:id', soloAdmin, wrap((req, res) => {
  const b = req.body;
  const sets = ['nombre', 'rol', 'empresa_id'].filter((c) => c in b);
  const vals = sets.map((c) => nn(b[c]));
  if (b.password) {
    if (b.password.length < 8) return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });
    sets.push('pass_hash'); vals.push(U.hashPassword(b.password));
  }
  if (sets.length) db.prepare(`UPDATE usuarios SET ${sets.map((c) => c + '=?').join(',')} WHERE id = ?`).run(...vals, Number(req.params.id));
  res.json({ ok: true });
}));
api.delete('/usuarios/:id', soloAdmin, wrap((req, res) => {
  if (Number(req.params.id) === req.user.id) return res.status(400).json({ error: 'No puedes eliminar tu propio usuario' });
  db.prepare('DELETE FROM usuarios WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
}));
api.post('/mi-password', wrap((req, res) => {
  const { actual, nueva } = req.body || {};
  const u = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(req.user.id);
  if (!U.checkPassword(actual, u.pass_hash)) return res.status(400).json({ error: 'La contraseña actual no es correcta' });
  if (!nueva || nueva.length < 8) return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 8 caracteres' });
  db.prepare('UPDATE usuarios SET pass_hash = ? WHERE id = ?').run(U.hashPassword(nueva), u.id);
  res.json({ ok: true });
}));

// ---------- Registros ----------
function filtroRegistros(req) {
  const q = req.query, where = [], p = [];
  if (q.desde) { where.push('r.fecha_hora >= ?'); p.push(q.desde + ' 00:00:00'); }
  if (q.hasta) { where.push('r.fecha_hora <= ?'); p.push(q.hasta + ' 23:59:59'); }
  if (q.origen) { where.push('r.origen = ?'); p.push(q.origen); }
  if (q.numero) { where.push('r.empleado_numero = ?'); p.push(q.numero); }
  if (q.dispositivo_id) { where.push('r.dispositivo_id = ?'); p.push(Number(q.dispositivo_id)); }
  if (q.fuera === '1') where.push('r.dentro_geocerca = 0');
  if (q.sin_empleado === '1') where.push('e.id IS NULL');
  const emp = empresaForzada(req, q.empresa_id);
  if (emp) { where.push('e.empresa_id = ?'); p.push(Number(emp)); }
  if (q.buscar) { where.push('(e.nombre LIKE ? OR r.empleado_numero LIKE ?)'); p.push(`%${q.buscar}%`, `%${q.buscar}%`); }
  return { sql: where.length ? 'WHERE ' + where.join(' AND ') : '', p };
}
const SQL_REG = `FROM registros r LEFT JOIN empleados e ON e.numero = r.empleado_numero
                 LEFT JOIN empresas em ON em.id = e.empresa_id LEFT JOIN dispositivos d ON d.id = r.dispositivo_id`;
api.get('/registros', wrap((req, res) => {
  const { sql, p } = filtroRegistros(req);
  const limit = Math.min(Number(req.query.limit) || 100, 1000), offset = Number(req.query.offset) || 0;
  const total = db.prepare(`SELECT COUNT(*) c ${SQL_REG} ${sql}`).get(...p).c;
  const rows = db.prepare(`SELECT r.*, e.nombre empleado, em.nombre empresa, d.nombre dispositivo ${SQL_REG} ${sql}
                           ORDER BY r.fecha_hora DESC LIMIT ? OFFSET ?`).all(...p, limit, offset);
  res.json({ total, rows });
}));
api.get('/registros.csv', wrap((req, res) => {
  const { sql, p } = filtroRegistros(req);
  const rows = db.prepare(`SELECT r.*, e.nombre empleado, em.nombre empresa, d.nombre dispositivo ${SQL_REG} ${sql} ORDER BY r.fecha_hora`).all(...p);
  for (const r of rows) r.geocerca = r.dentro_geocerca === null ? '' : r.dentro_geocerca ? 'Dentro' : 'Fuera';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="registros.csv"');
  res.send(U.toCSV([
    { key: 'empleado_numero', label: 'No. empleado' }, { key: 'empleado', label: 'Nombre' }, { key: 'empresa', label: 'Empresa' },
    { key: 'fecha_hora', label: 'Fecha y hora' }, { key: 'tipo', label: 'Tipo' }, { key: 'origen', label: 'Origen' },
    { key: 'dispositivo', label: 'Dispositivo' }, { key: 'lat', label: 'Latitud' }, { key: 'lng', label: 'Longitud' },
    { key: 'distancia_m', label: 'Distancia a sede (m)' }, { key: 'geocerca', label: 'Geocerca' },
    { key: 'nota', label: 'Nota' }, { key: 'creado_por', label: 'Capturado por' },
  ], rows));
}));
api.post('/registros', wrap((req, res) => {
  const b = req.body || {};
  const fh = U.normalizeDateTime(b.fecha_hora);
  if (!b.empleado_numero || !fh) return res.status(400).json({ error: 'Empleado y fecha/hora son obligatorios' });
  if (!b.nota || !String(b.nota).trim()) return res.status(400).json({ error: 'Indica el motivo del registro manual' });
  const desdeMin = U.asistenciaDesde();
  if (desdeMin && fh < desdeMin + ' 00:00:00') return res.status(400).json({ error: `Sólo se aceptan checadas desde el ${desdeMin} (ver Depuración)` });
  const e = db.prepare('SELECT empresa_id FROM empleados WHERE numero = ?').get(String(b.empleado_numero));
  if (!e) return res.status(400).json({ error: 'El empleado no existe' });
  if (req.user.empresa_id && e.empresa_id !== req.user.empresa_id) return res.status(403).json({ error: 'Sin permiso sobre este empleado' });
  const n = U.guardarRegistro({ empleado_numero: b.empleado_numero, fecha_hora: fh, tipo: nn(b.tipo), origen: 'manual', nota: b.nota, creado_por: req.user.usuario });
  res.json({ ok: true, nuevos: n });
}));
api.delete('/registros/:id', soloAdmin, wrap((req, res) => {
  db.prepare('DELETE FROM registros WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
}));

api.post('/importar', soloAdmin, wrap((req, res) => {
  const { contenido, confirmar } = req.body || {};
  const r = interpretar(contenido || '');
  if (r.error) return res.status(400).json(r);
  let nuevos = 0;
  if (confirmar) {
    db.exec('BEGIN');
    try {
      for (const x of r.registros) nuevos += U.guardarRegistro({ ...x, origen: 'importacion', creado_por: req.user.usuario });
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  const numeros = [...new Set(r.registros.map((x) => x.empleado_numero))];
  const conocidos = new Set(db.prepare('SELECT numero FROM empleados').all().map((x) => x.numero));
  res.json({
    columnas: r.columnas, total: r.registros.length, nuevos, errores: r.errores.slice(0, 50),
    muestra: r.registros.slice(0, 10), sin_empleado: numeros.filter((n) => !conocidos.has(n)),
  });
}));

// ---------- Reportes ----------
function paramsReporte(req) {
  const hoy = U.nowLocal().slice(0, 10);
  const desde = /^\d{4}-\d{2}-\d{2}$/.test(req.query.desde) ? req.query.desde : hoy;
  let hasta = /^\d{4}-\d{2}-\d{2}$/.test(req.query.hasta) ? req.query.hasta : desde;
  if (hasta < desde) hasta = desde;
  const dias = (new Date(hasta) - new Date(desde)) / 864e5;
  if (dias > 92) throw new Error('El periodo máximo del reporte es de 93 días');
  return { desde, hasta, empresa_id: empresaForzada(req, req.query.empresa_id), sede_id: nn(req.query.sede_id), empleado_id: nn(req.query.empleado_id), tipo: nn(req.query.tipo) };
}
api.get('/reporte', wrap((req, res) => {
  const p = paramsReporte(req);
  let filas = calcularAsistencia(p);
  if (req.query.estado) filas = filas.filter((f) => f.estado === req.query.estado);
  res.json({ ...p, resumen: resumen(filas), filas });
}));
api.get('/reporte.csv', wrap((req, res) => {
  const p = paramsReporte(req);
  let filas = calcularAsistencia(p);
  if (req.query.estado) filas = filas.filter((f) => f.estado === req.query.estado);
  for (const f of filas) f.incid = f.incidencias.join('; ');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="asistencia_${p.desde}_${p.hasta}.csv"`);
  res.send(U.toCSV([
    { key: 'fecha', label: 'Fecha' }, { key: 'numero', label: 'No. empleado' }, { key: 'nombre', label: 'Nombre' },
    { key: 'empresa', label: 'Empresa' }, { key: 'sede', label: 'Sede' }, { key: 'tipo_empleado', label: 'Tipo' },
    { key: 'horario', label: 'Horario' }, { key: 'entrada', label: 'Entrada' }, { key: 'salida', label: 'Salida' },
    { key: 'horas', label: 'Horas' }, { key: 'retardo_min', label: 'Retardo (min)' }, { key: 'estado', label: 'Estado' },
    { key: 'incid', label: 'Incidencias' }, { key: 'origen', label: 'Origen' },
  ], filas));
}));

api.get('/dashboard', wrap((req, res) => {
  const hoy = U.nowLocal().slice(0, 10);
  const empresa_id = empresaForzada(req, req.query.empresa_id);
  const filas = calcularAsistencia({ desde: hoy, hasta: hoy, empresa_id });
  const porEmpresa = {};
  for (const f of filas) {
    const k = f.empresa || 'Sin empresa';
    porEmpresa[k] ??= { empresa: k, total: 0, presentes: 0, retardos: 0, faltas: 0 };
    const x = porEmpresa[k];
    if (f.estado === 'Descanso') continue;
    x.total++;
    if (f.entrada) x.presentes++;
    if (f.estado === 'Retardo') x.retardos++;
    if (f.estado === 'Falta') x.faltas++;
  }
  const ultimos = db.prepare(`SELECT r.fecha_hora, r.tipo, r.origen, r.empleado_numero, r.dentro_geocerca, e.nombre empleado, d.nombre dispositivo
                              ${SQL_REG} ${empresa_id ? 'WHERE e.empresa_id = ?' : ''} ORDER BY r.id DESC LIMIT 12`).all(...(empresa_id ? [Number(empresa_id)] : []));
  const dispositivos = db.prepare('SELECT id, nombre, marca, estado, ultimo_contacto FROM dispositivos ORDER BY nombre').all();
  const sinEmpleado = db.prepare(`SELECT COUNT(DISTINCT r.empleado_numero) c FROM registros r LEFT JOIN empleados e ON e.numero = r.empleado_numero
                                  WHERE e.id IS NULL AND r.fecha_hora >= date('now','-30 day')`).get().c;
  res.json({
    hoy, ahora: U.nowLocal(), resumen: resumen(filas), presentes: filas.filter((f) => f.entrada).length,
    en_campo: filas.filter((f) => f.entrada && f.origen.includes('campo')).length,
    por_empresa: Object.values(porEmpresa), ultimos, dispositivos, numeros_sin_empleado: sinEmpleado,
  });
}));

module.exports = api;
