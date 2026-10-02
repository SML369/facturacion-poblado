// ===================== SUPABASE CONFIG =====================
const SUPA_URL = 'https://hlldcoemekqecqhtuahx.supabase.co';
const SUPA_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhsbGRjb2VtZWtxZWNxaHR1YWh4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA5NTM0NTMsImV4cCI6MjEwNjUyOTQ1M30.x-yGOivwv17y-xTd0hZniV5N3v0DVlCeDByDkOfnlcQ';
const H = { 'Content-Type': 'application/json', apikey: SUPA_KEY, Authorization: 'Bearer ' + SUPA_KEY };

async function sbGetAll(tabla) {
  const r = await fetch(`${SUPA_URL}/rest/v1/${tabla}?select=*`, { headers: H });
  return r.ok ? r.json() : [];
}
async function sbUpsert(tabla, row) {
  const r = await fetch(`${SUPA_URL}/rest/v1/${tabla}`, {
    method: 'POST', headers: { ...H, Prefer: 'resolution=merge-duplicates' }, body: JSON.stringify(row),
  });
  if (!r.ok) throw new Error(`Error al guardar en ${tabla}: ${r.status}`);
}

document.getElementById('supaProject').textContent = new URL(SUPA_URL).hostname.split('.')[0];

// ===================== pdf.js SETUP =====================
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.worker.min.js';

async function extractPdfText(arrayBuffer) {
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  let fullText = '';
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const items = content.items;
    const lineMap = new Map();
    for (const it of items) {
      if (!it.str || !it.str.trim()) continue;
      const yRaw = Math.round(it.transform[5]);
      // agrupar lineas cuya coordenada Y esta a 2px o menos (variaciones de linea base)
      let key = yRaw;
      for (const existingY of lineMap.keys()) {
        if (Math.abs(existingY - yRaw) <= 2) { key = existingY; break; }
      }
      if (!lineMap.has(key)) lineMap.set(key, []);
      lineMap.get(key).push(it);
    }
    const ys = [...lineMap.keys()].sort((a, b) => b - a);
    for (const y of ys) {
      const lineItems = lineMap.get(y).sort((a, b) => a.transform[4] - b.transform[4]);
      fullText += lineItems.map(i => i.str).join(' ') + '\n';
    }
    fullText += '\n';
  }
  return fullText;
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
function isoDate(d) { return d ? d.toISOString().slice(0, 10) : 'sinfecha'; }

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

function parseAbonoText(text, filename) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean).filter(l =>
    !l.startsWith('Dirección') && !l.startsWith('Teléfono') && !l.startsWith('www.') &&
    !l.startsWith('Firma') && !l.startsWith('--')
  );
  if (lines.length !== 11) {
    return { skipped: true, archivo: filename, razon: `No coincide con la plantilla de Recibo de Pago (${lines.length} líneas detectadas, se esperaban 11)` };
  }
  const fecha = parseSpanishLongDate(lines[0]);
  const factura = normFactura(lines[4]);
  const valorFactura = parseUSNumber(lines[5]);
  const retencion = parseUSNumber(lines[6]);
  const abono = parseUSNumber(lines[8]);
  const formaPago = lines[9];
  const pendienteRecibo = parseUSNumber(lines[10]);
  if (!factura || isNaN(abono)) return { skipped: true, archivo: filename, razon: 'No se pudo extraer factura/abono de la plantilla' };
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
  div.innerHTML = `<span class="tag">${tagText}</span><span>${label} <span class="file">${filename}</span></span>`;
  logEl.prepend(div);
}

// ===================== PROCESAR ARCHIVOS SUBIDOS =====================
async function procesarArchivo(file) {
  const buf = await file.arrayBuffer();
  let text;
  try {
    text = await extractPdfText(buf);
  } catch (e) {
    logLine('err', `No se pudo leer el PDF (${e.message}).`, file.name);
    return;
  }

  const facturaResult = parseFacturaText(text, file.name);
  if (!facturaResult.skipped) {
    await guardarFactura(facturaResult);
    return;
  }
  if (facturaResult.razon) {
    logLine('err', facturaResult.razon, file.name);
    return;
  }

  const abonoResult = parseAbonoText(text, file.name);
  if (!abonoResult.skipped) {
    await guardarAbono(abonoResult);
    return;
  }
  logLine('err', abonoResult.razon, file.name);
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
  if (facturasConIssue.has(r.factura)) return 'revisar';
  if (r.numAbonos === 0) return 'sinabonos';
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
        <div class="factura">${r.factura}</div>
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
    ? inconsistencias.map(i => `<li>${i}</li>`).join('') : '<li>Sin inconsistencias.</li>';
}

function renderDetalle(list) {
  if (!list.length) return '<div class="empty">Sin abonos registrados para esta factura.</div>';
  const rows = list.map(a => `
    <tr><td class="mono">${a.fecha ? new Date(a.fecha).toLocaleDateString('es-CO') : ''}</td>
    <td class="num mono">${cop(a.abono)}</td><td>${a.formaPago || ''}</td><td class="archivo">${a.archivo}</td></tr>`).join('');
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

  const fecha = new Date().toISOString().slice(0, 10);
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
  for (const f of files) {
    await procesarArchivo(f);
  }
  fileInput.value = '';
}

document.getElementById('q').addEventListener('input', render);
document.getElementById('statusFilter').addEventListener('change', render);
document.getElementById('exportBtn').addEventListener('click', exportarExcel);

// ===================== INICIO =====================
(async () => {
  await cargarTodo();
  await render();
})();
