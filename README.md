# Control de Asistencia · Grupo Proceso Seguro

Sistema web para centralizar la asistencia de **Grupo Proceso Seguro**, **Proceso Seguro** y **Enfermería**:

| Fuente | Cómo llegan los registros |
|---|---|
| Checadores **ZKTeco** (oficinas) | El equipo envía cada checada en tiempo real por protocolo **ADMS / PUSH** |
| Checadores **ZKTeco sin ADMS** (p. ej. MB460) | El servidor **lee** el checador por IP (TCP 4370) cada 5 minutos o con el botón *Sincronizar* |
| Checadores **Hikvision** (oficinas) | El equipo envía eventos por **ISAPI HTTP Listening** |
| **Personal de campo** | Página web en el celular (`/campo`) con número de empleado + PIN, **GPS**, **geocerca** y **foto** opcional |
| Equipos sin conexión / historial | **Importación CSV** (ZKTime, ZKBio, iVMS-4200, HikCentral o plantilla) |
| Correcciones | **Registro manual** con motivo obligatorio y usuario que lo capturó |

Funciones: tablero del día, reporte de asistencia (entrada, salida, horas, retardos, faltas, salidas anticipadas, registros fuera de geocerca) exportable a Excel (CSV), empleados, horarios con tolerancia y días laborables, sedes con geocerca, usuarios administradores y supervisores (opcionalmente limitados a una empresa).

## Requisitos
- Node.js **22.13 o superior** (usa la base de datos SQLite integrada en Node; no requiere instalar un servidor de base de datos).
- Un servidor que esté **siempre encendido** y que los checadores de las oficinas puedan alcanzar por red (servidor local, VPS o nube).

## Instalación
```bash
npm install
ADMIN_PASSWORD='una-contraseña-segura' npm start
```
Al primer arranque se crea el usuario `admin`. Si no se define `ADMIN_PASSWORD`, la contraseña se genera y se muestra en consola.

Abrir `http://SERVIDOR:8080/` (administración) y `https://SERVIDOR/campo` (personal de campo).

### Variables de entorno
| Variable | Default | Descripción |
|---|---|---|
| `PORT` | `8080` | Puerto HTTP |
| `TZ` | `America/Mexico_City` | Zona horaria para registros de campo y reportes |
| `DATA_DIR` | `./data` | Carpeta de la base de datos y fotos (**respaldar**) |
| `ADMIN_PASSWORD` | aleatoria | Contraseña inicial del usuario `admin` |
| `SESSION_SECRET` | autogenerado en `data/` | Llave de firma de sesiones |
| `COOKIE_SECURE` | `0` | Poner `1` cuando el sitio se sirva sólo por HTTPS |
| `TRUST_PROXY` | `0` | Poner `1` si va detrás de Nginx / balanceador |
| `ZK_AUTO_APROBAR` | `0` | `1` = aceptar ZKTeco nuevos sin aprobación manual |
| `ZK_SYNC_MIN` | `5` | Minutos entre lecturas directas de ZKTeco (0 = desactivar) |
| `ODOO_SYNC_MIN` | `10` | Minutos entre sincronizaciones con Odoo (0 = desactivar) |
| `ODOO_RANGO_OFICINA` | `3000-3999` | Números para altas automáticas de oficina |
| `ODOO_RANGO_CAMPO` | `4000-4999` | Números que se dan de alta como personal de campo (no se envían al checador) |
| `ZK_TIMEZONE` | `-6` | Zona horaria que se envía a los ZKTeco |
| `CAMPO_EXIGIR_FOTO` | `0` | `1` = la foto es obligatoria en registros de campo |

## Instalación en Proxmox (recomendado)
1. En Proxmox: **Create CT** con plantilla **Debian 12**, 1 CPU, 1 GB RAM, 8 GB de disco. En *Network* usar el bridge de la red de las oficinas (la misma de los checadores) y, de preferencia, **IP fija**. Marcar *Start at boot*.
2. Entrar a la consola del contenedor como `root` y ejecutar:
```bash
bash <(curl -fsSL https://raw.githubusercontent.com/arturoretana-procesoseguro/ps-control-asistencia/main/deploy/instalar.sh)
```
3. El script instala Node.js 22, la aplicación en `/opt/control-asistencia`, los datos en `/var/lib/control-asistencia`, crea el servicio `control-asistencia` (arranca solo y se reinicia si falla) y muestra la dirección y la contraseña de `admin`.

Actualizar a la última versión de GitHub:
```bash
bash /opt/control-asistencia/deploy/actualizar.sh
```
Ver el registro del servicio: `journalctl -u control-asistencia -f`. Configuración: `/etc/control-asistencia.env`.

**Respaldo**: programar en Proxmox *Datacenter → Backup* un respaldo diario del contenedor.

**Migrar desde una PC**: detener el sistema en la PC (sólo debe correr una instancia, para no duplicar envíos a Odoo), copiar el contenido de su carpeta `data` a `/var/lib/control-asistencia/` y ejecutar `chown -R asistencia:asistencia /var/lib/control-asistencia && systemctl restart control-asistencia`.

## Publicación recomendada
- **HTTPS es obligatorio para el personal de campo**: los navegadores de celular sólo entregan la ubicación GPS en sitios `https://`. Publicar detrás de Nginx/Caddy con certificado (p. ej. Let's Encrypt) y un dominio como `asistencia.grupoprocesoseguro.com`.
- Los checadores ZKTeco y Hikvision pueden seguir usando **HTTP** en el puerto 8080 dentro de la red/VPN de la oficina. Si el servidor está en la nube, abrir sólo ese puerto hacia las IPs públicas de las oficinas.
- Respaldar diariamente la carpeta `data/` (base de datos `asistencia.db` y `fotos/`).

## Configuración de checadores
**ZKTeco**: Menú → Comunicación → *Servidor en la nube / ADMS*: dirección del servidor y puerto 8080. El equipo aparece como *Pendiente* en **Checadores**; al aprobarlo descarga su memoria completa (los duplicados se descartan).

**Hikvision**: dar de alta el equipo en **Checadores** para obtener su URL con token; en la web del equipo: Configuración → Red → Avanzado → *HTTP Listening*: IP, puerto 8080, URL `/hikvision/<token>`, y activar la notificación al centro de vigilancia en los eventos de control de acceso.

**ZKTeco sin ADMS (lectura directa por IP)**: en **Checadores → Agregar ZKTeco** capturar la IP del equipo (puerto 4370). Requisitos: el servidor debe estar en la misma red que el checador y la clave de comunicación del equipo debe ser 0. Botones disponibles: *Probar* (datos del equipo), *Sincronizar* (leer checadas) e *Importar empleados* (dar de alta los usuarios del checador). Sólo se leen datos; no se borra nada del equipo.

Prueba rápida desde la terminal, sin arrancar el sistema:
```bash
npm run probar-zk -- 192.168.10.231
```
En Windows PowerShell usar `npm.cmd` en lugar de `npm`.

En todos los casos, el **ID de usuario del checador debe ser igual al número de empleado** en el sistema. Los registros de números no dados de alta se conservan y se marcan en el tablero.

## Integración con Odoo
Pantalla **🔗 Odoo** (sólo administradores). Requiere una **API key** de un usuario con permisos de Empleados y Asistencias. En **Odoo Online la API externa sólo está disponible en el plan Personalizado (Custom)**.

- **Empate**: el *ID de credencial* (Badge ID) del empleado en Odoo = número del empleado en el checador (se ignoran ceros a la izquierda). Nombre, puesto y empresa se toman de Odoo.
- **Vincular**: para empleados del checador sin empate, se elige su ficha de Odoo y el sistema escribe el número como ID de credencial en Odoo (sugiere coincidencias por nombre).
- **Alta automática** (opción "Alta automática" en 🔗 Odoo): a los empleados **creados en Odoo después de activarla** que no tengan ID de credencial se les asigna el siguiente número libre (`ODOO_RANGO_OFICINA`, 3000-3999; o `ODOO_RANGO_CAMPO`, 4000-4999 si su puesto es de campo: facilitador, inplant, gestor, inspector, verificador), se escribe en Odoo como ID de credencial y se dan de alta en los checadores con "Recibir altas de Odoo" **con PIN y huella pendiente** (el PIN también se guarda en Odoo). Se excluyen los departamentos configurados (por defecto los de La Enfermería).
- **Altas**: empleados nuevos en Odoo con ID de credencial se crean aquí y, en los checadores ZKTeco con *Recibir altas de Odoo* activado, se crea el usuario en el equipo (número y nombre sin acentos, máx. 24 caracteres). La persona debe registrar su huella o rostro en el checador. Si el checador tiene sede asignada, sólo recibe empleados de esa sede o sin sede.
- **Bajas**: empleados archivados en Odoo quedan inactivos aquí (no se borran del checador).
- **Asistencias** (activado por defecto): cada par entrada/salida del día (incluido el regreso de comida) se crea en *Asistencias* de Odoo, con hora en UTC; el día en curso va con la entrada abierta. Si los pares cambian (correcciones, anulaciones) se actualizan o retiran en Odoo. Los días pasados sin salida no se envían hasta corregirse.
- Sincronización automática cada `ODOO_SYNC_MIN` minutos (10 por defecto) si está activada, o con *Sincronizar ahora*.
- Compatible con la API JSON-2 (Odoo 19+) y JSON-RPC (versiones anteriores). La API key se guarda en `data/` y nunca se envía al navegador.

## Cumplimiento: registro electrónico de la jornada (LFT art. 132 fr. XXXIV)
- **Nada se borra**: las checadas incorrectas se **anulan** con motivo; las checadas viejas y las bajas pasan al **archivo histórico** (fuera de la operación diaria, disponibles para la autoridad).
- **Bitácora** inalterable (protegida por triggers) de capturas, anulaciones, cambios de empleados, altas en checadores, depuraciones, configuración y conformidades.
- **📋 Registro de jornada**: por día inicio, fin, pares entrada/salida, descanso, horas efectivas, horas extra, medio de registro (biométrico, móvil con GPS, captura manual) e incidencias; por semana horas contra la jornada máxima (48 h en 2026, 46 en 2027, 44 en 2028, 42 en 2029, 40 desde 2030; configurable con el ajuste `jornada_max_semanal`). Exporta CSV e imprime un formato por trabajador con datos del patrón (razón social, RFC, registro patronal) y del trabajador (CURP, RFC, NSS).
- **Conformidad del trabajador**: en `/campo` cada persona (campo con su PIN; oficina con el PIN del checador) revisa su semana cerrada y la confirma; se guarda fecha, IP y un hash del detalle confirmado.
- Las disposiciones generales de la STPS (exigibles desde el 1 de enero de 2027) podrían precisar requisitos adicionales: revisar con el área legal cuando se publiquen.

## Días festivos (LFT art. 74)
Los días de descanso obligatorio se calculan automáticamente cada año: 1 de enero, primer lunes de febrero, tercer lunes de marzo, 1 de mayo, 16 de septiembre, tercer lunes de noviembre, 25 de diciembre y el 1 de octubre cada seis años (transmisión del Poder Ejecutivo; 2030, 2036…). En *Empresas y horarios → Días festivos* se agregan los días que otorga la empresa (para todas o para una empresa) y las jornadas electorales.
- Sin checadas ese día: estado **Festivo** (no es falta).
- Con checadas: **Festivo trabajado**, con la incidencia del art. 75 (salario doble además del salario) y sus horas como extra. Métrica *Festivos trabajados* en reportes personalizados.

## Depuración (🧹)
Deja sólo a los empleados activos. Requiere haber sincronizado con Odoo.
- **Se conservan**: vinculados con Odoo y activos.
- **Se dan de baja y se archivan** (en el checador ZKTeco se borra el usuario con sus huellas): archivados en Odoo, duplicados con número de más de 9 dígitos, y quienes no están en Odoo y no checan desde hace N días.
- **A revisar** (no se tocan): no están en Odoo pero checaron en los últimos N días.
- **Checadas**: las anteriores a la fecha elegida pasan al archivo histórico; las que lleguen después con fecha anterior también van al archivo.
- Opcional: vaciar la memoria de checadas del equipo (primero se leen sus últimas checadas).
- Nunca se borran los administradores del checador. Antes de aplicar se guarda un respaldo en `data/respaldos/`. Requiere escribir `DEPURAR` para confirmar.

## Copiloto con IA (✦)
Interfaz "centro de mando" (oscura por defecto; ◐ cambia a clara) con un **copiloto** siempre disponible a la derecha (Ctrl + K) que responde preguntas en español con los datos del sistema: faltas, retardos, horas trabajadas y extra, salidas sin registrar, huellas pendientes, límite legal de horas y el resumen de cualquier persona o empresa, por periodo ("hoy", "ayer", "esta semana", "el mes pasado", "en octubre", "últimos 7 días").
- **Motor local** (siempre activo): reglas y estadística dentro del servidor; ningún dato sale de la empresa.
- **Claude** (opcional, ✦ Inteligencia artificial): con una API key de Anthropic responde preguntas libres usando las mismas consultas como herramientas (SDK oficial `@anthropic-ai/sdk`, modelo configurable, `claude-opus-5-5` por defecto, con respaldo del lado del servidor si el modelo declina). Se envían a Anthropic la pregunta y los datos que la responden. Si falla o no hay internet, responde el motor local.
- La tarjeta **✦ Resumen IA** del tablero muestra hallazgos del día: retardos por encima del promedio, rachas de retardos, acumulados, cercanía a la jornada máxima y huellas pendientes.
- Los supervisores sólo obtienen datos de su empresa con ambos motores.

## Tablero, ficha y reportes (📊)
- **Tablero**: asistencia de los últimos 14 días (a tiempo, retardo, falta), distribución de horas de llegada, quién acumula más retardos, asistencia por empresa, últimas checadas y estado de checadores.
- **Ficha del empleado**: al hacer clic en cualquier nombre se abre un panel con su calendario del mes, totales (asistencias, faltas, retardos, horas, puntualidad), estado de huella y últimas checadas.
- **Reportes personalizados**: periodo, agrupación (empleado, empresa, sede, puesto, tipo, día, semana, mes, día de la semana), métricas a elegir, filtros, gráfica y tabla ordenable, exportación a CSV y plantillas guardadas.

## Huellas (☝️)
Estado por empleado y checador (sin alta, sin huella, huella pendiente, registrada), leído de las plantillas del equipo. **Agregar huella** da de alta a la persona en el checador elegido con un **PIN** (para checar mientras registra su huella), actualiza su nombre al de Odoo, guarda el PIN en Odoo y genera comprobantes para imprimir. La sincronización detecta automáticamente cuando la huella quedó registrada.

## Reglas del reporte
- Entrada = primer registro del día (o primera "entrada" explícita); salida = último registro (o última "salida").
- Retardo si la entrada es posterior a la hora de entrada + tolerancia (se reportan los minutos desde la hora de entrada).
- Falta si es día laborable del horario y no hay registros (el día en curso cuenta como *Pendiente* hasta pasar la tolerancia).
- Limitación actual: los turnos que cruzan la medianoche (nocturnos) no se calculan como un solo turno.

## Estructura
```
server.js            arranque
src/db.js            esquema SQLite y datos iniciales
src/dispositivos.js  recepción ZKTeco (ADMS) y Hikvision (ISAPI)
src/zk-pull.js       lectura directa de ZKTeco por TCP 4370
src/zk-sync.js       sincronización periódica e importación de usuarios
src/odoo.js          cliente de la API de Odoo (JSON-2 / JSON-RPC)
src/odoo-sync.js     empleados, altas al checador y asistencias con Odoo
scripts/probar-zk.js prueba de conexión con un checador ZKTeco
src/api.js           API de administración y de campo
src/reporte.js       cálculo de asistencia
src/importar.js      lectura de CSV
public/              panel de administración y página de campo
```
