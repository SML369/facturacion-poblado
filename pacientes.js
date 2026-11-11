// Modulo de pacientes del dia + relaciones de pacientes de la clinica.
// Depende de app.js (sbGetAll, sbUpsert, sbRequest, logLine, cop, copShort, FACTURAS, normFactura).

// ===================== PARSEO DE RELACIONES (funciones puras) =====================
// Las relaciones de 2025+ guardan el texto por columnas con la misma coordenada Y,
// asi que agrupar por linea (extractPdfText) las mezcla. Se lee en el orden del
// propio PDF usando los saltos de linea (hasEOL) que marca pdf.js.
async function extractPdfStreamText(arrayBuffer) {
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  let texto = '';
  for (let p = 1; p <= pdf.numPages; p++) {
    const content = await (await pdf.getPage(p)).getTextContent();
    for (const it of content.items) {
      texto += it.str;
      if (it.hasEOL) texto += '\n';
    }
    texto += '\n';
  }
  return texto;
}

// Los numeros vienen en dos formatos segun el año: "25,963,496.00" (2024) o "1.183.504,00" (2025+).
// Se toma como decimal el separador que precede a los 2 ultimos digitos.
function parseNumAuto(s) {
  if (!s) return NaN;
  let t = String(s).replace(/[^\d.,]/g, '');
  if (/[.,]\d{2}$/.test(t)) {
    const dec = t[t.length - 3];
    const otro = dec === ',' ? '.' : ',';
    t = t.split(otro).join('').replace(dec, '.');
  } else {
    t = t.replace(/[.,]/g, '');
  }
  return parseFloat(t);
}

function fechaDMYaISO(s) {
  const m = s && s.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

function normNombre(s) {
  return String(s || '').toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Z ]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Separa "RUBEN DARIO ROJAS MONSALVE COLSANITAS S.A." en paciente y aseguradora.
const ASEGURADORAS_RE = /\b(SEGUROS|COLSANITAS|MEDISANITAS|COOMEVA|MEDPLUS|PARTICULAR|AXA|COLMEDICA|ALLIANZ|MAPFRE|SURAMERICANA|SURA|HDI|EPS|POLICIA|ECOPETROL|SANITAS|PREPAGADA)\b/;

function esRelacion(text) {
  return /Periodo:/i.test(text) && /Liquidaci[óo]n:/i.test(text);
}

function parseRelacionText(text, filename) {
  const campo = re => { const m = text.match(re); return m ? m[1].trim() : ''; };
  const periodo = campo(/Periodo:\s*([^\n]+?al\s+\d{2}\/\d{2}\/\d{4})/i);
  const liquidacion = parseNumAuto(campo(/Liquidaci[óo]n:\s*([\d.,]+)/i));
  const retencion = parseNumAuto(campo(/Retenci[óo]n:\s*([\d.,]+)/i));
  const abonos = parseNumAuto(campo(/Abonos:\s*([\d.,]+)/i));
  const pendiente = parseNumAuto(campo(/Pendiente:\s*([\d.,]+)/i));
  if (!periodo || isNaN(liquidacion)) {
    return { skipped: true, archivo: filename, razon: 'Parece una relación de pacientes pero no se pudo leer el encabezado' };
  }

  // Fila: # fechaCirugia fechaFactura admision [fechaPago lote] cod cod PACIENTE ASEGURADORA cantidad valorUnit total
  // (la admision puede traer "*" y los codigos pueden ser alfanumericos, ej. "034S 39108")
  const FILA_RE = /^(\d+)\s+(\d{2}\/\d{2}\/\d{4})\s+(\d{2}\/\d{2}\/\d{4})\s+(\d+)\*?\s+(?:(\d{2}\/\d{2}\/\d{4})\s+(\d+)\s+)?\S+\s+\S+\s+(.+?)\s*([\d.,]+)\s+([\d.,]+)\s+([\d.,]+)\s*$/;
  const filas = [];
  for (const linea of text.split('\n')) {
    const m = linea.replace(/\s+/g, ' ').trim().match(FILA_RE);
    if (!m) continue;
    const resto = m[7].replace(/[.\s]+$/, '').trim();
    const corte = resto.search(ASEGURADORAS_RE);
    filas.push({
      n: parseInt(m[1]),
      fechaCirugia: fechaDMYaISO(m[2]),
      fechaFactura: fechaDMYaISO(m[3]),
      admision: m[4],
      fechaPago: fechaDMYaISO(m[5]),
      lote: m[6] || null,
      paciente: (corte > 0 ? resto.slice(0, corte) : resto).trim(),
      aseguradora: corte > 0 ? resto.slice(corte).trim() : '',
      uvr: parseNumAuto(m[8]),
      valorUnit: parseNumAuto(m[9]),
      total: parseNumAuto(m[10]),
    });
  }
  if (!filas.length) {
    return { skipped: true, archivo: filename, razon: 'Relación de pacientes sin filas legibles' };
  }
  return { skipped: false, archivo: filename, periodo, liquidacion, retencion, abonos, pendiente, filas };
}

// La relacion no trae el numero de factura: se identifica porque la liquidacion
// es igual al total de la factura; si no, por el nombre del archivo.
function identificarFacturaRelacion(rel, facturas) {
  for (const [num, f] of facturas) {
    if (Math.abs((f.total || 0) - rel.liquidacion) <= 1) return num;
  }
  const m = rel.archivo.match(/JMA\s*-?\s*(\d+)/i);
  return m ? 'JMA' + m[1] : null;
}

function filasPagadas(rel) {
  return rel.filas.filter(f => f.fechaPago).length;
}
// ===================== FIN PARSEO DE RELACIONES =====================

// ===================== CAMPOS DEL PACIENTE =====================
// [columna en Supabase, etiqueta, encabezado en el Excel del doctor]
const CAMPOS_TEXTO_CLINICOS = [
  ['asa', 'ASA', 'ASA'], ['comorbilidad', 'Comorbilidad', 'COMORBILIDAD'], ['duracion', 'Duración', 'DURACION'],
  ['tecnica', 'Técnica', 'TECNICA'], ['medicamentos', 'Medicamentos', 'MEDICAMENTOS'], ['via_aerea', 'Vía aérea', 'VIA AEREA'],
  ['relajante', 'Relajante', 'RELAJANTE'], ['bloqueo', 'Bloqueo', 'BLOQUEO'], ['metodo', 'Método', 'METODO'],
  ['anestesico', 'Anestésico', 'ANESTESICO'],
];
const CAMPOS_TEXTO_BASICOS = [
  ['nombre', 'Nombre', 'NOMBRE'], ['apellidos', 'Apellidos', 'APELLIDOS'], ['institucion', 'Institución', 'INSTITUCION'],
  ['empresa', 'Aseguradora', 'EMPRESA'], ['procedimiento', 'Procedimiento', 'PROCEDIMIENTO'], ['cirujano', 'Cirujano', 'CIRUJANO'],
];
const CAMPOS_TEXTO = [...CAMPOS_TEXTO_BASICOS, ...CAMPOS_TEXTO_CLINICOS];
// Lo que "Repetir anterior" copia: datos del turno/quirofano, no los del paciente.
const CAMPOS_REPETIBLES = ['fecha', 'institucion', 'cirujano', 'procedimiento', 'duracion', 'tecnica', 'medicamentos',
  'via_aerea', 'relajante', 'bloqueo', 'metodo', 'anestesico'];

const DIAS_ALERTA_SIN_RELACION = 45;

let PACIENTES = new Map();   // id -> paciente
let RELACIONES = new Map();  // factura -> relacion
let EDITANDO_ID = null;
let ULTIMO_GUARDADO_ID = null;
let VALOR_MANUAL = false;    // true si el usuario escribio el valor a mano (no sobreescribir con la sugerencia)

function limpiarTexto(v) {
  const t = String(v ?? '').replace(/\s+/g, ' ').trim().toUpperCase();
  return t || null;
}
function hoyISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function fechaCorta(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}
function diasEntre(isoA, isoB) {
  return Math.round((new Date(isoB) - new Date(isoA)) / 86400000);
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

async function cargarPacientes() {
  const [pacs, rels] = await Promise.all([sbGetAll('fp_pacientes'), sbGetAll('fp_relaciones')]);
  PACIENTES = new Map(pacs.map(p => [p.id, p]));
  RELACIONES = new Map(rels.map(r => [r.id, r]));
}

// ===================== RELACIONES: GUARDAR VERSION VIGENTE =====================
async function procesarRelacion(file) {
  let rel;
  try {
    rel = parseRelacionText(await extractPdfStreamText(await file.arrayBuffer()), file.name);
  } catch (e) {
    logLine('err', `No se pudo leer la relación de pacientes (${e.message}).`, file.name);
    return;
  }
  if (rel.skipped) { logLine('err', rel.razon, file.name); return; }
  await guardarRelacion(rel);
}

async function guardarRelacion(rel) {
  const factura = identificarFacturaRelacion(rel, FACTURAS);
  if (!factura) {
    logLine('err', `Relación de pacientes (${rel.periodo}): no se pudo saber a qué factura JMA corresponde.`, rel.archivo);
    return;
  }
  const previa = RELACIONES.get(factura);
  if (previa) {
    const nuevaPagadas = filasPagadas(rel);
    const previaPagadas = (previa.filas || []).filter(f => f.fechaPago).length;
    if (rel.abonos < previa.abonos || (rel.abonos === previa.abonos && nuevaPagadas < previaPagadas)) {
      logLine('dup', `Relación ${factura}: versión anterior (abonos ${cop(rel.abonos)}); se conserva la de ${cop(previa.abonos)}.`, rel.archivo);
      return;
    }
    if (rel.abonos === previa.abonos && nuevaPagadas === previaPagadas) {
      logLine('dup', `Relación ${factura} ya estaba registrada con los mismos abonos — no se duplicó.`, rel.archivo);
      return;
    }
  }
  const row = {
    id: factura, periodo: rel.periodo, liquidacion: rel.liquidacion, retencion: rel.retencion,
    abonos: rel.abonos, pendiente: rel.pendiente, archivo: rel.archivo, filas: rel.filas,
    updated_at: new Date().toISOString(),
  };
  await sbUpsert('fp_relaciones', row);
  RELACIONES.set(factura, row);
  logLine('ok', `Relación ${factura} (${rel.periodo}) guardada: ${rel.filas.length} pacientes, ${filasPagadas(rel)} con pago.`, rel.archivo);
  await sincronizarCruce();
}

// ===================== CRUCE PACIENTES <-> RELACIONES =====================
function tokensNombre(s) {
  return normNombre(s).split(' ').filter(t => t.length > 2);
}

function distanciaEdicion(a, b) {
  if (Math.abs(a.length - b.length) > 1) return 2;
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

// Tolera errores de digitacion (FANNY/FANY), nombres cortados en el PDF ("DE BUSTA")
// y palabras pegadas a la aseguradora ("ORTEGACOLSANITAS").
function tokenCoincide(token, atencion) {
  if (atencion.tokens.has(token)) return true;
  if (token.length >= 4 && atencion.texto.includes(token)) return true;
  for (const t of atencion.tokens) {
    if (t.length >= 4 && token.startsWith(t)) return true;
    if (token.length >= 5 && distanciaEdicion(token, t) <= 1) return true;
  }
  return false;
}

// Una admision puede venir en varias filas (un item por fila); se agrupan en una sola atencion.
// Queda pagada solo si todas sus filas tienen fecha de pago.
function atencionesDeRelaciones() {
  const porAdmision = new Map();
  for (const [factura, rel] of RELACIONES) {
    for (const f of rel.filas || []) {
      const clave = `${factura}|${f.admision}|${normNombre(f.paciente)}`;
      const previa = porAdmision.get(clave);
      if (!previa) {
        porAdmision.set(clave, { factura, fila: { ...f }, tokens: new Set(tokensNombre(f.paciente)), texto: normNombre(f.paciente) });
        continue;
      }
      previa.fila.total += f.total;
      if (!f.fechaPago) previa.fila.fechaPago = null;
      else if (previa.fila.fechaPago && f.fechaPago > previa.fila.fechaPago) previa.fila.fechaPago = f.fechaPago;
    }
  }
  return [...porAdmision.values()];
}

// Devuelve Map(idPaciente -> {factura, fila}) y la lista de atenciones de relacion sin paciente.
function cruzarRelaciones() {
  const filas = atencionesDeRelaciones();

  // Candidatos con puntaje: nombres que coinciden y cercania de fecha de cirugia.
  // Hasta 7 dias de diferencia basta con 3 palabras del nombre (o los 2 apellidos el mismo dia);
  // con el nombre completo se aceptan hasta 62 dias (fecha mal digitada, ej. marzo en vez de abril).
  // Una fecha cercana pesa mas que el nombre, para no robarle la fila a otra atencion del mismo paciente.
  const candidatos = [];
  for (const p of PACIENTES.values()) {
    const toks = tokensNombre(`${p.nombre || ''} ${p.apellidos || ''}`);
    if (!toks.length) continue;
    const apellidos = tokensNombre(p.apellidos);
    const minimo = Math.min(3, toks.length);
    filas.forEach((r, idx) => {
      const coinciden = toks.filter(t => tokenCoincide(t, r)).length;
      const dias = r.fila.fechaCirugia ? Math.abs(diasEntre(p.fecha, r.fila.fechaCirugia)) : 999;
      const mismosApellidos = apellidos.length >= 2 && apellidos.every(t => r.tokens.has(t)) && dias <= 1;
      if (coinciden < minimo && !mismosApellidos) return;
      const nombreCompleto = coinciden === toks.length && toks.length >= 3;
      if (dias > 7 && !(nombreCompleto && dias <= 62)) return;
      candidatos.push({ pid: p.id, idx, puntaje: (dias <= 7 ? 10000 : 0) + coinciden * 100 - dias });
    });
  }
  candidatos.sort((a, b) => b.puntaje - a.puntaje);

  const asignados = new Map();
  const filasUsadas = new Set();
  for (const c of candidatos) {
    if (asignados.has(c.pid) || filasUsadas.has(c.idx)) continue;
    asignados.set(c.pid, filas[c.idx]);
    filasUsadas.add(c.idx);
  }

  // Solo se reportan filas sin paciente desde que el doctor empezo a registrar.
  const fechas = [...PACIENTES.values()].map(p => p.fecha).sort();
  const desde = fechas[0] || '9999-12-31';
  const sinPaciente = filas.filter((r, idx) => !filasUsadas.has(idx) && (r.fila.fechaCirugia || '') >= desde);
  return { asignados, sinPaciente };
}

// Guarda en cada paciente la factura, admision y pago encontrados (para exportes y consultas).
async function sincronizarCruce() {
  const { asignados } = cruzarRelaciones();
  const cambios = [];
  for (const p of PACIENTES.values()) {
    const a = asignados.get(p.id);
    const nuevo = {
      factura_jma: a ? a.factura : null,
      admision: a ? a.fila.admision : null,
      fecha_pago: a ? a.fila.fechaPago : null,
      lote: a ? a.fila.lote : null,
    };
    if (Object.keys(nuevo).some(k => (p[k] || null) !== nuevo[k])) {
      Object.assign(p, nuevo);
      cambios.push({ ...p });
    }
  }
  for (let i = 0; i < cambios.length; i += 200) {
    await sbUpsert('fp_pacientes', cambios.slice(i, i + 200));
  }
  renderPacientes();
}

function estadoPaciente(p) {
  if (p.fecha_pago) return 'pagado';
  if (p.factura_jma) return 'enrelacion';
  return diasEntre(p.fecha, hoyISO()) > DIAS_ALERTA_SIN_RELACION ? 'sinrelacion' : 'reciente';
}
const ESTADO_PACIENTE_LABEL = {
  pagado: 'Pagado', enrelacion: 'En relación, sin pagar', sinrelacion: 'No aparece en relación', reciente: 'Pendiente de relación',
};

// ===================== FORMULARIO =====================
const form = document.getElementById('pacForm');

function valoresForm() {
  const p = { fecha: form.fecha.value };
  for (const [col] of CAMPOS_TEXTO) p[col] = limpiarTexto(form[col].value);
  p.edad = form.edad.value ? parseInt(form.edad.value) : null;
  p.uvr = form.uvr.value ? parseFloat(form.uvr.value) : null;
  p.valor = form.valor.value ? parseFloat(form.valor.value) : null;
  return p;
}

function llenarForm(p) {
  form.fecha.value = p.fecha || hoyISO();
  for (const [col] of CAMPOS_TEXTO) form[col].value = p[col] || '';
  form.edad.value = p.edad ?? '';
  form.uvr.value = p.uvr ?? '';
  form.valor.value = p.valor ?? '';
}

function limpiarForm({ conservarFecha }) {
  const fecha = form.fecha.value;
  const institucion = form.institucion.value;
  form.reset();
  form.fecha.value = conservarFecha && fecha ? fecha : hoyISO();
  form.institucion.value = institucion || ultimoValor('institucion') || '';
  EDITANDO_ID = null;
  VALOR_MANUAL = false;
  document.getElementById('pacGuardar').textContent = 'Guardar paciente';
  document.getElementById('pacEliminar').hidden = true;
  document.getElementById('pacCancelar').hidden = true;
  document.getElementById('pacFormTitulo').textContent = 'Nuevo paciente';
  actualizarSugerencia();
}

function pacientesOrdenados() {
  return [...PACIENTES.values()].sort((a, b) =>
    (b.fecha || '').localeCompare(a.fecha || '') || (b.created_at || '').localeCompare(a.created_at || ''));
}
function ultimoValor(col) {
  const p = pacientesOrdenados().find(x => x[col]);
  return p ? p[col] : null;
}

// Tarifa por UVR de la aseguradora = valor/uvr del paciente mas reciente de esa aseguradora.
function tarifaAseguradora(empresa) {
  if (!empresa) return null;
  const p = pacientesOrdenados().find(x => x.empresa === empresa && x.uvr > 0 && x.valor > 0);
  return p ? Math.round(p.valor / p.uvr) : null;
}

function actualizarSugerencia() {
  const hint = document.getElementById('valorHint');
  const empresa = limpiarTexto(form.empresa.value);
  const tarifa = tarifaAseguradora(empresa);
  const uvr = parseFloat(form.uvr.value);
  if (!tarifa) { hint.textContent = empresa ? 'Sin tarifa previa para esta aseguradora.' : ''; return; }
  hint.textContent = `Tarifa ${empresa}: ${cop(tarifa)} por UVR`;
  if (!VALOR_MANUAL && uvr > 0) form.valor.value = Math.round(uvr * tarifa);
}

function repetirAnterior() {
  // El ultimo guardado en esta sesion; si no hay, el mas reciente sin fecha futura (mal digitada).
  const ultimo = (ULTIMO_GUARDADO_ID && PACIENTES.get(ULTIMO_GUARDADO_ID)) ||
    pacientesOrdenados().find(p => p.fecha <= hoyISO());
  if (!ultimo) return;
  for (const col of CAMPOS_REPETIBLES) {
    if (col === 'fecha') form.fecha.value = ultimo.fecha;
    else form[col].value = ultimo[col] || '';
  }
  form.nombre.focus();
}

async function guardarPaciente(e) {
  e.preventDefault();
  const p = valoresForm();
  if (!p.fecha || !p.nombre) { alert('La fecha y el nombre son obligatorios.'); return; }
  const btn = document.getElementById('pacGuardar');
  btn.disabled = true;
  try {
    if (EDITANDO_ID) {
      p.updated_at = new Date().toISOString();
      const [actualizado] = await sbRequest('PATCH', `fp_pacientes?id=eq.${EDITANDO_ID}`, p);
      PACIENTES.set(EDITANDO_ID, actualizado);
      ULTIMO_GUARDADO_ID = EDITANDO_ID;
    } else {
      const [creado] = await sbRequest('POST', 'fp_pacientes', p);
      PACIENTES.set(creado.id, creado);
      ULTIMO_GUARDADO_ID = creado.id;
    }
    limpiarForm({ conservarFecha: true });
    await sincronizarCruce();
    mostrarAviso('Paciente guardado.');
  } catch (err) {
    alert('No se pudo guardar: ' + err.message);
  } finally {
    btn.disabled = false;
  }
}

async function eliminarPaciente() {
  const p = PACIENTES.get(EDITANDO_ID);
  if (!p || !confirm(`¿Eliminar a ${p.nombre} ${p.apellidos || ''} (${fechaCorta(p.fecha)})?`)) return;
  try {
    await sbRequest('DELETE', `fp_pacientes?id=eq.${EDITANDO_ID}`);
    PACIENTES.delete(EDITANDO_ID);
    limpiarForm({ conservarFecha: false });
    renderPacientes();
  } catch (err) {
    alert('No se pudo eliminar: ' + err.message);
  }
}

function editarPaciente(id) {
  const p = PACIENTES.get(id);
  if (!p) return;
  llenarForm(p);
  EDITANDO_ID = id;
  VALOR_MANUAL = true;
  document.getElementById('pacGuardar').textContent = 'Guardar cambios';
  document.getElementById('pacEliminar').hidden = false;
  document.getElementById('pacCancelar').hidden = false;
  document.getElementById('pacFormTitulo').textContent = `Editando: ${p.nombre} ${p.apellidos || ''}`;
  actualizarSugerencia();
  form.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

let avisoTimer = null;
function mostrarAviso(texto) {
  const el = document.getElementById('pacAviso');
  el.textContent = texto;
  el.hidden = false;
  clearTimeout(avisoTimer);
  avisoTimer = setTimeout(() => { el.hidden = true; }, 2500);
}

// ===================== LISTA Y RESUMEN =====================
function llenarDatalists() {
  for (const [col] of CAMPOS_TEXTO) {
    if (col === 'nombre' || col === 'apellidos') continue;
    const dl = document.getElementById('dl_' + col);
    if (!dl) continue;
    const conteo = new Map();
    for (const p of PACIENTES.values()) if (p[col]) conteo.set(p[col], (conteo.get(p[col]) || 0) + 1);
    dl.innerHTML = [...conteo.entries()].sort((a, b) => b[1] - a[1]).map(([v]) => `<option value="${esc(v)}">`).join('');
  }
}

function renderPacientes() {
  llenarDatalists();
  const mes = document.getElementById('pacMes').value;   // "2026-11" o "" = todos
  const q = normNombre(document.getElementById('pacQ').value);
  const filtroEstado = document.getElementById('pacEstado').value;

  const delMes = pacientesOrdenados().filter(p => !mes || (p.fecha || '').startsWith(mes));
  const visibles = delMes.filter(p =>
    (!filtroEstado || estadoPaciente(p) === filtroEstado) &&
    (!q || normNombre(`${p.nombre} ${p.apellidos} ${p.empresa} ${p.procedimiento} ${p.cirujano}`).includes(q)));

  const total = delMes.reduce((s, p) => s + (p.valor || 0), 0);
  const pagado = delMes.filter(p => estadoPaciente(p) === 'pagado').reduce((s, p) => s + (p.valor || 0), 0);
  const alertas = [...PACIENTES.values()].filter(p => estadoPaciente(p) === 'sinrelacion').length;
  document.getElementById('pacTiles').innerHTML = `
    <div class="tile"><div class="label">Pacientes ${mes ? 'del mes' : '(todos)'}</div><div class="value">${delMes.length}</div></div>
    <div class="tile"><div class="label">Valor ${mes ? 'del mes' : 'total'}</div><div class="value">${copShort(total)}</div></div>
    <div class="tile"><div class="label">Ya pagado</div><div class="value">${copShort(pagado)}</div></div>
    <div class="tile flag"><div class="label">Sin relación &gt;${DIAS_ALERTA_SIN_RELACION} días</div><div class="value">${alertas}</div></div>`;

  const lista = document.getElementById('pacRows');
  lista.innerHTML = visibles.length ? '' : '<div class="empty-list">No hay pacientes con estos filtros.</div>';
  for (const p of visibles) {
    const st = estadoPaciente(p);
    const row = document.createElement('div');
    row.className = 'prow';
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.innerHTML = `
      <div class="fecha mono">${fechaCorta(p.fecha)}</div>
      <div class="pac"><b>${esc(p.nombre)} ${esc(p.apellidos || '')}</b><span>${esc(p.procedimiento || '')}${p.cirujano ? ' · ' + esc(p.cirujano) : ''}</span></div>
      <div class="emp">${esc(p.empresa || '')}</div>
      <div class="num mono">${p.uvr ?? ''}</div>
      <div class="num mono">${p.valor ? cop(p.valor) : '—'}</div>
      <div><span class="pill ${st}" title="${p.factura_jma ? 'Factura ' + p.factura_jma + (p.fecha_pago ? ' · pagado ' + fechaCorta(p.fecha_pago) + ' lote ' + (p.lote || '') : '') : ''}">${ESTADO_PACIENTE_LABEL[st]}</span></div>`;
    row.addEventListener('click', () => editarPaciente(p.id));
    row.addEventListener('keydown', e => { if (e.key === 'Enter') editarPaciente(p.id); });
    lista.appendChild(row);
  }

  renderRevisionPacientes();
}

function renderRevisionPacientes() {
  const { sinPaciente } = cruzarRelaciones();
  const sinRel = pacientesOrdenados().filter(p => estadoPaciente(p) === 'sinrelacion');
  document.getElementById('pacSinRelacion').innerHTML = sinRel.length
    ? sinRel.slice(0, 200).map(p => `<li><b>${fechaCorta(p.fecha)}</b> ${esc(p.nombre)} ${esc(p.apellidos || '')} — ${esc(p.empresa || '')}</li>`).join('')
    : '<li>Todos los pacientes con más de ' + DIAS_ALERTA_SIN_RELACION + ' días aparecen en alguna relación.</li>';
  document.getElementById('pacSinDigitar').innerHTML = sinPaciente.length
    ? sinPaciente.slice(0, 200).map(r => `<li><b>${fechaCorta(r.fila.fechaCirugia)}</b> ${esc(r.fila.paciente)} — ${esc(r.fila.aseguradora)} <span class="mono">(${r.factura})</span></li>`).join('')
    : '<li>Ninguno.</li>';
}

// ===================== EXPORTAR =====================
function exportarPacientes() {
  const filas = pacientesOrdenados().reverse().map(p => {
    const fila = { FECHA: fechaCorta(p.fecha) };
    for (const [col, , encabezado] of CAMPOS_TEXTO) fila[encabezado] = p[col] || '';
    fila.EDAD = p.edad ?? '';
    fila.UVR = p.uvr ?? '';
    fila.VALOR = p.valor ?? '';
    fila.ESTADO = ESTADO_PACIENTE_LABEL[estadoPaciente(p)];
    fila.FACTURA = p.factura_jma || '';
    fila.ADMISION = p.admision || '';
    fila['FECHA PAGO'] = fechaCorta(p.fecha_pago);
    fila.LOTE = p.lote || '';
    return fila;
  });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(filas), 'Pacientes');
  XLSX.writeFile(wb, `Pacientes JMA ${hoyISO()}.xlsx`);
}

// ===================== IMPORTAR EXCEL (Google Sheet del doctor) =====================
function claveDuplicado(p) {
  return `${p.fecha}|${normNombre(p.nombre)}|${normNombre(p.apellidos)}`;
}

function filaExcelAPaciente(fila, idx) {
  const fechaRaw = fila[idx.FECHA];
  let fecha = null;
  if (fechaRaw instanceof Date) {
    // SheetJS entrega fechas a medianoche local; se usan los componentes locales.
    fecha = `${fechaRaw.getFullYear()}-${String(fechaRaw.getMonth() + 1).padStart(2, '0')}-${String(fechaRaw.getDate()).padStart(2, '0')}`;
  } else if (typeof fechaRaw === 'string') {
    // Tolera fechas mal digitadas en el Sheet: "03//06/2026", "19/082026", "10/11//2026".
    const m = fechaRaw.match(/^\s*(\d{1,2})\D+(\d{1,2})\D*(\d{4})\s*$/);
    if (m) fecha = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    else if (/^\d{4}-\d{2}-\d{2}/.test(fechaRaw)) fecha = fechaRaw.slice(0, 10);
  }
  const p = { fecha };
  for (const [col, , encabezado] of CAMPOS_TEXTO) p[col] = idx[encabezado] != null ? limpiarTexto(fila[idx[encabezado]]) : null;
  const num = v => (v === '' || v == null || isNaN(Number(v)) ? null : Number(v));
  p.edad = num(fila[idx.EDAD]);
  p.uvr = num(fila[idx.VALOR]);          // en el Excel "VALOR" son las UVR
  p.valor = num(fila[idx.FACTURADO]);    // y "FACTURADO" es el valor en pesos
  return p;
}

async function importarExcel(file) {
  const wb = XLSX.read(await file.arrayBuffer(), { cellDates: true });
  const hoja = wb.Sheets[wb.SheetNames[0]];
  const filas = XLSX.utils.sheet_to_json(hoja, { header: 1, raw: true, defval: null });
  const idx = {};
  (filas[0] || []).forEach((h, i) => { if (h) idx[normNombre(h)] = i; });
  if (idx.FECHA == null || idx.NOMBRE == null) {
    alert('No se reconoció el formato: la primera fila debe tener los encabezados FECHA, NOMBRE, APELLIDOS…');
    return;
  }

  const existentes = new Set([...PACIENTES.values()].map(claveDuplicado));
  const nuevos = [];
  let repetidos = 0, invalidos = 0;
  for (const fila of filas.slice(1)) {
    const p = filaExcelAPaciente(fila, idx);
    if (!p.nombre) continue;
    if (!p.fecha) { invalidos++; continue; }
    const k = claveDuplicado(p);
    if (existentes.has(k)) { repetidos++; continue; }
    existentes.add(k);
    nuevos.push(p);
  }

  const msg = `Archivo "${file.name}":\n• ${nuevos.length} pacientes nuevos para importar\n• ${repetidos} ya estaban registrados (se omiten)` +
    (invalidos ? `\n• ${invalidos} sin fecha válida (se omiten)` : '') + '\n\n¿Importar?';
  if (!nuevos.length) { alert(msg.replace('\n\n¿Importar?', '')); return; }
  if (!confirm(msg)) return;

  for (let i = 0; i < nuevos.length; i += 200) {
    const creados = await sbRequest('POST', 'fp_pacientes', nuevos.slice(i, i + 200));
    creados.forEach(c => PACIENTES.set(c.id, c));
  }
  await sincronizarCruce();
  mostrarAviso(`${nuevos.length} pacientes importados.`);
}

// ===================== EVENTOS =====================
form.addEventListener('submit', guardarPaciente);
form.empresa.addEventListener('change', actualizarSugerencia);
form.uvr.addEventListener('input', actualizarSugerencia);
form.valor.addEventListener('input', () => { VALOR_MANUAL = form.valor.value !== ''; });
document.getElementById('pacRepetir').addEventListener('click', repetirAnterior);
document.getElementById('pacEliminar').addEventListener('click', eliminarPaciente);
document.getElementById('pacCancelar').addEventListener('click', () => limpiarForm({ conservarFecha: false }));
['pacMes', 'pacQ', 'pacEstado'].forEach(id => document.getElementById(id).addEventListener('input', renderPacientes));
document.getElementById('pacExport').addEventListener('click', exportarPacientes);
document.getElementById('pacImport').addEventListener('click', () => document.getElementById('pacImportFile').click());
document.getElementById('pacImportFile').addEventListener('change', async e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try { await importarExcel(f); } catch (err) { alert('No se pudo importar: ' + err.message); }
});

async function iniciarPacientes() {
  await cargarPacientes();
  document.getElementById('pacMes').value = hoyISO().slice(0, 7);
  limpiarForm({ conservarFecha: false });
  renderPacientes();
}
