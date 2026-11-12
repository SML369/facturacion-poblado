// ===================== SUPABASE CONFIG =====================
const SUPA_URL = 'https://hlldcoemekqecqhtuahx.supabase.co';
const SUPA_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhsbGRjb2VtZWtxZWNxaHR1YWh4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA5NTM0NTMsImV4cCI6MjEwNjUyOTQ1M30.x-yGOivwv17y-xTd0hZniV5N3v0DVlCeDByDkOfnlcQ';
// La llave anon es publica; lo que protege los datos es el login (RLS solo permite usuarios autenticados).
const sb = supabase.createClient(SUPA_URL, SUPA_KEY);

async function headers() {
  const { data } = await sb.auth.getSession();
  if (!data.session) throw new Error('No hay sesión activa o no hay conexión. Revisa el internet; si sigue igual, recarga la página y vuelve a entrar.');
  return { 'Content-Type': 'application/json', apikey: SUPA_KEY, Authorization: 'Bearer ' + data.session.access_token };
}

// Supabase devuelve maximo 1000 filas por consulta: se pagina.
// Si una pagina falla se lanza el error: devolver datos a medias haria ver la app vacia
// y una reimportacion crearia duplicados.
async function sbGetAll(tabla) {
  const todas = [];
  for (let desde = 0; ; desde += 1000) {
    const r = await fetch(`${SUPA_URL}/rest/v1/${tabla}?select=*&order=id&offset=${desde}&limit=1000`, { headers: await headers() });
    if (!r.ok) throw new Error(`No se pudo leer ${tabla}: ${r.status}`);
    const filas = await r.json();
    todas.push(...filas);
    if (filas.length < 1000) return todas;
  }
}
async function sbUpsert(tabla, row) {
  const r = await fetch(`${SUPA_URL}/rest/v1/${tabla}`, {
    method: 'POST', headers: { ...(await headers()), Prefer: 'resolution=merge-duplicates' }, body: JSON.stringify(row),
  });
  if (!r.ok) throw new Error(`Error al guardar en ${tabla}: ${r.status}`);
}
// POST / PATCH / DELETE devolviendo las filas afectadas.
async function sbRequest(method, ruta, body) {
  const r = await fetch(`${SUPA_URL}/rest/v1/${ruta}`, {
    method, headers: { ...(await headers()), Prefer: 'return=representation' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
}

// ===================== pdf.js SETUP =====================
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

async function extractPdfText(arrayBuffer) {
  // Las facturas DIAN son texto corrido normal: agrupar por linea (Y) funciona bien.
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer, isEvalSupported: false }).promise;
  let fullText = '';
  const TOL = 1.5;
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const items = content.items.filter(it => it.str && it.str.trim());
    items.sort((a, b) => b.transform[5] - a.transform[5] || a.transform[4] - b.transform[4]);
    const lines = [];
    let current = [];
    let currentY = null;
    for (const it of items) {
      const y = it.transform[5];
      if (currentY === null || Math.abs(y - currentY) <= TOL) {
        current.push(it);
        if (currentY === null) currentY = y;
      } else {
        lines.push(current);
        current = [it];
        currentY = y;
      }
    }
    if (current.length) lines.push(current);
    for (const line of lines) {
      line.sort((a, b) => a.transform[4] - b.transform[4]);
      fullText += line.map(i => i.str).join(' ') + '\n';
    }
    fullText += '\n';
  }
  return fullText;
}

// Los "Recibo de Pago" son un formulario de DOS COLUMNAS: el campo izquierdo y el
// derecho de una misma fila visual comparten casi la misma coordenada Y, así que
// agrupar por línea los mezcla. Hay que separar primero por columna (el hueco más
// grande entre coordenadas X de la página) y leer cada columna de arriba a abajo.
async function extractPdfColumns(arrayBuffer) {
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer, isEvalSupported: false }).promise;
  const page = await pdf.getPage(1);
  const content = await page.getTextContent();
  const items = content.items.filter(it => it.str && it.str.trim());
  if (items.length < 4) return { left: [], right: [] };
  const xs = items.map(it => it.transform[4]).sort((a, b) => a - b);
  let maxGap = 0, splitAt = xs[0];
  for (let i = 1; i < xs.length; i++) {
    const gap = xs[i] - xs[i - 1];
    if (gap > maxGap) { maxGap = gap; splitAt = (xs[i] + xs[i - 1]) / 2; }
  }
  const left = items.filter(it => it.transform[4] < splitAt).sort((a, b) => b.transform[5] - a.transform[5]).map(i => i.str.trim());
  const right = items.filter(it => it.transform[4] >= splitAt).sort((a, b) => b.transform[5] - a.transform[5]).map(i => i.str.trim());
  return { left, right };
}

function limpiarColumna(arr) {
  return arr.filter(l =>
    !l.startsWith('Dirección') && !l.startsWith('Teléfono') && !l.startsWith('www.') &&
    !l.startsWith('Firma') && !l.startsWith('Recibo de Pago')
  );
}

// ===================== REGLAS DE PARSEO (mismas que conciliar_facturacion.js) =====================
const MESES = { enero:1,febrero:2,marzo:3,abril:4,mayo:5,junio:6,julio:7,agosto:8,septiembre:9,octubre:10,noviembre:11,diciembre:12 };

const CORRECCIONES_FACTURA = {
  JMA602: { total: 28470683, retencionPct: 0.10 },
};

function normFactura(s) {
  if (!s) return '';
  return s.toUpperCase().replace(/[^A-Z0-9]/g, '');
}
function parseUSNumber(s) {
  if (!s) return NaN;
  return parseFloat(s.replace(/,/g, '').trim());
}
function parseCONumber(s) {
  if (!s) return NaN;
  return parseFloat(s.replace(/\./g, '').replace(',', '.').trim());
}
function parseSpanishLongDate(s) {
  const m = s.match(/(\d{1,2})\s+de\s+([a-zñáéíóú]+)\s+de\s+(\d{4})/i);
  if (!m) return null;
  const mes = MESES[m[2].toLowerCase()];
  if (!mes) return null;
  return new Date(parseInt(m[3]), mes - 1, parseInt(m[1]));
}
// Fecha local (no UTC): con toISOString el id del abono cambiaria segun la zona horaria del dispositivo.
function isoDate(d) {
  return d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : 'sinfecha';
}

function parseFacturaText(text, filename) {
  if (/^Comprobante/i.test(filename)) {
    return { skipped: true, archivo: filename, razon: 'No es una factura (comprobante de pago / transferencia)' };
  }
  let m = text.match(/FACTURA\s+(?:ELECTR[ÓO]NICA\s+DE\s+VENTA|DE\s+VENTA\s+NACIONAL)\s*:\s*(JMA[\s_-]?\d+)/i);
  if (m) {
    const factura = normFactura(m[1]);
    const fechaM = text.match(/FECHA DE EMISI[ÓO]N[\s\S]*?DIA\s+MES\s+A[ÑN]O\s*\n?\s*(\d{2})\s+(\d{2})\s+(\d{4})/i);
    let fecha = fechaM ? new Date(parseInt(fechaM[3]), parseInt(fechaM[2]) - 1, parseInt(fechaM[1])) : null;
    const totalMatches = [...text.matchAll(/Total:\s*\$?\s*([\d.,]+)/gi)];
    const total = totalMatches.length ? parseCONumber(totalMatches[totalMatches.length - 1][1]) : NaN;
    if (!factura || isNaN(total)) return { skipped: true, archivo: filename, razon: 'No se pudo extraer factura/total (formato Facturatech)' };
    return { skipped: false, archivo: filename, factura, fecha, total, formato: 'facturatech' };
  }
  m = text.match(/N[úu]mero de Factura:\s*(JMA[\s_-]?\d+)/i);
  if (m) {
    const factura = normFactura(m[1]);
    const fechaM = text.match(/Fecha de Emisi[óo]n:\s*(\d{2})\/(\d{2})\/(\d{4})/i);
    let fecha = fechaM ? new Date(parseInt(fechaM[3]), parseInt(fechaM[2]) - 1, parseInt(fechaM[1])) : null;
    const totalMatches = [...text.matchAll(/Total factura \(=\)\s*(?:COP\s*\$\s*)?([\d.,]+)/gi)];
    const total = totalMatches.length ? parseCONumber(totalMatches[totalMatches.length - 1][1]) : NaN;
    if (!factura || isNaN(total)) return { skipped: true, archivo: filename, razon: 'No se pudo extraer factura/total (formato DIAN genérico)' };
    return { skipped: false, archivo: filename, factura, fecha, total, formato: 'dian-generico' };
  }
  return { skipped: true, archivo: filename, razon: null }; // null = probar como abono
}

function parseAbonoColumns(left, right, filename) {
  // Columna izquierda (de arriba a abajo): fecha, pagado a, tipo id, valor factura, retención, admon
  // Columna derecha (de arriba a abajo): identificación, factura, abono, forma de pago, pendiente
  const L = limpiarColumna(left);
  const R = limpiarColumna(right);
  if (L.length < 6 || R.length < 5) {
    return { skipped: true, archivo: filename, razon: `No coincide con la plantilla de Recibo de Pago (columnas de ${L.length}/${R.length}, se esperaban 6/5)` };
  }
  const fecha = parseSpanishLongDate(L[0]);
  const valorFactura = parseUSNumber(L[3]);
  const retencion = parseUSNumber(L[4]);
  const factura = normFactura(R[1]);
  const abono = parseUSNumber(R[2]);
  const formaPago = R[3];
  const pendienteRecibo = parseUSNumber(R[4]);

  // Red de seguridad: si algun campo clave no tiene la forma esperada, no guardar basura.
  if (!/^JMA\d+$/.test(factura)) return { skipped: true, archivo: filename, razon: `No se reconoció el número de factura ("${R[1]}")` };
  if (isNaN(abono) || isNaN(valorFactura)) return { skipped: true, archivo: filename, razon: 'No se pudieron leer los valores numéricos del recibo' };

  return { skipped: false, archivo: filename, factura, fecha, valorFactura, retencion, abono, formaPago, pendienteRecibo };
}

function abonoId(a) {
  return [normFactura(a.factura), isoDate(a.fecha), Math.round((a.abono || 0) * 100), Math.round((a.pendienteRecibo || 0) * 100)].join('|');
}

// ===================== ESTADO EN MEMORIA =====================
let FACTURAS = new Map();  // factura -> {id,data}
let ABONOS = new Map();    // id -> {id,data}

async function cargarTodo() {
  const [facs, abs] = await Promise.all([sbGetAll('fp_facturas'), sbGetAll('fp_abonos')]);
  FACTURAS = new Map(facs.map(r => [r.id, r.data]));
  ABONOS = new Map(abs.map(r => [r.id, r.data]));
}

// ===================== LOG DE SUBIDA =====================
const logEl = document.getElementById('log');
function logLine(tag, label, filename) {
  const div = document.createElement('div');
  div.className = 'logline ' + tag;
  const tagText = { ok: 'OK', dup: 'Duplicado', err: 'Revisar' }[tag] || tag;
  // El texto sale de los PDF y de sus nombres de archivo: se escapa antes de insertarlo.
  div.innerHTML = `<span class="tag">${tagText}</span><span>${esc(label)} <span class="file">${esc(filename)}</span></span>`;
  logEl.prepend(div);
  if (tag === 'err') anotarSinProcesar(label, filename);
}

let HAY_SIN_PROCESAR = false;
function anotarSinProcesar(motivo, filename) {
  const lista = document.getElementById('unknownList');
  if (!HAY_SIN_PROCESAR) lista.innerHTML = '';
  HAY_SIN_PROCESAR = true;
  const li = document.createElement('li');
  li.textContent = `${filename}: ${motivo}`;
  lista.prepend(li);
}

// ===================== PROCESAR ARCHIVOS SUBIDOS =====================
// Devuelve true si guardo una relacion de pacientes nueva.
async function procesarArchivo(file) {
  let text;
  try {
    // cada llamada a pdfjsLib necesita su propio ArrayBuffer (el worker puede
    // transferir/vaciar el buffer anterior), por eso se vuelve a leer el archivo.
    text = await extractPdfText(await file.arrayBuffer());
  } catch (e) {
    logLine('err', `No se pudo leer el PDF (${e.message}).`, file.name);
    return false;
  }

  if (esRelacion(text)) return procesarRelacion(file);

  const facturaResult = parseFacturaText(text, file.name);
  if (!facturaResult.skipped) {
    await guardarFactura(facturaResult);
    return false;
  }
  if (facturaResult.razon) {
    logLine('err', facturaResult.razon, file.name);
    return false;
  }

  let columns;
  try {
    columns = await extractPdfColumns(await file.arrayBuffer());
  } catch (e) {
    logLine('err', `No se pudo leer el PDF por columnas (${e.message}).`, file.name);
    return false;
  }
  const abonoResult = parseAbonoColumns(columns.left, columns.right, file.name);
  if (!abonoResult.skipped) {
    await guardarAbono(abonoResult);
    return false;
  }
  logLine('err', abonoResult.razon, file.name);
  return false;
}

async function guardarFactura(f) {
  const corr = CORRECCIONES_FACTURA[f.factura];
  if (corr) {
    f.total = corr.total;
    f.corregidaManualmente = true;
  }
  const existente = FACTURAS.get(f.factura);
  if (existente && Math.abs(existente.total - f.total) > 1) {
    const ok = confirm(
      `Ya existe la factura ${f.factura} guardada con total ${cop(existente.total)} (archivo original: "${existente.archivo}").\n` +
      `El PDF nuevo "${f.archivo}" dice ${cop(f.total)}.\n\n¿Reemplazar con el valor nuevo?`
    );
    if (!ok) { logLine('dup', `Factura ${f.factura} ya existía con otro valor — se dejó la versión anterior.`, f.archivo); return; }
  } else if (existente) {
    logLine('dup', `Factura ${f.factura} ya estaba registrada (mismo valor) — no se duplicó.`, f.archivo);
    return;
  }
  await sbUpsert('fp_facturas', { id: f.factura, data: f });
  FACTURAS.set(f.factura, f);
  logLine('ok', `Factura ${f.factura} guardada (${cop(f.total)}).`, f.archivo);
  await render();
}

async function guardarAbono(a) {
  const id = abonoId(a);
  if (ABONOS.has(id)) {
    const prev = ABONOS.get(id);
    logLine('dup', `Mismo recibo que "${prev.archivo}" (misma factura, fecha y valor) — no se duplicó.`, a.archivo);
    return;
  }
  await sbUpsert('fp_abonos', { id, data: a });
  ABONOS.set(id, a);
  logLine('ok', `Abono de ${cop(a.abono)} para ${a.factura} guardado.`, a.archivo);
  await render();
}

// ===================== CONCILIACIÓN =====================
function cop(n) { return '$' + Math.round(n || 0).toLocaleString('es-CO'); }
function copShort(n) { return '$' + (n / 1000000).toLocaleString('es-CO', { maximumFractionDigits: 1 }) + 'M'; }

function calcularConciliacion() {
  const abonosPorFactura = new Map();
  for (const a of ABONOS.values()) {
    const key = normFactura(a.factura);
    if (!abonosPorFactura.has(key)) abonosPorFactura.set(key, []);
    abonosPorFactura.get(key).push(a);
  }

  const inconsistencias = [];
  const resumen = [];

  for (const [numFactura, f] of FACTURAS) {
    const lista = (abonosPorFactura.get(numFactura) || []).slice().sort((a, b) => (a.fecha ? new Date(a.fecha) : 0) - (b.fecha ? new Date(b.fecha) : 0));
    const sumaAbonos = lista.reduce((s, a) => s + (a.abono || 0), 0);
    const retenciones = [...new Set(lista.map(a => Math.round((a.retencion || 0) * 100)))];
    let retencion = lista.length ? (lista[0].retencion || 0) : 0;
    if (retenciones.length > 1) {
      inconsistencias.push(`Factura ${numFactura}: los recibos reportan retenciones distintas entre sí. Se usó la mayor.`);
      retencion = Math.max(...lista.map(a => a.retencion || 0));
    }
    for (const a of lista) {
      if (a.valorFactura && Math.abs(a.valorFactura - f.total) > 1 && !f.corregidaManualmente) {
        inconsistencias.push(`Factura ${numFactura}: el recibo "${a.archivo}" dice Valor Factura ${cop(a.valorFactura)}, pero la factura dice ${cop(f.total)}.`);
      }
    }
    if (!lista.length) inconsistencias.push(`Factura ${numFactura}: no tiene ningún abono registrado.`);

    resumen.push({
      factura: numFactura, fecha: f.fecha, total: f.total, retencion,
      numAbonos: lista.length, sumaAbonos, saldo: f.total - retencion - sumaAbonos, abonosDetalle: lista,
    });
  }

  for (const [numFactura, lista] of abonosPorFactura) {
    if (!FACTURAS.has(numFactura)) inconsistencias.push(`Hay ${lista.length} abono(s) para la factura ${numFactura}, pero esa factura no se ha subido todavía.`);
  }

  resumen.sort((a, b) => a.factura.localeCompare(b.factura, undefined, { numeric: true }));
  return { resumen, inconsistencias };
}

function estado(r, facturasConIssue) {
  // Va primero: "sin abonos" tambien se anota como inconsistencia y quedaria siempre como "revisar".
  if (r.numAbonos === 0) return 'sinabonos';
  if (facturasConIssue.has(r.factura)) return 'revisar';
  if (r.saldo <= 500) return 'pagada';
  return 'pendiente';
}
const estadoLabel = { pagada: 'Pagada', pendiente: 'Pendiente', sinabonos: 'Sin abonos', revisar: 'Revisar' };

let ULTIMO_CALC = null;

async function render() {
  const { resumen, inconsistencias } = calcularConciliacion();
  ULTIMO_CALC = { resumen, inconsistencias };

  const totFacturado = resumen.reduce((s, r) => s + r.total, 0);
  const totRetencion = resumen.reduce((s, r) => s + r.retencion, 0);
  const totAbonado = resumen.reduce((s, r) => s + r.sumaAbonos, 0);
  const totSaldo = resumen.reduce((s, r) => s + r.saldo, 0);
  document.getElementById('tiles').innerHTML = `
    <div class="tile"><div class="label">Total facturado</div><div class="value">${copShort(totFacturado)}</div></div>
    <div class="tile"><div class="label">Retención en la fuente</div><div class="value">${copShort(totRetencion)}</div></div>
    <div class="tile"><div class="label">Total abonado</div><div class="value">${copShort(totAbonado)}</div></div>
    <div class="tile flag"><div class="label">Saldo pendiente</div><div class="value">${copShort(totSaldo)}</div></div>`;

  const facturasConIssue = new Set();
  inconsistencias.forEach(i => { const m = i.match(/JMA\d+/); if (m) facturasConIssue.add(m[0]); });

  const q = document.getElementById('q').value.trim().toLowerCase();
  const statusFilter = document.getElementById('statusFilter').value;
  const rowsEl = document.getElementById('rows');
  rowsEl.innerHTML = '';

  if (!resumen.length) {
    rowsEl.innerHTML = '<div style="padding:24px;text-align:center;color:var(--ink-soft)">Todavía no has subido ninguna factura.</div>';
  }

  resumen.forEach(r => {
    const st = estado(r, facturasConIssue);
    if (statusFilter && st !== statusFilter) return;
    if (q && !r.factura.toLowerCase().includes(q)) return;

    const wrap = document.createElement('div');
    wrap.className = 'contents';
    const saldoClass = r.saldo <= 500 ? 'zero' : 'pos';
    const fechaStr = r.fecha ? new Date(r.fecha).toLocaleDateString('es-CO') : '';
    wrap.innerHTML = `
      <div class="frow" tabindex="0" role="button" aria-expanded="false">
        <div class="factura">${esc(r.factura)}</div>
        <div class="fecha">${fechaStr}</div>
        <div class="num mono">${cop(r.total)}</div>
        <div class="num mono">${cop(r.retencion)}</div>
        <div class="num mono">${r.numAbonos}</div>
        <div class="num mono">${cop(r.sumaAbonos)}</div>
        <div class="num mono saldo ${saldoClass}">${cop(r.saldo)}</div>
        <div><span class="pill ${st}">${estadoLabel[st]}</span></div>
        <svg class="chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><polyline points="9 6 15 12 9 18"/></svg>
      </div>
      <div class="detail">${renderDetalle(r.abonosDetalle)}</div>`;
    rowsEl.appendChild(wrap);
  });

  rowsEl.querySelectorAll('.frow').forEach(row => {
    row.addEventListener('click', () => row.setAttribute('aria-expanded', row.getAttribute('aria-expanded') === 'true' ? 'false' : 'true'));
    row.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); row.click(); } });
  });

  document.getElementById('incList').innerHTML = inconsistencias.length
    ? inconsistencias.map(i => `<li>${esc(i)}</li>`).join('') : '<li>Sin inconsistencias.</li>';

  // El estado "Pagado" de los pacientes tambien depende de los saldos: se refresca la lista.
  if (PACIENTES.size) renderPacientes();
}

function renderDetalle(list) {
  if (!list.length) return '<div class="empty">Sin abonos registrados para esta factura.</div>';
  const rows = list.map(a => `
    <tr><td class="mono">${a.fecha ? new Date(a.fecha).toLocaleDateString('es-CO') : ''}</td>
    <td class="num mono">${cop(a.abono)}</td><td>${esc(a.formaPago)}</td><td class="archivo">${esc(a.archivo)}</td></tr>`).join('');
  return `<table><thead><tr><th>Fecha</th><th class="num">Abono</th><th>Forma de pago</th><th>Archivo</th></tr></thead><tbody>${rows}</tbody></table>`;
}

// ===================== EXCEL =====================
function exportarExcel() {
  if (!ULTIMO_CALC) return;
  const { resumen, inconsistencias } = ULTIMO_CALC;
  const wb = XLSX.utils.book_new();

  const resumenRows = resumen.map(r => ({
    Factura: r.factura, 'Fecha Emisión': r.fecha ? new Date(r.fecha).toLocaleDateString('es-CO') : '',
    'Total Facturado': r.total, 'Retención': r.retencion, '# Abonos': r.numAbonos,
    'Suma Abonos': r.sumaAbonos, 'Saldo Pendiente': r.saldo,
  }));
  resumenRows.push({
    Factura: 'TOTAL', 'Fecha Emisión': '',
    'Total Facturado': resumen.reduce((s, r) => s + r.total, 0),
    'Retención': resumen.reduce((s, r) => s + r.retencion, 0),
    '# Abonos': '', 'Suma Abonos': resumen.reduce((s, r) => s + r.sumaAbonos, 0),
    'Saldo Pendiente': resumen.reduce((s, r) => s + r.saldo, 0),
  });
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(resumenRows), 'Resumen');

  const detalleRows = [];
  resumen.forEach(r => r.abonosDetalle.forEach(a => detalleRows.push({
    Factura: r.factura, 'Fecha Abono': a.fecha ? new Date(a.fecha).toLocaleDateString('es-CO') : '',
    'Valor Abono': a.abono, 'Retención (del recibo)': a.retencion, 'Forma de Pago': a.formaPago, Archivo: a.archivo,
  })));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(detalleRows), 'Detalle Abonos');

  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(inconsistencias.map(d => ({ Detalle: d }))), 'Inconsistencias');

  const fecha = hoyISO();
  XLSX.writeFile(wb, `Conciliacion Facturas ${fecha}.xlsx`);
}

// ===================== EVENTOS =====================
const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');

dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') fileInput.click(); });
['dragenter', 'dragover'].forEach(ev => dropzone.addEventListener(ev, e => { e.preventDefault(); dropzone.classList.add('drag'); }));
['dragleave', 'drop'].forEach(ev => dropzone.addEventListener(ev, e => { e.preventDefault(); dropzone.classList.remove('drag'); }));
dropzone.addEventListener('drop', e => handleFiles(e.dataTransfer.files));
fileInput.addEventListener('change', e => handleFiles(e.target.files));

async function handleFiles(fileList) {
  const files = [...fileList].filter(f => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'));
  let hayRelacionNueva = false;
  for (const f of files) {
    try {
      if (await procesarArchivo(f)) hayRelacionNueva = true;
    } catch (e) {
      // Un archivo que falla al guardar no debe detener los demas.
      logLine('err', `No se pudo guardar (${e.message}).`, f.name);
    }
  }
  fileInput.value = '';
  // El cruce con los pacientes se rehace una sola vez, al final de la tanda.
  if (hayRelacionNueva) await sincronizarCruce();
}

document.getElementById('q').addEventListener('input', render);
document.getElementById('statusFilter').addEventListener('change', render);
document.getElementById('exportBtn').addEventListener('click', exportarExcel);

// ===================== PESTAÑAS =====================
function mostrarVista(nombre) {
  document.querySelectorAll('[data-vista]').forEach(el => { el.hidden = el.dataset.vista !== nombre; });
  document.querySelectorAll('.tab').forEach(t => t.setAttribute('aria-selected', t.dataset.tab === nombre ? 'true' : 'false'));
}
document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => mostrarVista(t.dataset.tab)));

// ===================== LOGIN =====================
let ULTIMA_CARGA = 0;   // momento (ms) de la ultima lectura completa de datos

async function arrancarApp() {
  document.getElementById('login').hidden = true;
  document.getElementById('errorCarga').hidden = true;
  document.getElementById('app').hidden = false;
  mostrarVista('pacientes');
  try {
    await cargarTodo();
    await render();
    await iniciarPacientes();
    ULTIMA_CARGA = Date.now();
  } catch (e) {
    // Sin los datos no se deja usar la app: importar o subir archivos sobre una lista vacia duplicaria registros.
    document.getElementById('app').hidden = true;
    document.getElementById('errorCargaDetalle').textContent = e.message;
    document.getElementById('errorCarga').hidden = false;
  }
}

document.getElementById('loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  const err = document.getElementById('loginError');
  const btn = e.target.querySelector('button');
  err.textContent = '';
  btn.disabled = true;
  const { error } = await sb.auth.signInWithPassword({
    email: document.getElementById('loginEmail').value.trim(),
    password: document.getElementById('loginPass').value,
  });
  btn.disabled = false;
  if (error) {
    // 400 = credenciales invalidas; lo demas es red caida, demasiados intentos o servicio pausado.
    err.textContent = error.status === 400 ? 'Correo o contraseña incorrectos.'
      : 'No se pudo iniciar sesión. Revisa la conexión e intenta de nuevo en un momento.';
    return;
  }
  await arrancarApp();
});

document.getElementById('logoutBtn').addEventListener('click', async () => {
  // scope local: cierra la sesion solo en este dispositivo (por defecto la cierra en todos).
  const { error } = await sb.auth.signOut({ scope: 'local' });
  if (error) { alert('No se pudo cerrar la sesión. Revisa la conexión e intenta de nuevo.'); return; }
  location.reload();
});

// Si la sesion se pierde con la app abierta (vencio o se cerro en otra pestaña), se vuelve al login.
sb.auth.onAuthStateChange(evento => {
  if (evento === 'SIGNED_OUT' && document.getElementById('login').hidden) location.reload();
});

// El celular puede dejar la pestaña abierta por dias: al volver a ella se recargan los datos,
// para ver lo que se digito o subio desde el otro dispositivo.
const MINUTOS_PARA_RECARGAR = 5;
document.addEventListener('visibilitychange', async () => {
  if (document.hidden || document.getElementById('app').hidden) return;
  if (Date.now() - ULTIMA_CARGA < MINUTOS_PARA_RECARGAR * 60000) return;
  ULTIMA_CARGA = Date.now();
  try {
    await cargarTodo();
    await render();
    await cargarPacientes();
    await sincronizarCruce();
  } catch (e) {
    ULTIMA_CARGA = 0;   // sin conexion: se reintenta la proxima vez que se abra la pestaña
  }
});

// ===================== INICIO =====================
async function iniciar() {
  const { data } = await sb.auth.getSession();
  if (data.session) { await arrancarApp(); return; }
  document.getElementById('errorCarga').hidden = true;
  document.getElementById('login').hidden = false;
}
document.getElementById('reintentarBtn').addEventListener('click', iniciar);
iniciar();
