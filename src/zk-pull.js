'use strict';
/**
 * Lectura directa de checadores ZKTeco por TCP 4370 (protocolo del SDK).
 * Sirve para equipos sin ADMS (p. ej. MB460 con firmware antiguo).
 * Requisito: el servidor debe estar en la misma red que el checador.
 * Sólo lee: no borra ni modifica nada en el equipo.
 */
const Zkteco = require('zkteco-js');

// La biblioteca escribe en consola en cada conexión; se filtran esos mensajes.
const _log = console.log;
console.log = (...a) => { if (typeof a[0] === 'string' && /^(TCP|UDP) (re)?connection successful/.test(a[0])) return; _log(...a); };

/** Obtiene el error original (la biblioteca lo envuelve varias veces) y lo explica en español. */
function explicarError(e) {
  let x = e;
  for (let i = 0; i < 5 && x && x.err && typeof x.err === 'object'; i++) x = x.err;
  const code = x?.code || '';
  const msg = String(x?.message || code || e?.message || e);
  const t = `${code} ${msg}`;
  if (/ECONNREFUSED/.test(t)) return 'El checador rechazó la conexión (revisa IP y puerto, normalmente 4370).';
  if (/EHOSTUNREACH|ENETUNREACH/.test(t)) return 'No hay ruta a esa IP: el servidor no está en la misma red que el checador.';
  if (/ECONNRESET/.test(t)) return 'El checador cortó la conexión. Puede que otro programa (ZKTime, ZKAccess) lo esté usando en este momento.';
  if (/TIMEOUT|ETIMEDOUT/i.test(t)) return 'El checador no respondió a tiempo. Revisa que esté encendido, con cable de red y en la misma red.';
  if (/UNAUTH|2005/.test(t)) return 'El checador pide clave de comunicación. Cámbiala a 0 en el equipo.';
  return msg;
}

const pad = (n) => String(n).padStart(2, '0');
function fechaLocal(v) {
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

async function conLectura(ip, puerto, fn, timeoutMs = 10000) {
  const dev = new Zkteco(ip, Number(puerto) || 4370, timeoutMs, 4000);
  try {
    await dev.createSocket();
    return await fn(dev);
  } finally {
    try { await dev.disconnect(); } catch { /* ignorar */ }
  }
}

async function intentar(fn) {
  try { const v = await fn(); return typeof v === 'string' ? v.replace(/\0/g, '').trim() : v; } catch { return null; }
}

/** Datos generales del equipo + conteos (para diagnóstico). */
async function infoEquipo(ip, puerto) {
  return conLectura(ip, puerto, async (dev) => {
    const info = await intentar(() => dev.getInfo());
    return {
      conexion: dev.connectionType,
      serie: await intentar(() => dev.getSerialNumber()),
      nombre: await intentar(() => dev.getDeviceName()),
      firmware: await intentar(() => dev.getFirmware()),
      plataforma: await intentar(() => dev.getPlatform()),
      hora_equipo: await intentar(async () => fechaLocal(await dev.getTime())),
      usuarios: info?.userCounts ?? null,
      checadas: info?.logCounts ?? null,
    };
  });
}

/** Usuarios dados de alta en el checador: [{numero, nombre}] */
async function leerUsuarios(ip, puerto) {
  return conLectura(ip, puerto, async (dev) => {
    const r = await dev.getUsers();
    return (r?.data || []).map((u) => ({
      numero: String(u.userId ?? u.user_id ?? u.uid ?? '').trim(),
      nombre: String(u.name || '').trim(),
      uid: Number(u.uid) || null,
      admin: Number(u.role) > 0,
    })).filter((u) => u.numero);
  }, 30000);
}

/** Checadas guardadas en el checador: [{empleado_numero, fecha_hora, tipo}] */
async function leerChecadas(ip, puerto) {
  const tipoPorEstado = { 0: 'entrada', 1: 'salida', 2: 'salida', 3: 'entrada', 4: 'entrada', 5: 'salida' };
  return conLectura(ip, puerto, async (dev) => {
    const r = await dev.getAttendances();
    return (r?.data || []).map((x) => ({
      empleado_numero: String(x.user_id ?? x.userId ?? '').trim(),
      fecha_hora: fechaLocal(x.record_time),
      tipo: tipoPorEstado[x.state] ?? null,
    })).filter((x) => x.empleado_numero && x.fecha_hora);
  }, 120000);
}

/** Nombre compatible con el checador: sin acentos, sólo ASCII, máximo 24 caracteres. */
function nombreChecador(n) {
  return String(n || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ñ/g, 'n').replace(/Ñ/g, 'N')
    .replace(/[^\x20-\x7E]/g, '').replace(/\s+/g, ' ').trim().slice(0, 24);
}

/**
 * Da de alta usuarios en el checador (sin huella/rostro: la persona debe enrolarse en el equipo).
 * No modifica ni borra usuarios existentes. usuarios: [{numero, nombre}]
 */
async function crearUsuarios(ip, puerto, usuarios) {
  return conLectura(ip, puerto, async (dev) => {
    const r = await dev.getUsers();
    const existentes = r?.data || [];
    const numeros = new Set(existentes.map((u) => String(u.userId ?? u.user_id ?? '').trim()));
    let uid = existentes.reduce((m, u) => Math.max(m, Number(u.uid) || 0), 0);
    const creados = [], omitidos = [];
    for (const u of usuarios) {
      const numero = String(u.numero).trim();
      if (numeros.has(numero)) { omitidos.push({ numero, motivo: 'ya existe en el checador' }); continue; }
      if (!/^[0-9A-Za-z]{1,9}$/.test(numero)) { omitidos.push({ numero, motivo: 'el número debe tener máximo 9 letras o dígitos' }); continue; }
      uid += 1;
      if (uid > 3000) { omitidos.push({ numero, motivo: 'el checador no admite más usuarios' }); continue; }
      await dev.setUser(uid, numero, nombreChecador(u.nombre), '', 0, 0);
      numeros.add(numero);
      creados.push({ numero, nombre: nombreChecador(u.nombre), uid });
    }
    if (creados.length) { try { await dev.executeCmd(1013, ''); } catch { /* CMD_REFRESHDATA opcional */ } }
    return { creados, omitidos };
  }, 60000);
}

/** Borra usuarios del checador por número (con sus huellas). Nunca borra administradores del equipo. */
async function borrarUsuarios(ip, puerto, numeros) {
  const quitar = new Set(numeros.map(String));
  return conLectura(ip, puerto, async (dev) => {
    const r = await dev.getUsers();
    const borrados = [], protegidos = [];
    for (const u of r?.data || []) {
      const numero = String(u.userId ?? u.user_id ?? '').trim();
      if (!quitar.has(numero)) continue;
      if (Number(u.role) > 0) { protegidos.push(numero); continue; }
      await dev.deleteUser(Number(u.uid));
      borrados.push(numero);
    }
    if (borrados.length) { try { await dev.executeCmd(1013, ''); } catch { /* opcional */ } }
    return { borrados, protegidos };
  }, 60000);
}

/** Vacía la memoria de checadas del equipo (llamar sólo después de haberlas leído). */
async function vaciarChecadas(ip, puerto) {
  return conLectura(ip, puerto, (dev) => dev.clearAttendanceLog(), 30000);
}

module.exports = { borrarUsuarios, vaciarChecadas, infoEquipo, leerUsuarios, leerChecadas, crearUsuarios, nombreChecador, fechaLocal, explicarError };
