'use strict';
/**
 * Días de descanso obligatorio (Ley Federal del Trabajo, art. 74) y días festivos propios de la empresa.
 * Los de ley se calculan automáticamente cada año; los de la empresa (o jornadas electorales) se capturan.
 * Art. 75: quien trabaja en día de descanso obligatorio recibe, además de su salario, un salario doble.
 */
const { db } = require('./db');

db.exec(`CREATE TABLE IF NOT EXISTS dias_festivos (
  id INTEGER PRIMARY KEY,
  fecha TEXT NOT NULL,
  nombre TEXT NOT NULL,
  empresa_id INTEGER REFERENCES empresas(id),   -- NULL = todas las empresas
  creado_por TEXT,
  creado_en TEXT DEFAULT (datetime('now','localtime'))
)`);

const pad = (n) => String(n).padStart(2, '0');
/** n-ésimo lunes del mes (mes 1-12) */
function nLunes(anio, mes, n) {
  const d = new Date(Date.UTC(anio, mes - 1, 1));
  const desplaz = (8 - d.getUTCDay()) % 7; // días hasta el primer lunes
  return `${anio}-${pad(mes)}-${pad(1 + desplaz + 7 * (n - 1))}`;
}

function festivosLey(anio) {
  anio = Number(anio);
  const l = [
    { fecha: `${anio}-01-01`, nombre: 'Año Nuevo' },
    { fecha: nLunes(anio, 2, 1), nombre: 'Día de la Constitución (primer lunes de febrero)' },
    { fecha: nLunes(anio, 3, 3), nombre: 'Natalicio de Benito Juárez (tercer lunes de marzo)' },
    { fecha: `${anio}-05-01`, nombre: 'Día del Trabajo' },
    { fecha: `${anio}-09-16`, nombre: 'Día de la Independencia' },
    { fecha: nLunes(anio, 11, 3), nombre: 'Revolución Mexicana (tercer lunes de noviembre)' },
    { fecha: `${anio}-12-25`, nombre: 'Navidad' },
  ];
  // 1 de octubre cada seis años: transmisión del Poder Ejecutivo Federal (2024, 2030, 2036…)
  if ((anio - 2024) % 6 === 0 && anio >= 2024) l.push({ fecha: `${anio}-10-01`, nombre: 'Transmisión del Poder Ejecutivo Federal' });
  return l.map((x) => ({ ...x, tipo: 'ley', empresa_id: null })).sort((a, b) => a.fecha.localeCompare(b.fecha));
}

/** Festivos entre dos fechas: Map(fecha -> [{nombre, tipo, empresa_id}]) */
function festivosEntre(desde, hasta) {
  const m = new Map();
  const add = (f) => { if (f.fecha < desde || f.fecha > hasta) return; if (!m.has(f.fecha)) m.set(f.fecha, []); m.get(f.fecha).push(f); };
  for (let y = Number(desde.slice(0, 4)); y <= Number(hasta.slice(0, 4)); y++) festivosLey(y).forEach(add);
  db.prepare('SELECT id, fecha, nombre, empresa_id FROM dias_festivos WHERE fecha BETWEEN ? AND ?').all(desde, hasta)
    .forEach((f) => add({ ...f, tipo: 'empresa' }));
  return m;
}
/** Nombre del festivo que aplica a una empresa en una fecha, o null. */
function festivoPara(mapa, fecha, empresaId) {
  const l = mapa.get(fecha);
  if (!l) return null;
  const f = l.find((x) => x.empresa_id == null || x.empresa_id === empresaId);
  return f ? f.nombre : null;
}

function listar(anio) {
  const propios = db.prepare(`SELECT f.id, f.fecha, f.nombre, f.empresa_id, em.nombre empresa, f.creado_por FROM dias_festivos f
                              LEFT JOIN empresas em ON em.id = f.empresa_id WHERE substr(f.fecha, 1, 4) = ? ORDER BY f.fecha`).all(String(anio));
  return [...festivosLey(anio), ...propios.map((p) => ({ ...p, tipo: 'empresa' }))].sort((a, b) => a.fecha.localeCompare(b.fecha));
}
function agregar({ fecha, nombre, empresa_id }, usuario) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha || '')) throw new Error('Fecha inválida');
  if (!String(nombre || '').trim()) throw new Error('Indica el nombre del día festivo');
  const r = db.prepare('INSERT INTO dias_festivos (fecha, nombre, empresa_id, creado_por) VALUES (?,?,?,?)').run(fecha, String(nombre).trim(), empresa_id || null, usuario);
  return Number(r.lastInsertRowid);
}
function eliminar(id) { db.prepare('DELETE FROM dias_festivos WHERE id = ?').run(Number(id)); }

module.exports = { festivosLey, festivosEntre, festivoPara, listar, agregar, eliminar, nLunes };
