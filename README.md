# Control de Asistencia · Grupo Proceso Seguro

Sistema web para centralizar la asistencia de **Grupo Proceso Seguro**, **Proceso Seguro** y **Enfermería**:

| Fuente | Cómo llegan los registros |
|---|---|
| Checadores **ZKTeco** (oficinas) | El equipo envía cada checada en tiempo real por protocolo **ADMS / PUSH** |
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
| `ZK_TIMEZONE` | `-6` | Zona horaria que se envía a los ZKTeco |
| `CAMPO_EXIGIR_FOTO` | `0` | `1` = la foto es obligatoria en registros de campo |

## Publicación recomendada
- **HTTPS es obligatorio para el personal de campo**: los navegadores de celular sólo entregan la ubicación GPS en sitios `https://`. Publicar detrás de Nginx/Caddy con certificado (p. ej. Let's Encrypt) y un dominio como `asistencia.grupoprocesoseguro.com`.
- Los checadores ZKTeco y Hikvision pueden seguir usando **HTTP** en el puerto 8080 dentro de la red/VPN de la oficina. Si el servidor está en la nube, abrir sólo ese puerto hacia las IPs públicas de las oficinas.
- Respaldar diariamente la carpeta `data/` (base de datos `asistencia.db` y `fotos/`).

## Configuración de checadores
**ZKTeco**: Menú → Comunicación → *Servidor en la nube / ADMS*: dirección del servidor y puerto 8080. El equipo aparece como *Pendiente* en **Checadores**; al aprobarlo descarga su memoria completa (los duplicados se descartan).

**Hikvision**: dar de alta el equipo en **Checadores** para obtener su URL con token; en la web del equipo: Configuración → Red → Avanzado → *HTTP Listening*: IP, puerto 8080, URL `/hikvision/<token>`, y activar la notificación al centro de vigilancia en los eventos de control de acceso.

En ambos casos, el **ID de usuario del checador debe ser igual al número de empleado** en el sistema. Los registros de números no dados de alta se conservan y se marcan en el tablero.

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
src/api.js           API de administración y de campo
src/reporte.js       cálculo de asistencia
src/importar.js      lectura de CSV
public/              panel de administración y página de campo
```
