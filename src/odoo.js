'use strict';
/**
 * Cliente mínimo de la API externa de Odoo.
 * Usa la API JSON-2 (Odoo 19+: POST /json/2/<modelo>/<método> con "Authorization: bearer <API key>")
 * y, si no existe en la instancia, recurre a JSON-RPC (/jsonrpc, versiones anteriores).
 * Requiere un usuario de Odoo con API key y permisos de Empleados y Asistencias.
 * Nota: en Odoo Online la API externa sólo está disponible en el plan "Personalizado" (Custom).
 */
class OdooError extends Error {}

class Odoo {
  constructor({ url, db, login, apiKey }) {
    this.url = String(url || '').trim().replace(/\/+$/, '');
    if (this.url && !/^https?:\/\//.test(this.url)) this.url = 'https://' + this.url;
    this.db = String(db || '').trim() || (this.url.match(/^https?:\/\/([^.]+)\.odoo\.com/) || [])[1] || '';
    this.login = String(login || '').trim();
    this.apiKey = String(apiKey || '').trim();
    this.modo = null; // 'json2' | 'jsonrpc'
    this.uid = null;
    if (!this.url || !this.apiKey) throw new OdooError('Falta la dirección de Odoo o la API key');
  }

  async _fetch(path, body, headers = {}) {
    let r;
    try {
      r = await fetch(this.url + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'control-asistencia', ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      });
    } catch (e) {
      throw new OdooError(`No se pudo conectar con ${this.url}: ${e.cause?.code || e.message}`);
    }
    const text = await r.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* respuesta no JSON */ }
    return { status: r.status, data, text };
  }

  async _json2(model, method, body) {
    const h = { Authorization: `bearer ${this.apiKey}` };
    if (this.db) h['X-Odoo-Database'] = this.db;
    const r = await this._fetch(`/json/2/${model}/${method}`, body, h);
    if (r.status === 404 && !r.data) return { noDisponible: true };
    if (r.status >= 400) {
      const m = r.data?.message || r.data?.name || r.text.slice(0, 200);
      if (r.status === 401) throw new OdooError('Odoo rechazó la API key (401). Revisa que sea correcta y no haya expirado.');
      if (r.status === 403) throw new OdooError('El usuario de la API key no tiene permiso: ' + m);
      throw new OdooError(`Odoo respondió ${r.status}: ${m}`);
    }
    return { data: r.data };
  }

  async _rpc(service, method, args) {
    const r = await this._fetch('/jsonrpc', { jsonrpc: '2.0', method: 'call', id: Date.now(), params: { service, method, args } });
    if (r.status >= 400 && !r.data) throw new OdooError(`Odoo respondió ${r.status}`);
    if (r.data?.error) {
      const e = r.data.error;
      throw new OdooError(e.data?.message || e.message || 'Error de Odoo');
    }
    return r.data?.result;
  }

  async _loginRpc() {
    if (this.uid) return;
    if (!this.login) throw new OdooError('Esta versión de Odoo requiere también el usuario (correo) del dueño de la API key');
    if (!this.db) throw new OdooError('Indica el nombre de la base de datos de Odoo');
    const uid = await this._rpc('common', 'authenticate', [this.db, this.login, this.apiKey, {}]);
    if (!uid) throw new OdooError('Usuario o API key incorrectos');
    this.uid = uid;
  }

  /** Llama a un método. kwargs con nombres (domain, fields, vals_list, vals, ids...) */
  async call(model, method, kwargs = {}) {
    if (this.modo !== 'jsonrpc') {
      const r = await this._json2(model, method, kwargs);
      if (!r.noDisponible) { this.modo = 'json2'; return r.data; }
      this.modo = 'jsonrpc';
    }
    await this._loginRpc();
    // Traducción a execute_kw (argumentos posicionales)
    const { ids, ...kw } = kwargs;
    let args = [];
    if (method === 'search_read') { args = [kw.domain || []]; delete kw.domain; }
    else if (method === 'create') { args = [kw.vals_list]; delete kw.vals_list; }
    else if (method === 'write') { args = [ids, kw.vals]; delete kw.vals; }
    else if (method === 'unlink') { args = [ids]; }
    else if (ids) args = [ids];
    return this._rpc('object', 'execute_kw', [this.db, this.uid, this.apiKey, model, method, args, kw]);
  }

  searchRead(model, domain, fields, extra = {}) { return this.call(model, 'search_read', { domain, fields, ...extra }); }
  async create(model, vals) { const r = await this.call(model, 'create', { vals_list: [vals] }); return Array.isArray(r) ? r[0] : r; }
  write(model, id, vals) { return this.call(model, 'write', { ids: [id], vals }); }
  unlink(model, ids) { return this.call(model, 'unlink', { ids }); }

  async version() {
    const r = await this._fetch('/web/webclient/version_info', { jsonrpc: '2.0', method: 'call', params: {} });
    return r.data?.result?.server_version || null;
  }
}

/** 'YYYY-MM-DD HH:MM:SS' en la zona local -> 'YYYY-MM-DD HH:MM:SS' UTC (formato de Odoo) */
function localAUtc(fh, tz = process.env.TZ || 'America/Mexico_City') {
  const [d, t] = fh.split(' ');
  const [y, mo, da] = d.split('-').map(Number);
  const [h, mi, s] = t.split(':').map(Number);
  const guess = Date.UTC(y, mo - 1, da, h, mi, s || 0);
  const offset = (ms) => {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(ms)).reduce((a, x) => ((a[x.type] = x.value), a), {});
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - ms;
  };
  let ms = guess - offset(guess);
  ms = guess - offset(ms);
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

module.exports = { Odoo, OdooError, localAUtc };
