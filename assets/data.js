/* ============================================================================
   Asistente Hidrocarburos · ANH — chat-assistant
   data.js — constantes
   ============================================================================ */
window.__CA_DATA__ = (function () {
    "use strict";

    var BASE_URL = window.location.origin;
    var ENDPOINT_INVOCAR    = "/functions/IaCore.invocarAgenteHidrocarburos";
    var ENDPOINT_CONSULTAR  = "/functions/IaCore.consultarUltimoTurno";
    var ENDPOINT_LISTAR     = "/functions/IaCore.listarConversaciones";
    var ENDPOINT_CARGAR     = "/functions/IaCore.cargarConversacion";
    var ENDPOINT_TRAVESIA   = "/functions/IaCore.armarTravesiaTurno";
    var ENDPOINT_FEEDBACK   = "/functions/IaCore.anhRegistrarFeedback";
    var ENDPOINT_GRAFO_CONC = "/functions/IaCore.armarGrafoConceptual";
    var ENDPOINT_DETALLAR   = "/functions/IaCore.detallarDocumentoCitado";
    var ENDPOINT_MODELOS    = "/functions/IaCore.listarModelosLlm";
    var ENDPOINT_ARCHIVAR   = "/functions/IaCore.archivarConversacion";
    var ENDPOINT_DESARCHIVAR= "/functions/IaCore.desarchivarConversacion";
    var ENDPOINT_ELIMINAR   = "/functions/IaCore.eliminarConversacion";

    // Modelos disponibles — FALLBACK estatico si el fetch dinamico falla.
    // La lista REAL se carga en init() desde IaCore.listarModelosLlm que lee
    // aia.Model status='enabled' (incluye gpt-oss:120b, gpt-4o, mistral14, etc).
    var MODELOS = [
        {
            id: 13238,
            nombre: "ministral-3:14b",
            label: "Mistral 3 14B (productivo)",
            shortLabel: "Mistral 14B",
            desc: "Default · rápido · Ollama anh-inf2",
            default: true
        }
    ];

    var TOOLS = [
        {
            name: "anhLookupSimple",
            level: "N1",
            label: "Lookup simple",
            desc: "Localiza UN registro en UNA entidad estructurada.",
            tooltip: "Lookup atómico de UN dato",
            tooltipHtml: "<strong>Cuándo usar:</strong> pides UN dato de UN registro identificado. " +
                         "<em>Ej: estado del contrato Buganviles, fecha de firma, operador del bloque LLA-27.</em><br>" +
                         "<strong>Cuándo NO:</strong> agregaciones, narrativas, series temporales."
        },
        {
            name: "anhAgregarHidrocarburos",
            level: "N2",
            label: "Agregación / Conteo",
            desc: "COUNT/SUM/AVG agrupado por dimensión estructural.",
            tooltip: "Conteos y agregaciones",
            tooltipHtml: "<strong>Cuándo usar:</strong> COUNT, SUM, AVG, MIN, MAX agrupados por columna estructural. " +
                         "<em>Ej: cuántos contratos hay por cuenca, total de regalías por operador.</em><br>" +
                         "<strong>Cuándo NO:</strong> series temporales (eso es N5), agrupaciones que no son columna real."
        },
        {
            name: "anhRecuperarVinculosHidrocarburos",
            level: "N3",
            label: "Vínculos documentales",
            desc: "Búsqueda en texto documental (embeddings).",
            tooltip: "Búsqueda semántica en documentos",
            tooltipHtml: "<strong>Cuándo usar:</strong> default si la pregunta es narrativa o no encaja en otra. " +
                         "<em>Ej: qué normas mencionan formación Carbonera, asunto del oficio ANH-12-007674-2008.</em><br>" +
                         "Soporta documento_id de turno previo para profundizar."
        },
        {
            name: "anhGeoespacialHidrocarburos",
            level: "N4",
            label: "Geoespacial",
            desc: "Área, profundidad, coordenadas o ubicación.",
            tooltip: "Datos geoespaciales",
            tooltipHtml: "<strong>Cuándo usar:</strong> coordenadas, área (hectáreas/km²), profundidad, ubicación (departamento/municipio). " +
                         "<em>Ej: coordenadas del bloque Llanos 27, profundidad del pozo Atarraya-1.</em><br>" +
                         "Solo 4 atributos: area, profundidad, coordenadas, ubicacion."
        },
        {
            name: "anhSerieTemporalHidrocarburos",
            level: "N5",
            label: "Serie temporal",
            desc: "Series numéricas multi-período.",
            tooltip: "Series multi-año",
            tooltipHtml: "<strong>Cuándo usar:</strong> requiere ventana temporal >=2 períodos + magnitud numérica. " +
                         "<em>Ej: regalías por año entre 2010 y 2020, tendencia de contratos suscritos.</em><br>" +
                         "<strong>Cuándo NO:</strong> dato puntual de un mes/año único (eso va a N3)."
        },
        {
            name: "anhBuscarImagenes3GHidrocarburos",
            level: "N6",
            label: "Imágenes 3G",
            desc: "Mapas, secciones, registros, fotografías técnicas.",
            tooltip: "Imágenes técnicas",
            tooltipHtml: "<strong>Cuándo usar:</strong> mapas geológicos, secciones estructurales, registros de pozo, " +
                         "diagramas geoquímicos, fotografías de afloramiento, columnas estratigráficas. " +
                         "<em>Ej: mostrar imágenes del documento 1230, mapas de cuenca Llanos.</em><br>" +
                         "Por default oculta imágenes con datos personales (C_04, C_05) y ruido operativo."
        },
        {
            name: "anhBuscarGeoVisorHidrocarburos",
            level: "N7",
            label: "GeoVisor catálogo",
            desc: "Inventario maestro georreferenciado oficial.",
            tooltip: "Catálogo GeoVisor ANH",
            tooltipHtml: "<strong>Cuándo usar:</strong> inventario oficial de las 12 entidades GeoVisor: " +
                         "Cuenca, Bloque, Contratos_Bloques, Contratos_Ep, Departamento, Municipio, Operadora, " +
                         "Pozos, Rezumaderos, Sismica2D, Sismica3D, Yacimientos. " +
                         "<em>Ej: cuencas sedimentarias, líneas sísmicas 2D, pozos catalogados con UWI.</em>"
        }
    ];

    var SUGERENCIAS = [
        "qué cuencas sedimentarias hay en Colombia",
        "fecha de firma del contrato Buganviles",
        "cuántos contratos hay por cuenca",
        "líneas sísmicas 2D adquiridas en Magdalena Medio",
        "coordenadas del bloque Llanos 27",
        "pozos del catálogo GeoVisor con grado API"
    ];

    var BLOQUES_PLANTILLA = [
        { tipo: "respuesta",       label: "RESPUESTA",       re: /^\s*\*?\*?RESPUESTA:?\*?\*?\s*$/im },
        { tipo: "fuente",          label: "FUENTE",          re: /^\s*\*?\*?FUENTE:?\*?\*?\s*$/im },
        { tipo: "alcance",         label: "ALCANCE",         re: /^\s*\*?\*?ALCANCE:?\*?\*?\s*$/im },
        { tipo: "vigencia",        label: "VIGENCIA",        re: /^\s*\*?\*?VIGENCIA:?\*?\*?\s*$/im },
        { tipo: "consideraciones", label: "CONSIDERACIONES", re: /^\s*\*?\*?CONSIDERACIONES:?\*?\*?\s*$/im },
        { tipo: "contenido",       label: "CONTENIDO DE LOS DOCUMENTOS",
          re: /^\s*\*?\*?CONTENIDO\s+DE\s+LOS\s+DOCUMENTOS:?\*?\*?\s*$/im }
    ];

    // Mapeo de fase del backend a icono SVG
    var FASE_ICONS = {
        iniciando: "ico-spinner",
        preparando: "ico-spinner",
        llm_decide: "ico-cpu",
        tool_call: "ico-zap",
        llm_compose: "ico-cpu",
        llm_force_compose: "ico-cpu",
        finalizando: "ico-check",
        completado: "ico-check",
        error: "ico-x"
    };

    // Mensaje humano descriptivo de cada fase. El backend a veces solo manda
    // `fase` (slug) sin `msg`; aqui traducimos para que el usuario vea narrativa
    // en lugar de "Iniciando..." generico todo el tiempo.
    var FASE_LABELS = {
        iniciando: "Conectando con el agente…",
        preparando: "Preparando el contexto del corpus…",
        contexto: "Cargando contexto institucional (Gobierno + ontología)…",
        ontologia: "Detectando conceptos en la ontología…",
        glosario: "Resolviendo entidades del glosario ANH…",
        llm_decide: "El LLM está eligiendo la herramienta apropiada…",
        tool_call: "Ejecutando herramienta sobre el corpus…",
        tool_lookup: "Lookup de dato puntual en BD estructural…",
        tool_agregar: "Agregando datos por dimensión…",
        tool_recuperar: "Búsqueda semántica sobre embeddings…",
        tool_geo: "Consultando capa geoespacial…",
        tool_serie: "Construyendo serie temporal…",
        tool_imagen: "Buscando imágenes técnicas…",
        tool_geovisor: "Consultando catálogo GeoVisor…",
        rerank: "Re-rankeando resultados por relevancia…",
        llm_compose: "Componiendo la respuesta con la evidencia…",
        llm_force_compose: "Reformulando la respuesta…",
        finalizando: "Finalizando…",
        completado: "Listo",
        error: "Error"
    };

    return {
        BASE_URL: BASE_URL,
        ENDPOINT_INVOCAR: ENDPOINT_INVOCAR,
        ENDPOINT_CONSULTAR: ENDPOINT_CONSULTAR,
        ENDPOINT_LISTAR: ENDPOINT_LISTAR,
        ENDPOINT_CARGAR: ENDPOINT_CARGAR,
        ENDPOINT_TRAVESIA: ENDPOINT_TRAVESIA,
        ENDPOINT_FEEDBACK: ENDPOINT_FEEDBACK,
        ENDPOINT_GRAFO_CONC: ENDPOINT_GRAFO_CONC,
        ENDPOINT_DETALLAR: ENDPOINT_DETALLAR,
        ENDPOINT_MODELOS: ENDPOINT_MODELOS,
        ENDPOINT_ARCHIVAR: ENDPOINT_ARCHIVAR,
        ENDPOINT_DESARCHIVAR: ENDPOINT_DESARCHIVAR,
        ENDPOINT_ELIMINAR: ENDPOINT_ELIMINAR,
        TOOLS: TOOLS,
        SUGERENCIAS: SUGERENCIAS,
        BLOQUES_PLANTILLA: BLOQUES_PLANTILLA,
        MODELOS: MODELOS,
        FASE_ICONS: FASE_ICONS,
        FASE_LABELS: FASE_LABELS
    };
})();
