'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { db, DATA_DIR } = require('./db');

// ---------- contraseñas / PIN ----------
function hashPassword(pass) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pass), salt, 32);
  return salt.toString('hex') + ':' + hash.toString('hex');
}
function checkPassword(pass, stored) {
  if (!stored) return false;
  const [saltHex, hashHex] = stored.split(':');
  const hash = crypto.scryptSync(String(pass), Buffer.from(saltHex, 'hex'), 32);
  return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
}

// ---------- sesiones firmadas en cookie ----------
function getSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const f = path.join(DATA_DIR, '.session_secret');
  if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  return fs.readFileSync(f, 'utf8').trim();
}
const SECRET = getSecret();

function sign(payload, hours = 12) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + hours * 3600e3 })).toString('base64url');
  const mac = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return body + '.' + mac;
}
function verify(token) {
  if (!token || !token.includes('.')) return null;
  const [body, mac] = token.split('.');
  const expected = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString());
    return data.exp > Date.now() ? data : null;
  } catch { return null; }
}
function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}
function setCookie(res, name, value, hours = 12) {
  const secure = process.env.COOKIE_SECURE === '1' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${name}=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${hours * 3600}${secure}`);
}
function clearCookie(res, name) {
  res.setHeader('Set-Cookie', `${name}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

function requireAdmin(req, res, next) {
  const s = verify(readCookie(req, 'sid'));
  if (!s || s.kind !== 'admin') return res.status(401).json({ error: 'Sesión no válida' });
  req.user = s;
  next();
}
function requireRole(rol) {
  return (req, res, next) => (req.user.rol === rol ? next() : res.status(403).json({ error: 'Sin permiso' }));
}
function requireEmpleado(req, res, next) {
  const s = verify(readCookie(req, 'eid'));
  if (!s || s.kind !== 'empleado') return res.status(401).json({ error: 'Sesión no válida' });
  req.empleado = s;
  next();
}

// ---------- fechas en hora local ----------
const TZ = process.env.TZ || 'America/Mexico_City';
function nowLocal() {
  // 'YYYY-MM-DD HH:MM:SS' en la zona configurada
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date()).reduce((a, x) => ((a[x.type] = x.value), a), {});
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}
function normalizeDateTime(s) {
  // Acepta 'YYYY-MM-DD HH:MM[:SS]', 'YYYY-MM-DDTHH:MM:SS-06:00', 'DD/MM/YYYY HH:MM[:SS]'
  if (!s) return null;
  s = String(s).trim();
  let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')} ${m[4].padStart(2, '0')}:${m[5]}:${m[6] || '00'}`;
  m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')} ${m[4].padStart(2, '0')}:${m[5]}:${m[6] || '00'}`;
  return null;
}

// ---------- geocerca ----------
function distanciaMetros(lat1, lng1, lat2, lng2) {
  const R = 6371000, rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1), dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ---------- inserción de registros (con deduplicación) ----------
const insRegistro = db.prepare(`
  INSERT OR IGNORE INTO registros
    (empleado_numero, fecha_hora, tipo, origen, dispositivo_id, lat, lng, precision_m, distancia_m, dentro_geocerca, foto, nota, creado_por)
  VALUES (@empleado_numero, @fecha_hora, @tipo, @origen, @dispositivo_id, @lat, @lng, @precision_m, @distancia_m, @dentro_geocerca, @foto, @nota, @creado_por)`);
function guardarRegistro(r) {
  const row = {
    empleado_numero: String(r.empleado_numero).trim(), fecha_hora: r.fecha_hora, tipo: r.tipo ?? null,
    origen: r.origen, dispositivo_id: r.dispositivo_id ?? null, lat: r.lat ?? null, lng: r.lng ?? null,
    precision_m: r.precision_m ?? null, distancia_m: r.distancia_m ?? null, dentro_geocerca: r.dentro_geocerca ?? null,
    foto: r.foto ?? null, nota: r.nota ?? null, creado_por: r.creado_por ?? null,
  };
  return insRegistro.run(row).changes;
}

function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function toCSV(headers, rows) {
  return '﻿' + [headers.map((h) => csvEscape(h.label)).join(','),
    ...rows.map((r) => headers.map((h) => csvEscape(r[h.key])).join(','))].join('\r\n');
}

module.exports = {
  hashPassword, checkPassword, sign, verify, readCookie, setCookie, clearCookie,
  requireAdmin, requireRole, requireEmpleado, nowLocal, normalizeDateTime, distanciaMetros,
  guardarRegistro, toCSV, TZ,
};
