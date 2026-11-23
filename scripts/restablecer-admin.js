'use strict';
/**
 * Restablece la contraseña de un usuario del sistema sin borrar ningún dato.
 * Uso:  npm run restablecer-admin                -> usuario "admin", contraseña nueva aleatoria
 *       npm run restablecer-admin -- juan        -> usuario "juan"
 *       npm run restablecer-admin -- admin MiClaveSegura123
 * Debe ejecutarse en el equipo donde corre el sistema (acceso directo a la carpeta data).
 */
process.env.TZ = process.env.TZ || 'America/Mexico_City';
const crypto = require('node:crypto');
const { db } = require('../src/db');
const { hashPassword, bitacora } = require('../src/util');

const usuario = process.argv[2] || 'admin';
let pass = process.argv[3];
if (pass && pass.length < 8) { console.log('\n❌ La contraseña debe tener al menos 8 caracteres.\n'); process.exit(1); }
if (!pass) pass = crypto.randomBytes(9).toString('base64url');

const u = db.prepare('SELECT id, usuario, rol FROM usuarios WHERE usuario = ?').get(usuario);
if (!u) {
  const lista = db.prepare('SELECT usuario, rol FROM usuarios ORDER BY usuario').all();
  console.log(`\n❌ No existe el usuario "${usuario}". Usuarios registrados: ${lista.map((x) => `${x.usuario} (${x.rol})`).join(', ') || 'ninguno'}\n`);
  process.exit(1);
}
db.prepare('UPDATE usuarios SET pass_hash = ? WHERE id = ?').run(hashPassword(pass), u.id);
bitacora('consola del servidor', 'Restablecimiento de contraseña', 'usuario', u.id, { usuario: u.usuario });
console.log('\n==============================================');
console.log(' Contraseña restablecida');
console.log(' Usuario:     ' + u.usuario);
console.log(' Contraseña:  ' + pass);
console.log(' Cámbiala al entrar (botón 🔑 arriba a la derecha).');
console.log('==============================================\n');
