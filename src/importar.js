'use strict';
const { normalizeDateTime } = require('./util');

function parseCSV(text) {
  text = String(text).replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/)[0] || '';
  const delim = [',', ';', '\t'].sort((a, b) => firstLine.split(b).length - firstLine.split(a).length)[0];
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((x) => x.trim())) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}

const RX_NUM = /^(no\.?|n[uú]m(ero)?(\s*de\s*empleado)?|id|ac-?no\.?|employee\s*(id|no\.?)|person\s*id|id\s*de\s*(empleado|persona|usuario)|user\s*id|pin|clave|employee\s*no\.?)$/i;
const RX_DT = /(fecha\s*y\s*hora|fecha\/hora|date\s*\/?\s*time|datetime|check\s*time|checktime|tiempo|marcaje|time$)/i;
const RX_FECHA = /^(fecha|date)$/i;
const RX_HORA = /^(hora|time)$/i;
const RX_TIPO = /(tipo|estado|status|attendance\s*status|check\s*type)/i;

/** Detecta columnas en exportaciones de ZKTeco (ZKTime / ZKBio), Hikvision (iVMS-4200 / HikCentral) o plantilla propia. */
function interpretar(text) {
  const rows = parseCSV(text);
  if (rows.length < 2) return { error: 'El archivo no tiene datos', registros: [] };
  const h = rows[0].map((x) => x.trim());
  const iNum = h.findIndex((x) => RX_NUM.test(x));
  let iDT = h.findIndex((x) => RX_DT.test(x) && !RX_HORA.test(x));
  const iF = h.findIndex((x) => RX_FECHA.test(x));
  const iH = h.findIndex((x) => RX_HORA.test(x));
  const iT = h.findIndex((x) => RX_TIPO.test(x));
  if (iDT < 0 && !(iF >= 0 && iH >= 0)) iDT = h.findIndex((x) => /fecha|date/i.test(x));
  if (iNum < 0 || (iDT < 0 && !(iF >= 0 && iH >= 0))) {
    return { error: `No se reconocieron las columnas. Encabezados encontrados: ${h.join(' | ')}. Se necesita una columna de número de empleado y una de fecha/hora.`, registros: [] };
  }
  const registros = [], errores = [];
  rows.slice(1).forEach((r, i) => {
    const num = (r[iNum] || '').trim();
    const raw = iDT >= 0 ? r[iDT] : `${(r[iF] || '').trim()} ${(r[iH] || '').trim()}`;
    const fh = normalizeDateTime(raw);
    if (!num || !fh) { errores.push(`Fila ${i + 2}: datos inválidos (${num || 'sin número'} / ${raw || 'sin fecha'})`); return; }
    const t = iT >= 0 ? String(r[iT] || '').toLowerCase() : '';
    const tipo = /entrada|check.?in|in$|^c\/in/.test(t) ? 'entrada' : /salida|check.?out|out$|^c\/out/.test(t) ? 'salida' : null;
    registros.push({ empleado_numero: num, fecha_hora: fh, tipo });
  });
  return { columnas: { numero: h[iNum], fecha_hora: iDT >= 0 ? h[iDT] : `${h[iF]} + ${h[iH]}`, tipo: iT >= 0 ? h[iT] : null }, registros, errores };
}

module.exports = { parseCSV, interpretar };
