'use strict';
process.env.TZ = process.env.TZ || 'America/Mexico_City';

const path = require('node:path');
const express = require('express');
const { seed } = require('./src/db');
const { hashPassword } = require('./src/util');
const dispositivos = require('./src/dispositivos');
const api = require('./src/api');

seed(hashPassword);

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY === '1');

// Los checadores llaman a estas rutas (sin sesión)
app.use(dispositivos.router);

app.use('/api', api);
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});
app.get('/campo', (req, res) => res.sendFile(path.join(__dirname, 'public', 'campo.html')));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = Number(process.env.PORT || 8080);
app.listen(PORT, () => {
  console.log(`Control de asistencia en http://localhost:${PORT}`);
  console.log(`  Administración:   http://<servidor>:${PORT}/`);
  console.log(`  Personal campo:   http://<servidor>:${PORT}/campo`);
  console.log(`  ZKTeco (ADMS):    servidor <ip>  puerto ${PORT}`);
  console.log(`  Hikvision:        http://<servidor>:${PORT}/hikvision/<token>`);
});
