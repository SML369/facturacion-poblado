// Modulo de pacientes del dia + relaciones de pacientes de la clinica.
// Depende de app.js (sbGetAll, sbUpsert, sbRequest, logLine, cop, FACTURAS, ULTIMO_CALC).

// ===================== PARSEO DE RELACIONES (funciones puras) =====================
// Las relaciones de 2025+ guardan el texto por columnas con la misma coordenada Y,
// asi que agrupar por linea (extractPdfText) las mezcla. Se lee en el orden del
// propio PDF usando los saltos de linea (hasEOL) que marca pdf.js.
async function extractPdfStreamText(arrayBuffer) {
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer, isEvalSupported: false }).promise;
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
  // Sin "Abonos:" legible se toma 0, para que no reemplace a una version que si los trae.
  const abonos = parseNumAuto(campo(/Abonos:\s*([\d.,]+)/i)) || 0;
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
  const m = rel.archivo.match(/JMA[\s_-]*(\d+)/i);
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
// Lo que "Copiar datos del paciente anterior" copia: datos del turno/quirofano, no los del paciente.
const CAMPOS_REPETIBLES = ['fecha', 'institucion', 'cirujano', 'procedimiento', 'duracion', 'tecnica', 'medicamentos',
  'via_aerea', 'relajante', 'bloqueo', 'metodo', 'anestesico'];
// Campos que se eligen de una lista de valores ya usados (o se escribe uno nuevo).
const CAMPOS_CON_LISTA = CAMPOS_TEXTO.map(([col]) => col).filter(col => col !== 'nombre' && col !== 'apellidos');

const DIAS_ALERTA_SIN_RELACION = 45;
const NOMBRES_MES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

let PACIENTES = new Map();   // id -> paciente
let RELACIONES = new Map();  // factura -> relacion
let EDITANDO_ID = null;      // paciente abierto en la ventana de edicion
let ULTIMO_GUARDADO_ID = null;
let CRUCE = null;            // resultado del ultimo cruce; null = hay que recalcularlo
let MES_VISTA = '';          // "2026-11" o "" = todos los meses
let OPCIONES = new Map();    // col -> valores ya usados, de mas a menos frecuente

function limpiarTexto(v) {
  const t = String(v ?? '').replace(/\s+/g, ' ').trim().toUpperCase();
  return t || null;
}
// Fecha local (no UTC) de hoy mas `dias` (negativo = hacia atras).
function fechaDesdeHoy(dias = 0) {
  const d = new Date();
  d.setDate(d.getDate() + dias);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function hoyISO() {
  return fechaDesdeHoy(0);
}
function nombreMes(ym) {
  const [y, m] = ym.split('-');
  const nombre = NOMBRES_MES[parseInt(m) - 1];
  return `${nombre[0].toUpperCase()}${nombre.slice(1)} ${y}`;
}
function fechaCorta(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}
function diasEntre(isoA, isoB) {
  return Math.round((new Date(isoB) - new Date(isoA)) / 86400000);
}
function diaNumero(iso) {
  return Math.round(Date.parse(iso) / 86400000);
}
function fechaValida(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === iso;
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Ejecuta fn sobre cada elemento, con pocas peticiones a la vez para no saturar la conexion.
async function enParalelo(items, limite, fn) {
  let siguiente = 0;
  const trabajador = async () => { while (siguiente < items.length) await fn(items[siguiente++]); };
  await Promise.all(Array.from({ length: Math.min(limite, items.length) }, trabajador));
}

async function cargarPacientes() {
  const [pacs, rels] = await Promise.all([sbGetAll('fp_pacientes'), sbGetAll('fp_relaciones')]);
  PACIENTES = new Map(pacs.map(p => [p.id, p]));
  RELACIONES = new Map(rels.map(r => [r.id, r]));
  CRUCE = null;
}

// ===================== RELACIONES: GUARDAR VERSION VIGENTE =====================
// Devuelven true si se guardo una version nueva (quien llama debe rehacer el cruce al terminar).
async function procesarRelacion(file) {
  let rel;
  try {
    rel = parseRelacionText(await extractPdfStreamText(await file.arrayBuffer()), file.name);
  } catch (e) {
    logLine('err', `No se pudo leer la relación de pacientes (${e.message}).`, file.name);
    return false;
  }
  if (rel.skipped) { logLine('err', rel.razon, file.name); return false; }
  return guardarRelacion(rel);
}

async function guardarRelacion(rel) {
  const factura = identificarFacturaRelacion(rel, FACTURAS);
  if (!factura) {
    logLine('err', `Relación de pacientes (${rel.periodo}): no se pudo saber a qué factura JMA corresponde.`, rel.archivo);
    return false;
  }
  const previa = RELACIONES.get(factura);
  if (previa) {
    const nuevaPagadas = filasPagadas(rel);
    const previaPagadas = (previa.filas || []).filter(f => f.fechaPago).length;
    if (rel.abonos < previa.abonos || (rel.abonos === previa.abonos && nuevaPagadas < previaPagadas)) {
      logLine('dup', `Relación ${factura}: versión anterior (abonos ${cop(rel.abonos)}); se conserva la de ${cop(previa.abonos)}.`, rel.archivo);
      return false;
    }
    if (rel.abonos === previa.abonos && nuevaPagadas === previaPagadas) {
      logLine('dup', `Relación ${factura} ya estaba registrada con los mismos abonos — no se duplicó.`, rel.archivo);
      return false;
    }
  }
  const row = {
    id: factura, periodo: rel.periodo, liquidacion: rel.liquidacion, retencion: rel.retencion,
    abonos: rel.abonos, pendiente: rel.pendiente, archivo: rel.archivo, filas: rel.filas,
    updated_at: new Date().toISOString(),
  };
  await sbUpsert('fp_relaciones', row);
  RELACIONES.set(factura, row);
  CRUCE = null;
  logLine('ok', `Relación ${factura} (${rel.periodo}) guardada: ${rel.filas.length} pacientes, ${filasPagadas(rel)} con pago.`, rel.archivo);
  return true;
}

// ===================== CRUCE PACIENTES <-> RELACIONES =====================
function tokensNombre(s) {
  return normNombre(s).split(' ').filter(t => t.length > 2);
}

// true si las dos palabras son iguales o difieren en una sola letra (cambiada, sobrante o faltante).
function casiIguales(a, b) {
  if (a.length > b.length) return casiIguales(b, a);
  if (b.length - a.length > 1) return false;
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  const sobra = b.length - a.length;   // 1 = "b" tiene una letra de mas; 0 = mismo largo (una letra cambiada)
  for (let j = i + 1 - sobra; j < a.length; j++) {
    if (a[j] !== b[j + sobra]) return false;
  }
  return true;
}

// Tolera errores de digitacion (FANNY/FANY), nombres cortados en el PDF ("DE BUSTA")
// y palabras pegadas a la aseguradora ("ORTEGACOLSANITAS").
function tokenCoincide(token, atencion) {
  if (atencion.tokens.has(token)) return true;
  if (token.length >= 4 && atencion.texto.includes(token)) return true;
  for (const t of atencion.tokens) {
    if (t.length >= 4 && token.startsWith(t)) return true;
    if (token.length >= 5 && casiIguales(token, t)) return true;
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
  if (CRUCE) return CRUCE;
  const filas = atencionesDeRelaciones();
  const diaFila = filas.map(r => (r.fila.fechaCirugia ? diaNumero(r.fila.fechaCirugia) : NaN));

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
    const diaPaciente = diaNumero(p.fecha);
    filas.forEach((r, idx) => {
      // A mas de 62 dias nunca cruza: se descarta antes de comparar nombres, que es lo costoso.
      const dias = Math.abs(diaFila[idx] - diaPaciente);
      if (!(dias <= 62)) return;
      let coinciden = 0;
      for (const t of toks) {
        if (tokenCoincide(t, r)) coinciden++;
        else if (dias > 7) return;   // lejos de la fecha solo sirve el nombre completo
      }
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
  CRUCE = { asignados, sinPaciente };
  return CRUCE;
}

// Rehace el cruce y guarda en cada paciente la factura, admision y pago encontrados.
// Se llama cada vez que cambian los pacientes o las relaciones.
async function sincronizarCruce() {
  CRUCE = null;
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
    if (Object.keys(nuevo).some(k => (p[k] || null) !== nuevo[k])) cambios.push({ p, nuevo });
  }
  try {
    // Solo se envian las columnas del cruce: mandar la fila completa pisaria lo que
    // el otro usuario haya editado y reviviria pacientes eliminados en otro dispositivo.
    await enParalelo(cambios, 6, async ({ p, nuevo }) => {
      const filas = await sbRequest('PATCH', `fp_pacientes?id=eq.${p.id}`, nuevo);
      if (filas.length) Object.assign(p, nuevo);
      else { PACIENTES.delete(p.id); CRUCE = null; }   // eliminado desde otro dispositivo
    });
  } catch (err) {
    alert('No se pudo actualizar el estado de pago de algunos pacientes: ' + err.message);
  }
  renderPacientes();
}

// Facturas que la cartera (pestaña Cartera) ya da por pagadas con los recibos subidos.
// Las que solo deben el parqueadero (~250.000) no cuentan hasta que se suban esos recibos.
function facturasSaldadas() {
  const resumen = ULTIMO_CALC ? ULTIMO_CALC.resumen : [];
  return new Set(resumen.filter(r => r.saldo <= 500).map(r => r.factura));
}

// Un paciente esta pagado si la relacion trae fecha de pago O si su factura ya quedo saldada.
function motivoPago(p, saldadas = facturasSaldadas()) {
  return { enRelacion: !!p.fecha_pago, facturaSaldada: !!p.factura_jma && saldadas.has(p.factura_jma) };
}

function estadoPaciente(p, saldadas) {
  const motivo = motivoPago(p, saldadas);
  if (motivo.enRelacion || motivo.facturaSaldada) return 'pagado';
  if (p.factura_jma) return 'enrelacion';
  return diasEntre(p.fecha, hoyISO()) > DIAS_ALERTA_SIN_RELACION ? 'sinrelacion' : 'reciente';
}
const ESTADO_PACIENTE_LABEL = {
  pagado: 'Pagado', enrelacion: 'Reportado por la clínica, falta pago',
  reciente: 'Esperando reporte de la clínica', sinrelacion: 'La clínica no lo ha reportado (más de 45 días)',
};

// Texto que acompaña al estado en la fila: por que condicion quedo pagado, o en que factura esta.
function detalleEstado(p, saldadas) {
  const { enRelacion, facturaSaldada } = motivoPago(p, saldadas);
  if (enRelacion && facturaSaldada) return 'en relación y factura saldada';
  if (enRelacion) return `en relación (${fechaCorta(p.fecha_pago)}${p.lote ? ', lote ' + p.lote : ''})`;
  if (facturaSaldada) return `factura ${p.factura_jma} saldada`;
  if (p.factura_jma) return `factura ${p.factura_jma}`;
  return '';
}

// Valor que reporta la clinica en la relacion con la que cruzo el paciente; null si aun no hay.
function valorRelacion(p) {
  const a = cruzarRelaciones().asignados.get(p.id);
  return a ? a.fila.total : null;
}

// ===================== FORMULARIO =====================
// La misma ficha se arma dos veces: en "Nuevo paciente" y en la ventana de edicion.
// El prefijo distingue los ids (f_nombre / e_nombre); los name son iguales en ambas.
function campoHTML(prefijo, col, etiqueta, { span2 = false, tipo = 'text', extra = '', conError = false } = {}) {
  const id = `${prefijo}_${col}`;
  const input = CAMPOS_CON_LISTA.includes(col)
    ? `<input id="${id}" name="${col}" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="${id}_lista" autocapitalize="characters" autocomplete="off">
       <ul class="combo-lista" id="${id}_lista" role="listbox" hidden></ul>`
    : `<input id="${id}" name="${col}" type="${tipo}" ${extra}>`;
  return `<div class="field${span2 ? ' span2' : ''}${CAMPOS_CON_LISTA.includes(col) ? ' combo' : ''}">
    <label for="${id}">${etiqueta}</label>${input}${conError ? '<div class="field-error" hidden></div>' : ''}</div>`;
}

function camposFormHTML(prefijo) {
  const clinicos = CAMPOS_TEXTO_CLINICOS.map(([col, etiqueta]) =>
    campoHTML(prefijo, col, etiqueta, { span2: ['comorbilidad', 'medicamentos', 'bloqueo'].includes(col) })).join('');
  return `
    <div class="grid">
      <div class="field span2"><label for="${prefijo}_fecha">Fecha</label>
        <div class="fecha-row">
          <input id="${prefijo}_fecha" name="fecha" type="date">
          <button class="btn" type="button" data-dias="0">Hoy</button>
          <button class="btn" type="button" data-dias="-1">Ayer</button>
        </div>
        <div class="field-error" hidden></div>
      </div>
      ${campoHTML(prefijo, 'nombre', 'Nombre', { span2: true, extra: 'autocapitalize="characters"', conError: true })}
      ${campoHTML(prefijo, 'apellidos', 'Apellidos', { span2: true, extra: 'autocapitalize="characters"' })}
      ${campoHTML(prefijo, 'empresa', 'Aseguradora', { span2: true })}
      ${campoHTML(prefijo, 'procedimiento', 'Procedimiento', { span2: true })}
      ${campoHTML(prefijo, 'cirujano', 'Cirujano', { span2: true })}
      ${campoHTML(prefijo, 'institucion', 'Institución', { span2: true })}
      ${campoHTML(prefijo, 'edad', 'Edad', { tipo: 'number', extra: 'inputmode="numeric" min="0" max="120"' })}
      ${campoHTML(prefijo, 'uvr', 'UVR', { tipo: 'number', extra: 'inputmode="decimal" step="any" min="0"' })}
    </div>
    <details class="clinico">
      <summary>Datos de anestesia (opcional)</summary>
      <div class="grid">${clinicos}</div>
    </details>`;
}

const form = document.getElementById('pacForm');            // nuevo paciente
const formEdicion = document.getElementById('editForm');    // ventana de edicion
const dialogoEdicion = document.getElementById('editDialog');
form.querySelector('.campos').innerHTML = camposFormHTML('f');
formEdicion.querySelector('.campos').innerHTML = camposFormHTML('e');

// ---------- Selector con lista de valores usados ----------
// Compara sin tildes ni mayusculas, conservando los digitos (ASA 2, 45 MIN).
function normBusqueda(s) {
  return String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

function cerrarCombo(wrap) {
  wrap.querySelector('.combo-lista').hidden = true;
  wrap.querySelector('input').setAttribute('aria-expanded', 'false');
}

function iniciarCombobox(wrap) {
  const input = wrap.querySelector('input');
  const lista = wrap.querySelector('.combo-lista');
  let activo = -1;   // opcion resaltada con el teclado

  function abrir() {
    const texto = input.value.trim();
    const q = normBusqueda(texto);
    const todas = OPCIONES.get(input.name) || [];
    const filtradas = q ? todas.filter(v => normBusqueda(v).includes(q)) : todas;
    const esNuevo = q && !todas.some(v => normBusqueda(v) === q);
    const items = esNuevo ? [`<li role="option" class="nuevo" data-valor="${esc(texto)}">➕ Usar «${esc(texto)}»</li>`] : [];
    items.push(...filtradas.map(v => `<li role="option" data-valor="${esc(v)}">${esc(v)}</li>`));
    if (!items.length) { cerrarCombo(wrap); return; }
    lista.innerHTML = items.join('');
    lista.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    activo = -1;
  }
  function elegir(li) {
    input.value = li.dataset.valor;
    cerrarCombo(wrap);
  }
  function mover(paso) {
    const n = lista.children.length;
    if (!n) return;
    activo = (activo + paso + n) % n;
    [...lista.children].forEach((li, i) => li.classList.toggle('activo', i === activo));
    lista.children[activo].scrollIntoView({ block: 'nearest' });
  }

  input.addEventListener('focus', abrir);
  input.addEventListener('click', abrir);   // en el celular el campo puede tener ya el foco
  input.addEventListener('input', abrir);
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (lista.hidden) abrir(); mover(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); mover(-1); }
    else if (e.key === 'Enter' && !lista.hidden) { e.preventDefault(); if (activo >= 0) elegir(lista.children[activo]); else cerrarCombo(wrap); }
    else if (e.key === 'Escape' && !lista.hidden) { e.preventDefault(); cerrarCombo(wrap); }   // no cierra la ventana de edicion
    else if (e.key === 'Tab') cerrarCombo(wrap);
  });
  lista.addEventListener('mousedown', e => e.preventDefault());   // que el campo no pierda el foco al tocar la lista
  lista.addEventListener('click', e => { const li = e.target.closest('li'); if (li) elegir(li); });
  wrap.addEventListener('focusout', e => { if (!wrap.contains(e.relatedTarget)) cerrarCombo(wrap); });
}
document.querySelectorAll('.combo').forEach(iniciarCombobox);
document.addEventListener('pointerdown', e => {
  if (e.target.closest('.combo')) return;
  document.querySelectorAll('.combo').forEach(cerrarCombo);
});

// Valores ya usados por campo, de mas a menos frecuente (alimentan las listas).
function calcularOpciones() {
  OPCIONES = new Map();
  for (const col of CAMPOS_CON_LISTA) {
    const conteo = new Map();
    for (const p of PACIENTES.values()) if (p[col]) conteo.set(p[col], (conteo.get(p[col]) || 0) + 1);
    OPCIONES.set(col, [...conteo.entries()].sort((a, b) => b[1] - a[1]).map(([v]) => v));
  }
}

// ---------- Lectura, llenado y validacion de la ficha ----------
function valoresForm(f) {
  const p = { fecha: f.fecha.value };
  for (const [col] of CAMPOS_TEXTO) p[col] = limpiarTexto(f[col].value);
  p.edad = f.edad.value ? parseInt(f.edad.value) : null;
  p.uvr = f.uvr.value ? parseFloat(f.uvr.value) : null;
  return p;
}

function llenarForm(f, p) {
  f.fecha.value = p.fecha || hoyISO();
  for (const [col] of CAMPOS_TEXTO) f[col].value = p[col] || '';
  f.edad.value = p.edad ?? '';
  f.uvr.value = p.uvr ?? '';
  limpiarErrores(f);
}

function marcarError(f, col, mensaje) {
  const input = f[col];
  input.setAttribute('aria-invalid', 'true');
  const err = input.closest('.field').querySelector('.field-error');
  err.textContent = mensaje;
  err.hidden = false;
}
// Sin `input` limpia todos los avisos de la ficha; con el, solo el de ese campo.
function limpiarErrores(f, input = null) {
  const campos = input ? [input.closest('.field')] : [...f.querySelectorAll('.field')];
  for (const campo of campos) {
    campo.querySelectorAll('[aria-invalid]').forEach(el => el.removeAttribute('aria-invalid'));
    campo.querySelectorAll('.field-error').forEach(el => { el.hidden = true; });
  }
}
// true si la ficha se puede guardar; si no, marca los campos que faltan.
function validarForm(f, p) {
  limpiarErrores(f);
  if (!p.fecha) marcarError(f, 'fecha', 'Falta la fecha. Puedes tocar "Hoy" o "Ayer".');
  if (!p.nombre) marcarError(f, 'nombre', 'Falta el nombre del paciente.');
  if (p.fecha && p.nombre) return true;
  f.querySelector('[aria-invalid]').focus();
  return false;
}

function limpiarForm({ conservarFecha }) {
  const fecha = form.fecha.value;
  const institucion = form.institucion.value;
  form.reset();
  limpiarErrores(form);
  form.fecha.value = conservarFecha && fecha ? fecha : hoyISO();
  form.institucion.value = institucion || ultimoValor('institucion') || '';
}

function pacientesOrdenados() {
  return [...PACIENTES.values()].sort((a, b) =>
    (b.fecha || '').localeCompare(a.fecha || '') || (b.created_at || '').localeCompare(a.created_at || ''));
}
function ultimoValor(col) {
  const p = pacientesOrdenados().find(x => x[col]);
  return p ? p[col] : null;
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

// Guarda la ficha enviada: la de "Nuevo paciente" crea, la de la ventana de edicion actualiza.
async function guardarPaciente(e) {
  e.preventDefault();
  const f = e.target;
  const editando = f === formEdicion;
  const p = valoresForm(f);
  if (!validarForm(f, p)) return;
  const btn = f.querySelector('button[type=submit]');
  btn.disabled = true;
  try {
    let guardado = null;
    if (editando) {
      p.updated_at = new Date().toISOString();
      const [actualizado] = await sbRequest('PATCH', `fp_pacientes?id=eq.${EDITANDO_ID}`, p);
      if (actualizado) {
        PACIENTES.set(EDITANDO_ID, actualizado);
        guardado = actualizado;
      } else {
        // El PATCH no encontro la fila: la borraron desde otro dispositivo.
        PACIENTES.delete(EDITANDO_ID);
        alert('Este paciente fue eliminado desde otro dispositivo; no se guardaron los cambios.');
      }
      dialogoEdicion.close();
    } else {
      const [creado] = await sbRequest('POST', 'fp_pacientes', p);
      PACIENTES.set(creado.id, creado);
      guardado = creado;
      limpiarForm({ conservarFecha: true });
    }
    if (guardado) {
      ULTIMO_GUARDADO_ID = guardado.id;
      mostrarAviso(`✓ Guardado: ${guardado.nombre} ${guardado.apellidos || ''} — ${fechaCorta(guardado.fecha)}`, guardado.id);
    }
  } catch (err) {
    alert('No se pudo guardar: ' + err.message);
    btn.disabled = false;
    return;
  }
  await sincronizarCruce();
  btn.disabled = false;
}

async function eliminarPaciente() {
  const p = PACIENTES.get(EDITANDO_ID);
  if (!p || !confirm(`¿Eliminar a ${p.nombre} ${p.apellidos || ''} (${fechaCorta(p.fecha)})?`)) return;
  try {
    await sbRequest('DELETE', `fp_pacientes?id=eq.${EDITANDO_ID}`);
  } catch (err) {
    alert('No se pudo eliminar: ' + err.message);
    return;
  }
  PACIENTES.delete(EDITANDO_ID);
  dialogoEdicion.close();
  // La fila de relacion que tenia este paciente queda libre para otro: se rehace el cruce.
  await sincronizarCruce();
}

// Abre la ventana de edicion con la ficha llena; el formulario de nuevo paciente no se toca.
function editarPaciente(id) {
  const p = PACIENTES.get(id);
  if (!p || dialogoEdicion.open) return;
  llenarForm(formEdicion, p);
  EDITANDO_ID = id;
  document.getElementById('editTitulo').textContent = `Corregir: ${p.nombre} ${p.apellidos || ''}`;
  dialogoEdicion.showModal();
  dialogoEdicion.scrollTop = 0;
}

let avisoTimer = null;
// Aviso grande tras guardar. Con idCorregir muestra el boton "Corregir", que abre ese paciente.
function mostrarAviso(texto, idCorregir = null) {
  const el = document.getElementById('pacAviso');
  const btn = document.getElementById('pacCorregir');
  document.getElementById('pacAvisoTexto').textContent = texto;
  btn.hidden = !idCorregir;
  btn.onclick = idCorregir ? () => { el.hidden = true; editarPaciente(idCorregir); } : null;
  el.hidden = false;
  clearTimeout(avisoTimer);
  avisoTimer = setTimeout(() => { el.hidden = true; }, 6000);
}

// ===================== LISTA Y RESUMEN =====================
function cambiarMes(paso) {
  const [y, m] = (MES_VISTA || hoyISO().slice(0, 7)).split('-').map(Number);
  const d = new Date(y, m - 1 + paso, 1);
  MES_VISTA = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  renderPacientes();
}
function verTodosLosMeses() {
  MES_VISTA = MES_VISTA ? '' : hoyISO().slice(0, 7);
  renderPacientes();
}

function renderPacientes() {
  calcularOpciones();
  const mes = MES_VISTA;
  const q = normNombre(document.getElementById('pacQ').value);
  const filtroEstado = document.getElementById('pacEstado').value;
  const saldadas = facturasSaldadas();
  const estadoDe = p => estadoPaciente(p, saldadas);

  document.getElementById('pacMesLabel').textContent = mes ? nombreMes(mes) : 'Todos los meses';
  document.getElementById('pacVerTodos').textContent = mes ? 'Ver todos' : 'Ver este mes';
  document.getElementById('pacMesAnt').disabled = !mes;
  document.getElementById('pacMesSig').disabled = !mes;
  document.getElementById('pacListaNota').hidden = !(q && mes);

  const delMes = pacientesOrdenados().filter(p => !mes || (p.fecha || '').startsWith(mes));
  // Al buscar se revisan todos los meses, para encontrar pacientes viejos sin cambiar el mes.
  const visibles = (q ? pacientesOrdenados() : delMes).filter(p =>
    (!filtroEstado || estadoDe(p) === filtroEstado) &&
    (!q || normNombre(`${p.nombre} ${p.apellidos} ${p.empresa} ${p.procedimiento} ${p.cirujano}`).includes(q)));

  const estados = delMes.map(estadoDe);
  const reportados = estados.filter(st => st === 'pagado' || st === 'enrelacion').length;
  const pagados = estados.filter(st => st === 'pagado').length;
  const alertas = [...PACIENTES.values()].filter(p => estadoDe(p) === 'sinrelacion').length;
  document.getElementById('pacTiles').innerHTML = `
    <div class="tile"><div class="label">Pacientes ${mes ? 'del mes' : '(todos)'}</div><div class="value">${delMes.length}</div></div>
    <div class="tile"><div class="label">Reportados por la clínica</div><div class="value">${reportados}</div></div>
    <div class="tile"><div class="label">Pagados</div><div class="value">${pagados}</div></div>
    <div class="tile flag"><div class="label">Sin reporte &gt;${DIAS_ALERTA_SIN_RELACION} días</div><div class="value">${alertas}</div></div>`;

  const lista = document.getElementById('pacRows');
  lista.innerHTML = visibles.length ? '' : '<div class="empty-list">No hay pacientes con estos filtros.</div>';
  for (const p of visibles) {
    const st = estadoDe(p);
    const detalle = detalleEstado(p, saldadas);
    const valor = valorRelacion(p);
    const row = document.createElement('div');
    row.className = 'prow';
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.innerHTML = `
      <div class="fecha mono">${fechaCorta(p.fecha)}</div>
      <div class="pac"><b>${esc(p.nombre)} ${esc(p.apellidos || '')}</b><span>${esc(p.procedimiento || '')}${p.cirujano ? ' · ' + esc(p.cirujano) : ''}</span></div>
      <div class="emp">${esc(p.empresa || '')}</div>
      <div class="uvr num mono">${p.uvr ?? ''}</div>
      <div class="valor num mono">${valor != null ? cop(valor) : '<span class="pendiente-valor">Pendiente</span>'}</div>
      <div class="estado"><span class="pill estado-pac ${st}">${ESTADO_PACIENTE_LABEL[st]}</span>${detalle ? `<span class="estado-detalle">· ${esc(detalle)}</span>` : ''}</div>
      <div class="acciones"><button class="btn" type="button">Editar</button></div>`;
    row.addEventListener('click', () => editarPaciente(p.id));
    row.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target === row) editarPaciente(p.id); });
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
    ? sinPaciente.slice(0, 200).map(r => `<li><b>${esc(fechaCorta(r.fila.fechaCirugia))}</b> ${esc(r.fila.paciente)} — ${esc(r.fila.aseguradora)} <span class="mono">(${esc(r.factura)})</span></li>`).join('')
    : '<li>Ninguno.</li>';
}

// ===================== EXPORTAR =====================
function exportarPacientes() {
  const filas = pacientesOrdenados().reverse().map(p => {
    const fila = { FECHA: fechaCorta(p.fecha) };
    for (const [col, , encabezado] of CAMPOS_TEXTO) fila[encabezado] = p[col] || '';
    fila.EDAD = p.edad ?? '';
    fila.UVR = p.uvr ?? '';
    fila.VALOR = valorRelacion(p) ?? '';   // el que reporta la clinica en la relacion
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
  if (typeof fechaRaw === 'number') {
    // Numero de serie de Excel (25569 = 1970-01-01). No depende de la zona horaria del dispositivo.
    const d = new Date((Math.floor(fechaRaw) - 25569) * 86400000);
    if (!isNaN(d)) fecha = d.toISOString().slice(0, 10);
  } else if (typeof fechaRaw === 'string') {
    // Tolera fechas mal digitadas en el Sheet: "03//06/2026", "19/082026", "10/11//2026".
    const m = fechaRaw.match(/^\s*(\d{1,2})\D+(\d{1,2})\D*(\d{4})\s*$/);
    if (m) fecha = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    else if (/^\d{4}-\d{2}-\d{2}/.test(fechaRaw)) fecha = fechaRaw.slice(0, 10);
  }
  // Fechas imposibles (31/02) o absurdas (un numero que no era fecha) se descartan aqui y no en la base.
  if (fecha && !(fechaValida(fecha) && fecha >= '2000-01-01' && fecha <= '2100-12-31')) fecha = null;
  const p = { fecha };
  for (const [col, , encabezado] of CAMPOS_TEXTO) p[col] = idx[encabezado] != null ? limpiarTexto(fila[idx[encabezado]]) : null;
  const num = v => (v === '' || v == null || isNaN(Number(v)) ? null : Number(v));
  const edad = num(fila[idx.EDAD]);
  p.edad = edad == null ? null : Math.round(edad);   // la columna es entera
  p.uvr = num(fila[idx.VALOR]);          // en el Excel "VALOR" son las UVR
  p.valor = num(fila[idx.FACTURADO]);    // y "FACTURADO" es el valor en pesos
  return p;
}

// Sin cellDates: las fechas llegan como numero de serie y no como Date en hora local.
function leerFilasExcel(buffer) {
  const wb = XLSX.read(buffer);
  return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: null });
}

async function importarExcel(file) {
  const filas = leerFilasExcel(await file.arrayBuffer());
  const idx = {};
  (filas[0] || []).forEach((h, i) => { if (h) idx[normNombre(h)] = i; });
  if (idx.FECHA == null || idx.NOMBRE == null) {
    alert('No se reconoció el formato: la primera fila debe tener los encabezados FECHA, NOMBRE, APELLIDOS…');
    return;
  }

  const existentes = new Set([...PACIENTES.values()].map(claveDuplicado));
  const nuevos = [];
  const filasSinFecha = [];   // numero de fila en el Excel
  let repetidos = 0;
  filas.slice(1).forEach((fila, i) => {
    const p = filaExcelAPaciente(fila, idx);
    if (!p.nombre) return;
    if (!p.fecha) { filasSinFecha.push(i + 2); return; }
    const k = claveDuplicado(p);
    if (existentes.has(k)) { repetidos++; return; }
    existentes.add(k);
    nuevos.push(p);
  });

  const msg = `Archivo "${file.name}":\n• ${nuevos.length} pacientes nuevos para importar\n• ${repetidos} ya estaban registrados (se omiten)` +
    (filasSinFecha.length ? `\n• ${filasSinFecha.length} sin fecha válida (se omiten): fila ${filasSinFecha.slice(0, 15).join(', ')}${filasSinFecha.length > 15 ? '…' : ''}` : '') +
    '\n\n¿Importar?';
  if (!nuevos.length) { alert(msg.replace('\n\n¿Importar?', '')); return; }
  if (!confirm(msg)) return;

  try {
    for (let i = 0; i < nuevos.length; i += 200) {
      const creados = await sbRequest('POST', 'fp_pacientes', nuevos.slice(i, i + 200));
      creados.forEach(c => PACIENTES.set(c.id, c));
    }
    mostrarAviso(`${nuevos.length} pacientes importados.`);
  } finally {
    // Aunque falle un lote, los que si entraron deben quedar cruzados y a la vista.
    await sincronizarCruce();
  }
}

// ===================== EVENTOS =====================
form.addEventListener('submit', guardarPaciente);
formEdicion.addEventListener('submit', guardarPaciente);
for (const f of [form, formEdicion]) {
  // Botones "Hoy" / "Ayer" junto a la fecha.
  f.querySelectorAll('[data-dias]').forEach(btn => btn.addEventListener('click', () => {
    f.fecha.value = fechaDesdeHoy(parseInt(btn.dataset.dias));
    limpiarErrores(f, f.fecha);
  }));
  // El aviso en rojo desaparece apenas se corrige el campo.
  f.addEventListener('input', e => { if (e.target.getAttribute('aria-invalid')) limpiarErrores(f, e.target); });
}
document.getElementById('pacRepetir').addEventListener('click', repetirAnterior);
document.getElementById('editEliminar').addEventListener('click', eliminarPaciente);
document.getElementById('editCancelar').addEventListener('click', () => dialogoEdicion.close());
dialogoEdicion.addEventListener('close', () => { EDITANDO_ID = null; });
document.getElementById('pacMesAnt').addEventListener('click', () => cambiarMes(-1));
document.getElementById('pacMesSig').addEventListener('click', () => cambiarMes(1));
document.getElementById('pacVerTodos').addEventListener('click', verTodosLosMeses);
['pacQ', 'pacEstado'].forEach(id => document.getElementById(id).addEventListener('input', renderPacientes));
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
  MES_VISTA = hoyISO().slice(0, 7);
  limpiarForm({ conservarFecha: false });
  // Al abrir se rehace el cruce: corrige lo que haya quedado a medias en otra sesion.
  await sincronizarCruce();
}
