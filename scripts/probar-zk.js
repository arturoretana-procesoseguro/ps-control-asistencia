'use strict';
/**
 * Prueba de conexión con un checador ZKTeco por TCP 4370. Sólo lee, no modifica nada.
 * Uso:  npm run probar-zk -- 192.168.10.231 [4370]
 */
process.env.TZ = process.env.TZ || 'America/Mexico_City';
const { infoEquipo, leerUsuarios, leerChecadas, explicarError } = require('../src/zk-pull');

const ip = process.argv[2];
const puerto = Number(process.argv[3] || 4370);
if (!ip) {
  console.log('Uso: npm run probar-zk -- <IP del checador> [puerto]');
  console.log('Ej.: npm run probar-zk -- 192.168.10.231');
  process.exit(1);
}

// La biblioteca imprime errores internos muy técnicos; los ocultamos y mostramos un resumen claro.
const consoleError = console.error;
console.error = () => {};

(async () => {
  console.log(`\nConectando con ${ip}:${puerto} ...`);
  try {
    const info = await infoEquipo(ip, puerto);
    console.log('\n✅ CONEXIÓN EXITOSA (' + (info.conexion || 'tcp').toUpperCase() + ')');
    console.log('  Número de serie : ' + (info.serie ?? '-'));
    console.log('  Modelo / nombre : ' + (info.nombre ?? '-'));
    console.log('  Firmware        : ' + (info.firmware ?? '-'));
    console.log('  Plataforma      : ' + (info.plataforma ?? '-'));
    console.log('  Hora del equipo : ' + (info.hora_equipo ?? '-') + '   (hora de esta PC: ' + new Date().toLocaleString('es-MX') + ')');
    console.log('  Usuarios        : ' + (info.usuarios ?? '-'));
    console.log('  Checadas        : ' + (info.checadas ?? '-'));

    const usuarios = await leerUsuarios(ip, puerto);
    console.log(`\n👥 Usuarios leídos: ${usuarios.length}`);
    for (const u of usuarios.slice(0, 10)) console.log(`   ${u.numero.padEnd(8)} ${u.nombre}`);
    if (usuarios.length > 10) console.log('   ...');

    console.log('\n⏱  Leyendo checadas (puede tardar si hay muchas)...');
    const checadas = await leerChecadas(ip, puerto);
    checadas.sort((a, b) => a.fecha_hora.localeCompare(b.fecha_hora));
    console.log(`   Checadas leídas: ${checadas.length}`);
    if (checadas.length) {
      console.log(`   Desde ${checadas[0].fecha_hora}  hasta ${checadas[checadas.length - 1].fecha_hora}`);
      console.log('   Últimas 10:');
      for (const c of checadas.slice(-10)) console.log(`   ${c.fecha_hora}  No. ${c.empleado_numero.padEnd(8)} ${c.tipo || ''}`);
    }
    console.log('\n✅ Se pueden obtener los datos de este checador. No se modificó nada en el equipo.\n');
    process.exit(0);
  } catch (e) {
    console.error = consoleError;
    console.log('\n❌ NO SE PUDO LEER EL CHECADOR');
    console.log('   ' + explicarError(e));
    console.log('');
    process.exit(2);
  }
})();
