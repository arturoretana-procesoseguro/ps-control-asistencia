'use strict';
/**
 * Generación de reportes en Excel (.xlsx) para el copiloto y para cualquier tabla del sistema.
 * Los datos salen directo de la base de datos: el modelo de IA sólo decide qué consultas y hojas incluir.
 */
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const ExcelJS = require('exceljs');
const { DATA_DIR } = require('./db');
const { nowLocal } = require('./util');

const DIR = path.join(DATA_DIR, 'reportes');
fs.mkdirSync(DIR, { recursive: true });

/** Columnas disponibles por tipo de consulta: [clave, título, tipo] */
const COLUMNAS = {
  dias: [['fecha', 'Fecha', 'fecha'], ['numero', 'No. empleado', 'texto'], ['nombre', 'Nombre', 'texto'], ['empresa', 'Empresa', 'texto'],
    ['entrada', 'Entrada', 'texto'], ['salida', 'Salida', 'texto'], ['horas', 'Horas efectivas', 'numero'], ['extra', 'Horas extra', 'numero'],
    ['retardo_min', 'Minutos de retardo', 'entero'], ['estado', 'Estado', 'texto'], ['incidencias', 'Incidencias', 'texto']],
  agrupado: [['grupo', 'Grupo', 'texto'], ['personas', 'Personas', 'entero'], ['laborables', 'Días laborables', 'entero'], ['asistencias', 'Asistencias', 'entero'],
    ['faltas', 'Faltas', 'entero'], ['retardos', 'Retardos', 'entero'], ['min_retardo', 'Minutos de retardo', 'entero'], ['horas', 'Horas efectivas', 'numero'],
    ['extra', 'Horas extra', 'numero'], ['pct_asistencia', '% asistencia', 'porcentaje'], ['pct_puntualidad', '% puntualidad', 'porcentaje'],
    ['sin_salida', 'Sin salida', 'entero'], ['fuera_geocerca', 'Fuera de geocerca', 'entero'], ['manuales', 'Registros manuales', 'entero'], ['festivos_trabajados', 'Festivos trabajados', 'entero']],
  semanas: [['semana', 'Semana (lunes)', 'fecha'], ['numero', 'No. empleado', 'texto'], ['nombre', 'Nombre', 'texto'], ['empresa', 'Empresa', 'texto'], ['dias', 'Días trabajados', 'entero'],
    ['horas', 'Horas efectivas', 'numero'], ['limite', 'Jornada máxima', 'entero'], ['extra', 'Horas extra', 'numero'], ['excede', 'Excede el límite', 'texto'], ['conformidad', 'Conformidad del trabajador', 'texto']],
  huellas: [['numero', 'No. empleado', 'texto'], ['nombre', 'Nombre', 'texto'], ['checador', 'Checador', 'texto'], ['estado', 'Estado', 'texto'], ['solicitado_en', 'Solicitado', 'texto']],
  nunca_checado: [['numero', 'No. empleado', 'texto'], ['nombre', 'Nombre', 'texto']],
};
const ESTADO_HUELLA = { pendiente: 'Huella pendiente', sin_huella: 'Sin huella', sin_alta: 'No está en el checador' };

function normalizarFilas(tipo, filas) {
  return filas.map((f) => {
    const x = { ...f };
    if (tipo === 'dias') x.incidencias = (f.incidencias || []).join('; ');
    if (tipo === 'semanas') { x.excede = f.excede ? 'Sí' : 'No'; x.conformidad = f.conformidad ? 'Confirmada ' + f.conformidad : 'Pendiente'; }
    if (tipo === 'huellas') x.estado = ESTADO_HUELLA[f.estado] || f.estado;
    return x;
  });
}

const valor = (v, tipo) => {
  if (v === '' || v == null) return null;
  if (tipo === 'numero' || tipo === 'entero') { const n = Number(v); return Number.isFinite(n) ? n : v; }
  if (tipo === 'porcentaje') { const n = Number(v); return Number.isFinite(n) ? n / 100 : v; }
  if (tipo === 'fecha' && /^\d{4}-\d{2}-\d{2}$/.test(String(v))) { const [y, m, d] = String(v).split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); }
  return String(v);
};

/**
 * hojas: [{ nombre, subtitulo?, columnas: [[clave, título, tipo]], filas: [{...}] }]
 */
async function crearLibro({ titulo, usuario, hojas }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Control de Asistencia · Grupo Proceso Seguro';
  wb.created = new Date();
  const usados = new Set();
  for (const h of hojas) {
    let nombre = String(h.nombre || 'Hoja').replace(/[\\/*?:[\]]/g, ' ').slice(0, 31).trim() || 'Hoja';
    for (let i = 2; usados.has(nombre.toLowerCase()); i++) nombre = nombre.slice(0, 28) + ' ' + i;
    usados.add(nombre.toLowerCase());
    const ws = wb.addWorksheet(nombre, { views: [{ state: 'frozen', ySplit: 4 }] });
    const n = Math.max(1, h.columnas.length);
    ws.mergeCells(1, 1, 1, n); ws.getCell(1, 1).value = titulo || nombre;
    ws.getCell(1, 1).font = { bold: true, size: 14, color: { argb: 'FF1E1B4B' } };
    ws.mergeCells(2, 1, 2, n); ws.getCell(2, 1).value = `${h.subtitulo ? h.subtitulo + ' · ' : ''}Generado el ${nowLocal()}${usuario ? ' por ' + usuario : ''}`;
    ws.getCell(2, 1).font = { size: 9, color: { argb: 'FF6B7280' } };
    const head = ws.getRow(4);
    h.columnas.forEach(([, t], i) => { head.getCell(i + 1).value = t; });
    head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    head.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF6D28D9' } }; c.alignment = { vertical: 'middle', wrapText: true }; });
    head.height = 22;
    h.filas.forEach((f, r) => {
      const row = ws.getRow(5 + r);
      h.columnas.forEach(([k, , tipo], i) => {
        const c = row.getCell(i + 1); c.value = valor(f[k], tipo);
        if (tipo === 'numero') c.numFmt = '#,##0.00';
        else if (tipo === 'entero') c.numFmt = '#,##0';
        else if (tipo === 'porcentaje') c.numFmt = '0.0%';
        else if (tipo === 'fecha' && c.value instanceof Date) c.numFmt = 'yyyy-mm-dd';
      });
    });
    if (h.filas.length) ws.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4 + h.filas.length, column: n } };
    h.columnas.forEach(([k, t, tipo], i) => {
      const largo = Math.max(String(t).length, ...h.filas.slice(0, 500).map((f) => String(f[k] ?? '').length));
      ws.getColumn(i + 1).width = Math.min(60, Math.max(tipo === 'fecha' ? 12 : 8, largo + 2));
    });
    if (!h.filas.length) ws.getCell(5, 1).value = 'Sin datos para este filtro';
  }
  return wb.xlsx.writeBuffer();
}

/** Guarda un libro temporal (24 h) y devuelve su id para descargarlo. */
async function guardar(opciones) {
  for (const f of fs.readdirSync(DIR)) {
    const p = path.join(DIR, f);
    try { if (Date.now() - fs.statSync(p).mtimeMs > 24 * 3600e3) fs.unlinkSync(p); } catch { /* ignorar */ }
  }
  const id = crypto.randomBytes(12).toString('hex');
  fs.writeFileSync(path.join(DIR, id + '.xlsx'), Buffer.from(await crearLibro(opciones)));
  const nombre = (String(opciones.titulo || 'reporte').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 60) || 'reporte') + '.xlsx';
  return { id, nombre, hojas: opciones.hojas.map((h) => ({ nombre: h.nombre, filas: h.filas.length })) };
}
function ruta(id) {
  if (!/^[a-f0-9]{24}$/.test(String(id))) return null;
  const p = path.join(DIR, id + '.xlsx');
  return fs.existsSync(p) ? p : null;
}

module.exports = { COLUMNAS, normalizarFilas, crearLibro, guardar, ruta };
