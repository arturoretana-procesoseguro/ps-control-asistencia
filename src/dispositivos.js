'use strict';
/**
 * Recepción de registros desde checadores físicos.
 *
 *  ZKTeco  -> protocolo ADMS / PUSH (menú del equipo: Comunicación > Servidor en la nube / ADMS).
 *             El equipo llama a  http://SERVIDOR:PUERTO/iclock/cdata?SN=...
 *  Hikvision -> ISAPI "HTTP Listening" (Configuración > Red > Avanzado > HTTP Listening / Centro de alarmas).
 *             El equipo envía eventos a  http://SERVIDOR:PUERTO/hikvision/<token del dispositivo>
 */
const express = require('express');
const crypto = require('node:crypto');
const { db } = require('./db');
const { nowLocal, normalizeDateTime, guardarRegistro } = require('./util');

const router = express.Router();
const ip = (req) => (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

// ======================= ZKTeco (ADMS / PUSH) =======================
const zkText = express.text({ type: () => true, limit: '20mb' });
const zkStatusTipo = { 0: 'entrada', 1: 'salida', 2: 'salida', 3: 'entrada', 4: 'entrada', 5: 'salida' };

function zkDevice(req) {
  const sn = String(req.query.SN || req.query.sn || '').trim();
  if (!sn) return null;
  let dev = db.prepare("SELECT * FROM dispositivos WHERE serie = ? AND marca = 'zkteco'").get(sn);
  if (!dev) {
    const estado = process.env.ZK_AUTO_APROBAR === '1' ? 'activo' : 'pendiente';
    db.prepare("INSERT INTO dispositivos (nombre, marca, serie, estado) VALUES (?, 'zkteco', ?, ?)")
      .run('ZKTeco ' + sn, sn, estado);
    dev = db.prepare('SELECT * FROM dispositivos WHERE serie = ?').get(sn);
  }
  db.prepare('UPDATE dispositivos SET ultimo_contacto = ?, ip = ? WHERE id = ?').run(nowLocal(), ip(req), dev.id);
  return dev;
}

function zkHandshake(req, res) {
  const dev = zkDevice(req);
  if (!dev) return res.status(400).type('text').send('ERROR');
  const tzHours = Number(process.env.ZK_TIMEZONE || -6);
  res.type('text').send([
    `GET OPTION FROM: ${dev.serie}`,
    'ATTLOGStamp=None', 'OPERLOGStamp=9999', 'ATTPHOTOStamp=None',
    'ErrorDelay=30', 'Delay=10', 'TransTimes=00:00;14:05', 'TransInterval=1',
    'TransFlag=TransData AttLog', `TimeZone=${tzHours}`, 'Realtime=1', 'Encrypt=None', '',
  ].join('\n'));
}

function zkData(req, res) {
  const dev = zkDevice(req);
  if (!dev) return res.status(400).type('text').send('ERROR');
  const table = String(req.query.table || '').toUpperCase();
  if (table !== 'ATTLOG') return res.type('text').send('OK');
  // Mientras el equipo no esté aprobado, se rechaza para que el equipo conserve y reintente los registros.
  if (dev.estado !== 'activo') return res.status(403).type('text').send('ERROR: dispositivo no autorizado');

  const lines = String(req.body || '').split(/\r?\n/).filter((l) => l.trim());
  let nuevos = 0;
  for (const line of lines) {
    // PIN \t YYYY-MM-DD HH:MM:SS \t estado \t verificación \t workcode ...
    const f = line.split('\t');
    const fecha = normalizeDateTime(f[1]);
    if (!f[0] || !fecha) continue;
    nuevos += guardarRegistro({
      empleado_numero: f[0], fecha_hora: fecha, tipo: zkStatusTipo[f[2]] ?? null,
      origen: 'zkteco', dispositivo_id: dev.id,
    });
  }
  res.type('text').send(`OK: ${lines.length}`);
  if (nuevos) console.log(`[ZKTeco ${dev.serie}] ${nuevos} registros nuevos`);
}

for (const p of ['/iclock/cdata', '/iclock/cdata.aspx']) {
  router.get(p, zkHandshake);
  router.post(p, zkText, zkData);
}
for (const p of ['/iclock/getrequest', '/iclock/getrequest.aspx']) {
  router.get(p, (req, res) => { zkDevice(req); res.type('text').send('OK'); });
}
for (const p of ['/iclock/devicecmd', '/iclock/devicecmd.aspx']) {
  router.post(p, zkText, (req, res) => { zkDevice(req); res.type('text').send('OK'); });
}

// ======================= Hikvision (ISAPI HTTP Listening) =======================
const hikRaw = express.raw({ type: () => true, limit: '20mb' });

function parseHikBody(req) {
  const buf = req.body instanceof Buffer ? req.body : Buffer.from(String(req.body || ''));
  const ctype = String(req.headers['content-type'] || '');
  const events = [];
  const tryPart = (text) => {
    const t = text.trim();
    if (t.startsWith('{')) {
      try { events.push(JSON.parse(t)); } catch { /* ignorar */ }
    } else if (t.startsWith('<')) {
      const g = (tag) => (t.match(new RegExp(`<${tag}>([^<]*)</${tag}>`)) || [])[1];
      events.push({
        dateTime: g('dateTime'), eventType: g('eventType'), serialNo: g('serialNumber'),
        AccessControllerEvent: { employeeNoString: g('employeeNoString') || g('employeeNo'), attendanceStatus: g('attendanceStatus') },
      });
    }
  };
  const boundary = (ctype.match(/boundary="?([^";]+)"?/i) || [])[1];
  if (boundary) {
    const raw = buf.toString('latin1');
    for (const part of raw.split('--' + boundary)) {
      const idx = part.indexOf('\r\n\r\n');
      if (idx < 0) continue;
      const headers = part.slice(0, idx);
      if (/content-type:\s*image\//i.test(headers)) continue; // fotos del evento
      tryPart(Buffer.from(part.slice(idx + 4), 'latin1').toString('utf8'));
    }
  } else {
    tryPart(buf.toString('utf8'));
  }
  return events;
}

router.post('/hikvision/:token', hikRaw, (req, res) => {
  const dev = db.prepare("SELECT * FROM dispositivos WHERE token = ? AND marca = 'hikvision'").get(req.params.token);
  if (!dev) return res.status(404).type('text').send('dispositivo desconocido');
  db.prepare('UPDATE dispositivos SET ultimo_contacto = ?, ip = ? WHERE id = ?').run(nowLocal(), ip(req), dev.id);
  if (dev.estado !== 'activo') return res.status(403).type('text').send('dispositivo inactivo');

  let nuevos = 0;
  for (const ev of parseHikBody(req)) {
    const ace = ev.AccessControllerEvent || ev.AcsEvent || {};
    const numero = ace.employeeNoString || ace.employeeNo || ev.employeeNoString;
    if (!numero) continue; // latidos, apertura de puerta, desconocidos, etc.
    const fecha = normalizeDateTime(ev.dateTime || ace.time);
    if (!fecha) continue;
    const st = String(ace.attendanceStatus || '').toLowerCase();
    const tipo = st.includes('checkin') || st.includes('breakin') ? 'entrada'
      : st.includes('checkout') || st.includes('breakout') ? 'salida' : null;
    nuevos += guardarRegistro({ empleado_numero: numero, fecha_hora: fecha, tipo, origen: 'hikvision', dispositivo_id: dev.id });
  }
  if (nuevos) console.log(`[Hikvision ${dev.nombre}] ${nuevos} registros nuevos`);
  res.type('text').send('OK');
});

function nuevoToken() { return crypto.randomBytes(18).toString('base64url'); }

module.exports = { router, nuevoToken, parseHikBody };
