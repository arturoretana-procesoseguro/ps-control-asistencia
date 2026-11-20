'use strict';
const { db } = require('./db');
const { nowLocal, guardarRegistro } = require('./util');
const { leerChecadas, leerUsuarios, infoEquipo, explicarError } = require('./zk-pull');

const ocupados = new Set();
const errMsg = (e) => explicarError(e).slice(0, 300);

async function sincronizar(dev) {
  if (!dev.ip_lectura) throw new Error('El checador no tiene IP de lectura configurada');
  if (ocupados.has(dev.id)) throw new Error('Ya hay una sincronización en curso para este checador');
  ocupados.add(dev.id);
  try {
    const checadas = await leerChecadas(dev.ip_lectura, dev.puerto || 4370);
    let nuevas = 0;
    db.exec('BEGIN');
    try {
      for (const c of checadas) nuevas += guardarRegistro({ ...c, origen: 'zkteco', dispositivo_id: dev.id });
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    const ahora = nowLocal();
    db.prepare('UPDATE dispositivos SET ultima_sincronizacion = ?, ultimo_contacto = ?, ultimo_error = NULL, ip = ? WHERE id = ?')
      .run(ahora, ahora, dev.ip_lectura, dev.id);
    if (nuevas) console.log(`[ZKTeco ${dev.nombre}] sincronizado: ${nuevas} checadas nuevas de ${checadas.length}`);
    return { leidas: checadas.length, nuevas };
  } catch (e) {
    db.prepare('UPDATE dispositivos SET ultimo_error = ? WHERE id = ?').run(`${nowLocal()} · ${errMsg(e)}`, dev.id);
    throw new Error('No se pudo leer el checador: ' + errMsg(e));
  } finally {
    ocupados.delete(dev.id);
  }
}

async function probar(dev) {
  if (!dev.ip_lectura) throw new Error('El checador no tiene IP de lectura configurada');
  try { return await infoEquipo(dev.ip_lectura, dev.puerto || 4370); }
  catch (e) { throw new Error('Sin conexión con el checador: ' + errMsg(e)); }
}

/** Crea en el sistema los usuarios del checador que aún no existan (no modifica los existentes). */
async function importarUsuarios(dev, { empresa_id, sede_id, horario_id, tipo }) {
  if (!dev.ip_lectura) throw new Error('El checador no tiene IP de lectura configurada');
  let usuarios;
  try { usuarios = await leerUsuarios(dev.ip_lectura, dev.puerto || 4370); }
  catch (e) { throw new Error('No se pudo leer el checador: ' + errMsg(e)); }
  const ins = db.prepare(`INSERT OR IGNORE INTO empleados (numero, nombre, empresa_id, sede_id, horario_id, tipo, activo)
                          VALUES (?, ?, ?, ?, ?, ?, 1)`);
  let creados = 0;
  for (const u of usuarios) {
    creados += ins.run(u.numero, u.nombre || `Empleado ${u.numero}`, empresa_id ?? null, sede_id ?? null, horario_id ?? null, tipo || 'oficina').changes;
  }
  return { en_checador: usuarios.length, creados, ya_existian: usuarios.length - creados };
}

function iniciarProgramador() {
  const min = Number(process.env.ZK_SYNC_MIN ?? 5);
  if (!min) return;
  const tick = async () => {
    const devs = db.prepare("SELECT * FROM dispositivos WHERE marca = 'zkteco' AND estado = 'activo' AND ip_lectura IS NOT NULL AND ip_lectura <> ''").all();
    for (const d of devs) {
      if (ocupados.has(d.id)) continue;
      try { await sincronizar(d); } catch (e) { console.log(`[ZKTeco ${d.nombre}] ${e.message}`); }
    }
  };
  setTimeout(tick, 5000);
  setInterval(tick, min * 60e3);
  console.log(`  Lectura directa ZKTeco (TCP 4370): cada ${min} min`);
}

module.exports = { sincronizar, probar, importarUsuarios, iniciarProgramador };
