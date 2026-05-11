/* ============================================================================
   Asistente Hidrocarburos · ANH — chat-assistant
   app.js — factory Alpine con polling, cancel, multi-modelo, rerun, atajos
   ============================================================================ */

function chatAssistant() {
    "use strict";

    const D = window.__CA_DATA__;
    const POLL_INTERVAL_MS = 1500;  // gap MIN entre el fin de un poll y el inicio del siguiente
    const POLL_TIMEOUT_MS = 30000;  // tope absoluto por poll (gateway puede tomar 18-19s bajo carga)
    const RESPONSE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 min cache local

    return {
        // ---------------- State ----------------
        prompt: "",
        turnos: [],
        conversacionId: null,
        loading: false,
        loadingMsg: "",
        lastError: "",
        drawerCita: null,
        theme: "auto",
        prefersReduced: false,
        qaMode: false,
        qaPreguntas: "",
        qaResultados: [],
        toolOverride: null,
        ultimaLatenciaMs: 0,
        sidebarOpen: true,
        abrirAyuda: false,
        abrirUpload: false,
        uploadDragover: false,         // estado visual del drop zone
        adjuntoActual: null,            // {nombre, tipo, tamanoMB, previewUrl, b64}
        adjuntosPendientes: [],         // adjuntos confirmados para la siguiente pregunta
        historialOpen: false,
        historialItems: [],
        historialCargando: false,
        historialError: "",
        historialFiltro: "activa",   // activa | archivada | todas
        historialMenuOpen: null,     // conversacionId con menu kebab abierto
        historialSeleccionadas: [],  // array de conversacionIds para batch ops
        historialModoSeleccion: false, // toggle multi-select
        // Travesia (grafo de razonamiento)
        travesiaOpen: false,
        travesiaCargando: false,
        travesiaError: "",
        travesiaData: null,        // {nodes, edges, metricas, pregunta, mensajeId}
        travesiaMermaidSvg: "",   // SVG renderizado de Mermaid
        travesiaNodoSelect: null,  // nodo clickeado para panel detalle persistente
        travesiaTipoFiltro: "",    // string: tipo de nodo activo en filtro/leyenda
        travesiaTabActiva: "grafo",  // tab activa: grafo|metricas|nodos|narrativa
        travesiaBusqueda: "",      // input de busqueda local del grafo (filtro por label)
        travesiaLayout: "pipeline", // pipeline | vertical | radial | compacto
        travesiaExpandida: false,  // drawer travesia full-screen (95vw)
        grafoConcSidebarColapsado: false,  // sidebar derecho del modal sub-grafo
        // Sub-grafo conceptual (Mejora 3: explorar concepto desde travesia)
        grafoConcOpen: false,
        grafoConcCargando: false,
        grafoConcData: null,
        grafoConcSvg: "",
        grafoConcConceptoLabel: "",
        grafoConcNodoSelect: null, // nodo clickeado para panel detalle persistente
        // Feedback (👍/👎/🤷)
        feedbackEnviado: {},      // { tempKey: 'correcta'|'parcial'|'incorrecta'|'no_se' }
        feedbackPendiente: null,  // { tempKey, veredicto } cuando esperando comentario opcional
        feedbackComentario: "",
        // Modal de confirmacion propio (reemplaza window.confirm nativo)
        confirmModal: { open: false, titulo: "", mensaje: "", etiquetaOk: "Confirmar", peligroso: false, _resolve: null },
        // Modal de detalle de nodo (reemplaza redireccion al grafo desde Resumen / Nodos)
        nodoModal: { open: false, nodo: null, contexto: "" },
        toastMsg: "",
        globalPasoActual: "",
        modeloActual: D.MODELOS[0],
        modelos: D.MODELOS,
        tools: D.TOOLS,
        sugerencias: D.SUGERENCIAS,
        _abortCtrl: null,
        _pollTimer: null,
        _cache: {},   // { hashPregunta: {ts, payload} }

        // ---------------- Init ----------------
        init() {
            this.theme = localStorage.getItem("ca:theme") || "auto";
            this.applyTheme();
            this.sidebarOpen = (localStorage.getItem("ca:sidebar") || "open") === "open";
            this.prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
            // Auto-restore draft
            const draft = localStorage.getItem("ca:draft");
            if (draft) this.prompt = draft;

            // Auto-restore conversacion en curso si existe en localStorage
            const savedConvId = localStorage.getItem("ca:convId");
            if (savedConvId) {
                this.abrirConversacion(savedConvId).catch(() => {
                    try { localStorage.removeItem("ca:convId"); } catch (e) {}
                });
            }

            // Cargar lista dinamica de modelos LLM desde aia.Model
            this.cargarModelos();

            window.matchMedia("(prefers-reduced-motion: reduce)").addEventListener("change", e => {
                this.prefersReduced = e.matches;
            });
            window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
                if (this.theme === "auto") this.applyTheme();
            });

            // Hot keys global
            document.addEventListener("keydown", (e) => {
                const inField = /INPUT|TEXTAREA/.test(document.activeElement?.tagName);
                if (e.key === "Escape") {
                    if (this.loading) { this.cancelar(); e.preventDefault(); return; }
                    if (this.drawerCita) { this.drawerCita = null; e.preventDefault(); return; }
                    if (this.grafoConcOpen) { this.cerrarGrafoConceptual(); e.preventDefault(); return; }
                    if (this.travesiaNodoSelect) { this.travesiaNodoSelect = null; e.preventDefault(); return; }
                    if (this.travesiaOpen) { this.cerrarTravesia(); e.preventDefault(); return; }
                    if (this.historialOpen) { this.historialOpen = false; e.preventDefault(); return; }
                    if (this.abrirAyuda) { this.abrirAyuda = false; e.preventDefault(); return; }
                    if (this.abrirUpload) { this.abrirUpload = false; e.preventDefault(); return; }
                    if (this.toolOverride) { this.toolOverride = null; e.preventDefault(); return; }
                }
                if (!inField && e.key === "?") {
                    this.abrirAyuda = true;
                    e.preventDefault();
                }
                if ((e.ctrlKey || e.metaKey) && e.key === "n") {
                    this.nuevaConversacion();
                    e.preventDefault();
                }
                if ((e.ctrlKey || e.metaKey) && e.key === "k") {
                    this.focusInput();
                    e.preventDefault();
                }
                if ((e.ctrlKey || e.metaKey) && e.key === "b") {
                    this.toggleSidebar();
                    e.preventDefault();
                }
                if ((e.ctrlKey || e.metaKey) && e.key === "q") {
                    this.qaMode = !this.qaMode;
                    e.preventDefault();
                }
            });
        },

        // ---------------- Adjuntos (PDF / Imagen / Audio) ----------------
        // MVP: capturar archivo, leerlo como base64, previsualizar y adjuntar a
        // la próxima pregunta. La integracion Docling/Vision/Whisper es backend.
        manejarArchivoSeleccionado(files) {
            if (!files || !files.length) return;
            this._procesarArchivo(files[0]);
        },
        manejarArchivoDrop(e) {
            const files = e.dataTransfer?.files;
            if (!files || !files.length) return;
            this._procesarArchivo(files[0]);
        },
        _procesarArchivo(file) {
            const MAX_BYTES = 20 * 1024 * 1024;
            if (file.size > MAX_BYTES) {
                this.toastFlash("Archivo excede 20 MB");
                return;
            }
            const ext = (file.name.split(".").pop() || "").toLowerCase();
            const ALLOWED = ["pdf","jpg","jpeg","png","webp","mp3","wav","m4a"];
            if (!ALLOWED.includes(ext)) {
                this.toastFlash("Tipo no soportado: ." + ext);
                return;
            }
            const isImage = ["jpg","jpeg","png","webp"].includes(ext);
            const reader = new FileReader();
            reader.onload = () => {
                const dataUrl = reader.result || "";
                const b64 = String(dataUrl).split(",")[1] || "";
                this.adjuntoActual = {
                    nombre: file.name,
                    tipo: file.type || "application/" + ext,
                    tamanoMB: file.size / (1024 * 1024),
                    previewUrl: isImage ? dataUrl : null,
                    b64,
                    ext
                };
            };
            reader.readAsDataURL(file);
        },
        confirmarAdjunto() {
            if (!this.adjuntoActual) return;
            this.adjuntosPendientes.push(this.adjuntoActual);
            const n = this.adjuntoActual.nombre;
            this.adjuntoActual = null;
            this.abrirUpload = false;
            this.toastFlash("Adjuntado: " + n);
        },
        quitarAdjuntoPendiente(idx) {
            this.adjuntosPendientes.splice(idx, 1);
        },

        // ---------------- Theme ----------------
        toggleTheme() {
            const order = ["auto", "light", "dark"];
            this.theme = order[(order.indexOf(this.theme) + 1) % order.length];
            localStorage.setItem("ca:theme", this.theme);
            this.applyTheme();
        },
        applyTheme() {
            const html = document.documentElement;
            html.dataset.theme = this.theme;
            html.classList.remove("theme-light", "theme-dark");
            if (this.theme === "auto") {
                const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
                html.classList.add(dark ? "theme-dark" : "theme-light");
            } else {
                html.classList.add("theme-" + this.theme);
            }
            // Re-render grafos vis-network: canvas no hereda CSS variables y
            // los font.color/strokeColor se decidieron al renderizar. Sin esto
            // el grafo queda con colores del tema PREVIO tras el toggle.
            this.$nextTick(() => {
                if (this._visTravesia && this.travesiaData) {
                    const c = document.getElementById("cy-travesia-container");
                    if (c) this._renderTravesiaVis(this.travesiaData, c);
                }
                if (this._visGrafoConc && this.grafoConcData) {
                    const c = document.getElementById("cy-grafo-conc-container");
                    if (c) this._renderGrafoConcVis(this.grafoConcData, c);
                }
            });
        },

        // ---------------- Sidebar ----------------
        toggleSidebar() {
            this.sidebarOpen = !this.sidebarOpen;
            localStorage.setItem("ca:sidebar", this.sidebarOpen ? "open" : "closed");
            document.documentElement.dataset.sidebar = this.sidebarOpen ? "open" : "closed";
        },

        // ---------------- Auto-save draft ----------------
        autoSaveDraft() {
            if (this._draftTimer) clearTimeout(this._draftTimer);
            this._draftTimer = setTimeout(() => {
                if (this.prompt && this.prompt.trim()) {
                    localStorage.setItem("ca:draft", this.prompt);
                } else {
                    localStorage.removeItem("ca:draft");
                }
            }, 500);
        },
        clearDraft() {
            localStorage.removeItem("ca:draft");
        },

        // ---------------- Multi-modelo ----------------
        // Carga la lista de LLMs desde IaCore.listarModelosLlm (aia.Model status=enabled).
        // Si falla, mantiene el fallback estatico de data.js (solo Mistral 14B).
        async cargarModelos() {
            try {
                const token = this.getAccessToken();
                const url = D.BASE_URL + D.ENDPOINT_MODELOS + (token ? "?access_token=" + encodeURIComponent(token) : "");
                const resp = await fetch(url, {
                    method: "POST",
                    headers: {"Content-Type": "application/json"},
                    body: "{}"
                });
                if (!resp.ok) throw new Error("HTTP " + resp.status);
                const rawText = await resp.text();
                if (rawText.includes("permission denied")) {
                    console.warn("[modelos] permission denied — fallback estatico");
                    return;
                }
                const wrapped = JSON.parse(rawText);
                const inner = Array.isArray(wrapped) ? wrapped[0] : wrapped;
                const payload = inner && inner.result !== undefined
                    ? (typeof inner.result === "string" ? JSON.parse(inner.result) : inner.result)
                    : inner;
                if (!payload || !Array.isArray(payload.modelos) || payload.modelos.length === 0) {
                    console.warn("[modelos] respuesta vacia, manteniendo fallback");
                    return;
                }
                this.modelos = payload.modelos;
                const def = payload.default_id;
                const actualPersistido = parseInt(localStorage.getItem("ca:modeloId") || "0", 10);
                const elegido = (actualPersistido && payload.modelos.find(m => m.id === actualPersistido))
                    || payload.modelos.find(m => m.id === def)
                    || payload.modelos[0];
                this.modeloActual = elegido;
            } catch (err) {
                console.warn("[modelos] error fetch:", err.message || err);
            }
        },

        elegirModelo(m) {
            this.modeloActual = m;
            try { localStorage.setItem("ca:modeloId", String(m.id)); } catch (e) {}
            this.toastFlash("Modelo: " + m.label);
        },

        // ---------------- Auth ----------------
        // PRIORIDAD: parent.localStorage['airflows_v2_access_token'] — Airflows lo
        // refresca automaticamente via su refresh_token cuando la sesion sigue activa.
        // Asi la SPA externa NUNCA pierde la sesion mientras el admin Airflows este vivo.
        // Fallback: querystring del URL (solo al primer load), luego scan localStorage propio.
        getAccessToken() {
            // 1) Token fresco desde el parent Airflows (mismo origin)
            try {
                if (window.parent && window.parent !== window && window.parent.localStorage) {
                    const t = window.parent.localStorage.getItem("airflows_v2_access_token");
                    if (t && t.length > 100) return t;
                }
            } catch (e) { /* cross-origin guard */ }
            // 2) Mismo localStorage por si Airflows escribio aqui
            try {
                const t = localStorage.getItem("airflows_v2_access_token");
                if (t && t.length > 100) return t;
            } catch (e) {}
            // 3) Querystring (load inicial)
            const qs = new URLSearchParams(window.location.search);
            const tok = qs.get("access_token");
            if (tok) return tok;
            // 4) Scan ultimo recurso
            for (const k of Object.keys(localStorage)) {
                const v = localStorage.getItem(k);
                if (v && v.length > 100 && v.length < 4000 && /^ey/.test(v)) return v;
            }
            return "";
        },

        // Intenta forzar refresh del token via Airflows GraphQL. El admin parent
        // ya tiene su refresh_token cookie HTTP-only; la mutation devuelve el nuevo
        // access_token y Airflows actualiza el localStorage del parent automaticamente.
        async _refrescarToken() {
            try {
                // Llamar al endpoint que Airflows expone para refresh. Si el admin
                // esta logueado el refresh cookie viaja con `credentials: include`.
                const r = await fetch(D.BASE_URL + "/graphql", {
                    method: "POST",
                    headers: {"Content-Type": "application/json"},
                    credentials: "include",
                    body: JSON.stringify({
                        query: "mutation { refresh { accessToken } }"
                    })
                });
                const j = await r.json().catch(() => null);
                const nuevo = j && j.data && j.data.refresh && j.data.refresh.accessToken;
                if (nuevo) {
                    try {
                        if (window.parent && window.parent.localStorage) {
                            window.parent.localStorage.setItem("airflows_v2_access_token", nuevo);
                        }
                        localStorage.setItem("airflows_v2_access_token", nuevo);
                    } catch (e) {}
                    return nuevo;
                }
            } catch (e) {}
            return null;
        },

        // Wrapper de fetch que reintenta UNA VEZ si recibe 401 SessionTimeout,
        // intentando antes refrescar el token desde el parent.
        async _fetchAuth(url, opts, intentos) {
            const max = (typeof intentos === "number") ? intentos : 1;
            const resp = await fetch(url, opts);
            if (resp.status === 401 && max > 0) {
                // Intentar refresh y reintentar la llamada original con el nuevo token
                const nuevo = await this._refrescarToken();
                if (nuevo) {
                    const newUrl = url.replace(/access_token=[^&]+/, "access_token=" + encodeURIComponent(nuevo));
                    return this._fetchAuth(newUrl, opts, 0);
                }
            }
            return resp;
        },

        // ---------------- Endpoints ----------------
        async callOrquestador(pregunta, conversacionId, toolForzada, signal) {
            const token = this.getAccessToken();
            const url = D.BASE_URL + D.ENDPOINT_INVOCAR + (token ? "?access_token=" + encodeURIComponent(token) : "");
            const body = {
                p_pregunta: pregunta,
                p_conversacion_id: conversacionId || null,
                p_tool_forzada: toolForzada || null,
                p_agente_nombre: "BrainVtHidrocarburosAgent",
                p_modelo: (this.modeloActual && this.modeloActual.name) || null,
            };
            const t0 = performance.now();
            const resp = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json", "Accept": "application/json" },
                body: JSON.stringify(body),
                signal: signal,
            });
            if (!resp.ok) {
                const txt = await resp.text();
                throw new Error("HTTP " + resp.status + ": " + (txt || resp.statusText).substring(0, 240));
            }
            const rawTextOrq = await resp.text();
            if (rawTextOrq.includes("permission denied") || rawTextOrq.includes("InsufficientPrivilege")) {
                this._handleAuthExpired();
                throw new Error("AUTH_EXPIRED");
            }
            const wrapped = JSON.parse(rawTextOrq);
            const inner = Array.isArray(wrapped) ? wrapped[0] : wrapped;
            let payload = null;
            if (inner && inner.result !== undefined) {
                const val = inner.result;
                if (typeof val === "string") {
                    try { payload = JSON.parse(val); } catch (e) { payload = { respuesta: val }; }
                } else if (val && typeof val === "object" && "value" in val) {
                    const v2 = val.value;
                    payload = (typeof v2 === "string") ? JSON.parse(v2) : v2;
                } else {
                    payload = val;
                }
            } else if (typeof inner === "string") {
                try { payload = JSON.parse(inner); } catch (e) { payload = { respuesta: inner }; }
            } else {
                payload = inner;
            }
            if (!payload || typeof payload !== "object") {
                payload = { respuesta: String(payload || "") };
            }
            payload._wallMs = Math.round(performance.now() - t0);
            return payload;
        },

        async pollUltimoTurno(conversacionId, abortSignal) {
            const token = this.getAccessToken();
            const url = D.BASE_URL + D.ENDPOINT_CONSULTAR + (token ? "?access_token=" + encodeURIComponent(token) : "");
            // Timeout duro local: si el gateway tarda mas de POLL_TIMEOUT_MS,
            // abortar este poll y dejar que el siguiente lo intente. Sin esto,
            // saturamos al gateway con requests pendientes (el gateway HTTP de
            // Airflows serializa internamente y cada request puede demorar 15-19s
            // si hay otra corriendo, asi que no podemos depender solo del intervalo).
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), POLL_TIMEOUT_MS);
            // Permitir que un abortSignal externo (cancelar) tambien lo interrumpa
            if (abortSignal) abortSignal.addEventListener("abort", () => ctrl.abort());
            try {
                const resp = await fetch(url, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ p_conversacion_id: conversacionId }),
                    signal: ctrl.signal
                });
                if (!resp.ok) return null;
                const rawText = await resp.text();
                if (rawText.includes("permission denied") || rawText.includes("InsufficientPrivilege")) {
                    this._handleAuthExpired();
                    return null;
                }
                let wrapped = null;
                try { wrapped = JSON.parse(rawText); } catch (e) { return null; }
                const inner = Array.isArray(wrapped) ? wrapped[0] : wrapped;
                let payload = null;
                if (inner && inner.result !== undefined) {
                    const val = inner.result;
                    payload = (typeof val === "string") ? JSON.parse(val) : val;
                } else if (typeof inner === "string") {
                    payload = JSON.parse(inner);
                } else payload = inner;
                return payload;
            } catch (e) {
                return null;
            } finally {
                clearTimeout(timer);
            }
        },

        _handleAuthExpired() {
            if (this._authExpiredHandled) return;
            this._authExpiredHandled = true;
            this.toastFlash("Sesion expirada, recargando…");
            this.loading = false;
            this.globalPasoActual = "";
            this._pollLoopActive = false;
            if (this._pollAbortCtrl) { try { this._pollAbortCtrl.abort(); } catch (e) {} this._pollAbortCtrl = null; }
            this._pollTimer = null;
            if (this._abortCtrl) { try { this._abortCtrl.abort(); } catch (e) {} }
            // Reload re-emite JWT desde Airflows (URL del menu lleva ?access_token=
            // que Airflows reescribe con un JWT fresco en cada navegacion).
            setTimeout(() => location.reload(), 1500);
        },

        // ---------------- Cache local ----------------
        _cacheKey(pregunta, toolForzada, modeloId) {
            return (pregunta || "").trim().toLowerCase() + "|" + (toolForzada || "") + "|" + modeloId;
        },
        _cacheGet(key) {
            const e = this._cache[key];
            if (!e) return null;
            if (Date.now() - e.ts > RESPONSE_CACHE_TTL_MS) { delete this._cache[key]; return null; }
            return e.payload;
        },
        _cachePut(key, payload) {
            this._cache[key] = { ts: Date.now(), payload };
        },

        // ---------------- Acción enviar ----------------
        async enviar(forceTool, _preguntaOverride) {
            const pregunta = (_preguntaOverride !== undefined ? _preguntaOverride : this.prompt || "").trim();
            if (!pregunta || this.loading) return;
            const usedTool = (forceTool !== undefined) ? forceTool : this.toolOverride;
            this.lastError = "";

            // Cache local (solo si no hay forceTool y no hay historial reciente)
            const ckey = this._cacheKey(pregunta, usedTool, this.modeloActual.id);
            const cached = this._cacheGet(ckey);
            if (cached && this.turnos.length === 0) {
                this._appendCachedTurno(pregunta, cached);
                this.toastFlash("Cache hit (5 min)");
                return;
            }

            this.loading = true;
            this.globalPasoActual = "Conectando con el agente…";

            // Si no hay conversacion_id aún, generamos uno cliente-side
            if (!this.conversacionId) {
                this.conversacionId = this._uuid();
            }
            const convIdForThis = this.conversacionId;
            // Persist convId para sobrevivir reload (auto-restore en init)
            try { localStorage.setItem("ca:convId", convIdForThis); } catch (e) {}

            // Optimistic: agregar turno con _pending=true
            const tempIdx = this.turnos.length;
            const tempKey = "tmp-" + Date.now();
            this.turnos.push({
                tempKey,
                turnoId: null,
                turnoOrden: tempIdx + 1,
                pregunta,
                respuesta: "",
                bloques: [],
                telemetria: null,
                citaciones: [],
                toolInvocada: null,
                toolArgs: null,
                toolForzada: !!usedTool,
                _pending: true,
                _pasoActual: "Conectando con el agente…",
                _progresoPasos: [],
                _elapsedSec: 0,
                _startTs: Date.now(),
            });
            this.prompt = "";
            this.clearDraft();
            this.$nextTick(() => this.scrollToBottom());

            // Polling de progreso — loop secuencial (NO setInterval), para no
            // amontonar requests si el gateway tarda. Cada tick: hacer poll con
            // timeout local 8s; si llega antes, esperar gap mínimo POLL_INTERVAL_MS
            // antes de iniciar el siguiente. Si el turno deja de estar pending
            // (corrida terminó), el loop se detiene solo.
            this._pollAbortCtrl = new AbortController();
            const pollAbortSignal = this._pollAbortCtrl.signal;
            this._pollLoopActive = true;
            // Backoff exponencial: 1.5s → 2.5s → 4s → 6s → 8s max
            // Reduce ~60% el ruido de llamadas en el network panel durante turnos largos
            const POLL_DELAYS = [1500, 1500, 2500, 2500, 4000, 4000, 6000, 8000];
            const pollLoop = async () => {
                let attempt = 0;
                while (this._pollLoopActive && !pollAbortSignal.aborted) {
                    const prog = await this.pollUltimoTurno(convIdForThis, pollAbortSignal);
                    if (pollAbortSignal.aborted) break;
                    const t = this.turnos[tempIdx];
                    if (!t || !t._pending) break;
                    if (prog && prog.estado !== "NO_ENCONTRADO") {
                        const rawPaso = prog.pasoActual || t._pasoActual;
                        const slug = (rawPaso || "").toLowerCase().replace(/[\s-]+/g, "_");
                        t._pasoActual = D.FASE_LABELS[slug] || rawPaso;
                        if (Array.isArray(prog.progresoPasos)) {
                            t._progresoPasos = prog.progresoPasos.map(p => {
                                const faseSlug = (p.fase || "").toLowerCase().replace(/[\s-]+/g, "_");
                                return {
                                    fase: p.fase,
                                    msg: p.msg || D.FASE_LABELS[faseSlug] || p.fase,
                                    icon: D.FASE_ICONS[faseSlug] || "ico-clock"
                                };
                            });
                        }
                        t._elapsedSec = Math.round((Date.now() - t._startTs) / 1000);
                        this.globalPasoActual = t._pasoActual;
                        this.scrollToBottom();
                        if (prog.estado === "COMPLETADO" || prog.estado === "ERROR") break;
                    }
                    const delay = POLL_DELAYS[Math.min(attempt, POLL_DELAYS.length - 1)];
                    attempt++;
                    await new Promise(r => setTimeout(r, delay));
                }
            };
            pollLoop();
            // Mantener el atributo `_pollTimer` para que cancelar() siga funcionando
            this._pollTimer = "loop-active";

            // Llamada principal
            this._abortCtrl = new AbortController();
            try {
                const payload = await this.callOrquestador(pregunta, convIdForThis, usedTool, this._abortCtrl.signal);
                if (payload.conversacionId) this.conversacionId = payload.conversacionId;
                const respuesta = payload.respuesta || "";
                const bloques = this.parseRespuestaABloques(respuesta);
                this.turnos.splice(tempIdx, 1, {
                    tempKey,
                    // turnoId = IaCore.Mensajes.id del ASSISTANT (lo que armarTravesia/detallar/feedback necesitan)
                    turnoId: payload.iacoreAssistantMsgId || payload.turnoId,
                    aiaTurnoId: payload.turnoId,  // legacy id de aia.ConversacionTurno (para auditoria)
                    iacoreUserMsgId: payload.iacoreUserMsgId,
                    iacoreConvId: payload.iacoreConvId,
                    turnoOrden: payload.turnoOrden || (tempIdx + 1),
                    pregunta,
                    respuesta,
                    bloques,
                    telemetria: payload.telemetria || null,
                    citaciones: payload.citaciones || [],
                    toolInvocada: payload.toolInvocada || null,
                    toolArgs: payload.toolArgs || null,
                    toolsInvocadas: payload.toolsInvocadas || [],
                    toolForzada: payload.toolForzada || false,
                    _pending: false,
                });
                this.ultimaLatenciaMs = (payload.telemetria && payload.telemetria.msTotal) || payload._wallMs;
                this._cachePut(ckey, payload);
            } catch (err) {
                if (err.name === "AbortError") {
                    this.lastError = "Request cancelado.";
                } else {
                    this.lastError = err.message || String(err);
                }
                this.turnos.splice(tempIdx, 1);
            } finally {
                this.loading = false;
                this.globalPasoActual = "";
                this._pollLoopActive = false;
                if (this._pollAbortCtrl) { try { this._pollAbortCtrl.abort(); } catch (e) {} this._pollAbortCtrl = null; }
                this._pollTimer = null;
                this._abortCtrl = null;
                this.$nextTick(() => this.scrollToBottom());
            }
        },

        cancelar() {
            if (this._abortCtrl) {
                try { this._abortCtrl.abort(); } catch (e) {}
            }
            this._pollLoopActive = false;
            if (this._pollAbortCtrl) { try { this._pollAbortCtrl.abort(); } catch (e) {} this._pollAbortCtrl = null; }
            this._pollTimer = null;
        },

        nuevaConversacion() {
            if (this.loading) this.cancelar();
            this.conversacionId = null;
            this.turnos = [];
            this.lastError = "";
            this.drawerCita = null;
            this.ultimaLatenciaMs = 0;
            this.prompt = "";
            this.clearDraft();
            try { localStorage.removeItem("ca:convId"); } catch (e) {}
            this.$nextTick(() => this.focusInput());
        },

        // ---------------- Historial de conversaciones ----------------
        async toggleHistorial() {
            this.historialOpen = !this.historialOpen;
            if (this.historialOpen) await this.cargarHistorial();
        },

        async cargarHistorial() {
            this.historialCargando = true;
            this.historialError = "";
            try {
                const token = this.getAccessToken();
                const url = D.BASE_URL + D.ENDPOINT_LISTAR + (token ? "?access_token=" + encodeURIComponent(token) : "");
                const resp = await fetch(url, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ p_limit: "50", p_offset: "0", p_filtro_estado: this.historialFiltro })
                });
                if (!resp.ok) throw new Error("HTTP " + resp.status);
                const rawText = await resp.text();
                if (rawText.includes("permission denied") || rawText.includes("InsufficientPrivilege")) {
                    this._handleAuthExpired();
                    return;
                }
                const wrapped = JSON.parse(rawText);
                const inner = Array.isArray(wrapped) ? wrapped[0] : wrapped;
                let payload = null;
                if (inner && inner.result !== undefined) {
                    const val = inner.result;
                    payload = (typeof val === "string") ? JSON.parse(val) : val;
                } else payload = inner;
                if (payload && payload.motivo === "no_user") {
                    this.historialItems = [];
                    this.historialError = "Sesión expirada. Recarga la pestaña.";
                    return;
                }
                this.historialItems = (payload && payload.items) || [];
            } catch (err) {
                this.historialError = err.message || String(err);
                this.historialItems = [];
            } finally {
                this.historialCargando = false;
            }
        },

        // Operaciones de historial (archivar / eliminar / desarchivar)
        // Wrapper: en lugar de funciones HTTP nuevas (Airflows cachea agresivo y
        // no expone funciones recien creadas sin sync DSL completo), usamos
        // listarConversaciones con p_op + p_op_uuids — una sola llamada que ejecuta
        // la operacion Y retorna el listado actualizado.
        async _aplicarOperacionConv(endpointVacio, convId, mensajeOk) {
            this.historialMenuOpen = null;
            // endpointVacio queda como compatibilidad; el endpoint real es listarConversaciones
            const op = endpointVacio === D.ENDPOINT_ARCHIVAR ? "archivar"
                : endpointVacio === D.ENDPOINT_ELIMINAR ? "eliminar"
                : endpointVacio === D.ENDPOINT_DESARCHIVAR ? "desarchivar" : null;
            if (!op) return false;
            try {
                const token = this.getAccessToken();
                const url = D.BASE_URL + D.ENDPOINT_LISTAR + (token ? "?access_token=" + encodeURIComponent(token) : "");
                const resp = await fetch(url, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        p_limit: "50",
                        p_offset: "0",
                        p_filtro_estado: this.historialFiltro,
                        p_op: op,
                        p_op_uuids: convId
                    })
                });
                const txt = await resp.text();
                if (!resp.ok || txt.includes("permission denied")) {
                    this.toastFlash("Error: " + (resp.status || "permission"));
                    return false;
                }
                // Refresh historial desde la respuesta directa (evita doble fetch)
                try {
                    const wrapped = JSON.parse(txt);
                    const inner = Array.isArray(wrapped) ? wrapped[0] : wrapped;
                    const payload = inner && inner.result !== undefined
                        ? (typeof inner.result === "string" ? JSON.parse(inner.result) : inner.result)
                        : inner;
                    if (payload && payload.items) {
                        this.historialItems = payload.items;
                    }
                } catch (e) {}
                this.toastFlash(mensajeOk);
                if (this.conversacionId === convId) {
                    this.conversacionId = null;
                    this.turnos = [];
                    try { localStorage.removeItem("ca:convId"); } catch (e) {}
                }
                return true;
            } catch (err) {
                this.toastFlash("Error: " + (err.message || err));
                return false;
            }
        },
        archivarConversacion(convId) {
            return this._aplicarOperacionConv(D.ENDPOINT_ARCHIVAR, convId, "Conversación archivada");
        },
        desarchivarConversacion(convId) {
            return this._aplicarOperacionConv(D.ENDPOINT_DESARCHIVAR, convId, "Conversación restaurada");
        },
        async eliminarConversacion(convId, titulo) {
            const t = (titulo || convId.substring(0, 8)).substring(0, 60);
            const ok = await this.confirmar({
                titulo: "Eliminar conversación",
                mensaje: "Vas a eliminar permanentemente «" + t + "». La conversación se marca como ELIMINADA (soft-delete, solo recuperable en BD).",
                etiquetaOk: "Eliminar",
                peligroso: true
            });
            if (!ok) {
                this.historialMenuOpen = null;
                return false;
            }
            return this._aplicarOperacionConv(D.ENDPOINT_ELIMINAR, convId, "Conversación eliminada");
        },
        // Modal de confirmacion propio (reemplaza window.confirm nativo).
        // Devuelve Promise<boolean> — true si el usuario confirma.
        confirmar({ titulo, mensaje, etiquetaOk, peligroso } = {}) {
            return new Promise((resolve) => {
                this.confirmModal = {
                    open: true,
                    titulo: titulo || "Confirmar acción",
                    mensaje: mensaje || "",
                    etiquetaOk: etiquetaOk || "Confirmar",
                    peligroso: !!peligroso,
                    _resolve: resolve
                };
            });
        },
        confirmarOk() {
            const r = this.confirmModal._resolve;
            this.confirmModal = { open: false, titulo: "", mensaje: "", etiquetaOk: "Confirmar", peligroso: false, _resolve: null };
            if (typeof r === "function") r(true);
        },
        confirmarCancel() {
            const r = this.confirmModal._resolve;
            this.confirmModal = { open: false, titulo: "", mensaje: "", etiquetaOk: "Confirmar", peligroso: false, _resolve: null };
            if (typeof r === "function") r(false);
        },
        // Modal de detalle de nodo (reemplaza redireccion a tab grafo desde Resumen / Nodos)
        abrirDetalleNodo(nodo, contexto) {
            if (!nodo) return;
            this.nodoModal = { open: true, nodo, contexto: contexto || "" };
        },
        cerrarDetalleNodo() {
            this.nodoModal = { open: false, nodo: null, contexto: "" };
        },
        // Markdown helper — usado en modales/descripciones largas
        _renderMarkdownInline(text) {
            if (!text) return "";
            try {
                if (typeof marked === "function" || (window.marked && window.marked.parse)) {
                    const html = (window.marked && window.marked.parse)
                        ? window.marked.parse(String(text))
                        : marked(String(text));
                    return (window.DOMPurify && window.DOMPurify.sanitize)
                        ? window.DOMPurify.sanitize(html)
                        : html;
                }
            } catch (e) {}
            // Fallback: escapar HTML
            return String(text).replace(/[<>&"]/g, c => ({"<":"&lt;",">":"&gt;","&":"&amp;",'"':"&quot;"}[c]));
        },
        cambiarFiltroHistorial(filtro) {
            if (filtro === this.historialFiltro) return;
            this.historialFiltro = filtro;
            this.historialSeleccionadas = []; // limpiar selección al cambiar filtro
            this.cargarHistorial();
        },
        toggleMenuConv(convId, e) {
            if (e) e.stopPropagation();
            this.historialMenuOpen = (this.historialMenuOpen === convId) ? null : convId;
        },

        // ---------------- Multi-select historial ----------------
        toggleModoSeleccion() {
            this.historialModoSeleccion = !this.historialModoSeleccion;
            this.historialSeleccionadas = [];
        },
        toggleSeleccionConv(convId) {
            const idx = this.historialSeleccionadas.indexOf(convId);
            if (idx === -1) {
                this.historialSeleccionadas = [...this.historialSeleccionadas, convId];
            } else {
                this.historialSeleccionadas = this.historialSeleccionadas.filter(x => x !== convId);
            }
        },
        seleccionarTodas() {
            this.historialSeleccionadas = this.historialItems.map(it => it.conversacionId);
        },
        limpiarSeleccion() {
            this.historialSeleccionadas = [];
        },
        // Batch en UNA sola llamada via p_op_uuids con CSV de uuids
        async _batchOp(op, mensajeOk, confirmMsg) {
            if (!this.historialSeleccionadas.length) return;
            const n = this.historialSeleccionadas.length;
            if (confirmMsg) {
                const ok = await this.confirmar({
                    titulo: op === "eliminar" ? "Eliminar conversaciones" : "Confirmar acción",
                    mensaje: confirmMsg.replace("{n}", n),
                    etiquetaOk: op === "eliminar" ? "Eliminar" : "Confirmar",
                    peligroso: op === "eliminar"
                });
                if (!ok) return;
            }
            try {
                const token = this.getAccessToken();
                const url = D.BASE_URL + D.ENDPOINT_LISTAR + (token ? "?access_token=" + encodeURIComponent(token) : "");
                const resp = await fetch(url, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        p_limit: "50", p_offset: "0",
                        p_filtro_estado: this.historialFiltro,
                        p_op: op,
                        p_op_uuids: this.historialSeleccionadas.join(",")
                    })
                });
                const txt = await resp.text();
                if (!resp.ok) {
                    this.toastFlash("Error batch: HTTP " + resp.status);
                    return;
                }
                let filas = 0;
                try {
                    const w = JSON.parse(txt);
                    const inner = Array.isArray(w) ? w[0] : w;
                    const p = inner.result ? (typeof inner.result==="string" ? JSON.parse(inner.result) : inner.result) : inner;
                    filas = p?.op_result?.filas || 0;
                    if (p?.items) this.historialItems = p.items;
                } catch (e) {}
                this.toastFlash(`${filas || n} ${mensajeOk}`);
                // Limpiar conversacion actual si quedo afectada
                if (this.historialSeleccionadas.includes(this.conversacionId)) {
                    this.conversacionId = null;
                    this.turnos = [];
                    try { localStorage.removeItem("ca:convId"); } catch (e) {}
                }
                this.historialSeleccionadas = [];
                this.historialModoSeleccion = false;
            } catch (err) {
                this.toastFlash("Error: " + (err.message || err));
            }
        },
        async archivarSeleccionadas() {
            return this._batchOp("archivar", "archivadas",
                "¿Archivar {n} conversación(es)?\nLas archivadas se pueden restaurar luego.");
        },
        async desarchivarSeleccionadas() {
            return this._batchOp("desarchivar", "restauradas", null);
        },
        async eliminarSeleccionadasPermanente() {
            return this._batchOp("eliminar", "eliminadas permanente",
                "⚠️ ¿ELIMINAR PERMANENTEMENTE {n} conversación(es) archivada(s)?\n\nQuedarán marcadas como ELIMINADAS (soft-delete BD). Esta acción solo procede en conversaciones ya archivadas.");
        },
        async _aplicarOperacionConvSilent(endpoint, convId) {
            const op = endpoint === D.ENDPOINT_ARCHIVAR ? "archivar"
                : endpoint === D.ENDPOINT_ELIMINAR ? "eliminar"
                : endpoint === D.ENDPOINT_DESARCHIVAR ? "desarchivar" : null;
            if (!op) return false;
            try {
                const token = this.getAccessToken();
                const url = D.BASE_URL + D.ENDPOINT_LISTAR + (token ? "?access_token=" + encodeURIComponent(token) : "");
                const resp = await fetch(url, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        p_limit: "50", p_offset: "0",
                        p_filtro_estado: this.historialFiltro,
                        p_op: op, p_op_uuids: convId
                    })
                });
                const txt = await resp.text();
                if (!resp.ok || txt.includes("permission denied")) return false;
                if (this.conversacionId === convId) {
                    this.conversacionId = null;
                    this.turnos = [];
                    try { localStorage.removeItem("ca:convId"); } catch (e) {}
                }
                return true;
            } catch (err) {
                return false;
            }
        },

        async abrirConversacion(convId) {
            if (!convId || this.loading) return;
            this.lastError = "";
            try {
                const token = this.getAccessToken();
                const url = D.BASE_URL + D.ENDPOINT_CARGAR + (token ? "?access_token=" + encodeURIComponent(token) : "");
                const resp = await fetch(url, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ p_conversacion_id: convId })
                });
                if (!resp.ok) throw new Error("HTTP " + resp.status);
                const rawText = await resp.text();
                if (rawText.includes("permission denied") || rawText.includes("InsufficientPrivilege")) {
                    this._handleAuthExpired();
                    return;
                }
                const wrapped = JSON.parse(rawText);
                const inner = Array.isArray(wrapped) ? wrapped[0] : wrapped;
                let payload = null;
                if (inner && inner.result !== undefined) {
                    const val = inner.result;
                    payload = (typeof val === "string") ? JSON.parse(val) : val;
                } else payload = inner;
                if (!payload || payload.motivo !== "ok") {
                    this.toastFlash("No se pudo abrir esa conversación (" + ((payload && payload.motivo) || "?") + ")");
                    return;
                }
                // Reconstruir array de turnos
                this.conversacionId = payload.conversacionId;
                try { localStorage.setItem("ca:convId", this.conversacionId); } catch (e) {}
                this.turnos = (payload.items || []).map(it => {
                    const respuesta = it.respuesta || "";
                    const bloques = this.parseRespuestaABloques(respuesta);
                    let citaciones = [];
                    if (it.citaciones) {
                        try { citaciones = JSON.parse(it.citaciones); } catch (e) { citaciones = []; }
                    }
                    let toolArgs = null;
                    if (it.toolArgs) {
                        try { toolArgs = JSON.parse(it.toolArgs); } catch (e) { toolArgs = it.toolArgs; }
                    }
                    return {
                        tempKey: "hist-" + it.turnoId,
                        turnoId: it.turnoId,
                        turnoOrden: it.turnoOrden,
                        pregunta: it.pregunta,
                        respuesta,
                        bloques,
                        telemetria: {
                            msTotal: it.msTotal,
                            msLlmTurn1: it.msLlmTurn1,
                            msTool: it.msTool,
                            msLlmTurn2: it.msLlmTurn2,
                            tokensPrompt: it.tokensPrompt,
                            tokensCompletion: it.tokensCompletion
                        },
                        citaciones,
                        toolInvocada: it.toolInvocada,
                        toolArgs,
                        toolForzada: !!it.toolForzada,
                        _pending: false,
                    };
                });
                this.historialOpen = false;
                this.$nextTick(() => this.scrollToBottom());
            } catch (err) {
                this.toastFlash("Error abriendo conversación: " + (err.message || err));
            }
        },

        // ---------------- Travesia (grafo de razonamiento) ----------------
        async verTravesia(turno) {
            if (!turno || !turno.turnoId) {
                this.toastFlash("Esta respuesta no tiene mensajeId persistido (turno previo a la migracion)");
                return;
            }
            this.travesiaOpen = true;
            this.travesiaCargando = true;
            this.travesiaError = "";
            this.travesiaData = null;
            this.travesiaMermaidSvg = "";
            try {
                const token = this.getAccessToken();
                const url = D.BASE_URL + D.ENDPOINT_TRAVESIA + (token ? "?access_token=" + encodeURIComponent(token) : "");
                const resp = await fetch(url, {
                    method: "POST",
                    headers: {"Content-Type": "application/json"},
                    body: JSON.stringify({p_assistant_msg_id: String(turno.turnoId)})
                });
                if (!resp.ok) throw new Error("HTTP " + resp.status);
                const rawText = await resp.text();
                if (rawText.includes("permission denied") || rawText.includes("InsufficientPrivilege")) {
                    this._handleAuthExpired();
                    return;
                }
                const wrapped = JSON.parse(rawText);
                const inner = Array.isArray(wrapped) ? wrapped[0] : wrapped;
                let payload = null;
                if (inner && inner.result !== undefined) {
                    const val = inner.result;
                    payload = (typeof val === "string") ? JSON.parse(val) : val;
                } else payload = inner;
                if (!payload || payload.motivo !== "ok") {
                    this.travesiaError = "Travesía no disponible (" + ((payload && payload.motivo) || "?") + ")";
                    return;
                }
                this.travesiaData = payload;
                // Render se dispara después de que el DOM tenga el container.
                this.$nextTick(() => {
                    const c = document.getElementById("cy-travesia-container");
                    if (c) this._renderTravesiaVis(payload, c);
                });
            } catch (err) {
                this.travesiaError = err.message || String(err);
            } finally {
                this.travesiaCargando = false;
            }
        },

        // Helper: detectar tema oscuro activo. vis-network renderea en canvas y
        // no hereda CSS variables — los colores se pasan explicitos.
        _temaEsOscuro() {
            return document.documentElement.classList.contains("theme-dark");
        },

        // Esconder el tooltip nativo de vis-network — usado al click para evitar
        // que el tooltip se solape con el panel detalle persistente.
        _ocultarTooltipVis() {
            document.querySelectorAll(".vis-tooltip").forEach(el => {
                el.style.visibility = "hidden";
            });
        },

        // Metadatos enriquecidos de una tool (level + tooltip + desc del catalogo)
        _toolMeta(name) {
            const t = (D.TOOLS || []).find(x => x.name === name);
            return t || null;
        },

        // Etiqueta humana por tipo (usado en tooltip + panel + leyenda)
        _typeLabel(tipo) {
            return ({
                input: "Pregunta",
                concept: "Concepto",
                concept_related: "Concepto vecino",
                concept_root: "Concepto raíz",
                glosario: "Entidad glosario",
                tesauro: "Término tesauro",
                tool: "Herramienta",
                doc: "Documento",
                output: "Respuesta"
            }[tipo] || (tipo || "—"));
        },

        // Construye un DOM Element rico para usar como `title:` de un nodo en
        // vis-network. Replica la estetica del ontology-viewer (strong + desc +
        // meta chips). vis-network respeta HTMLElement como tooltip.
        _buildTooltipNode(n) {
            const el = document.createElement("div");
            el.className = "graph-tooltip";

            const strong = document.createElement("strong");
            strong.textContent = n.label || n.id;
            el.appendChild(strong);

            const tipoEl = document.createElement("em");
            tipoEl.textContent = this._typeLabel(n.type);
            el.appendChild(tipoEl);

            const desc = (n.descripcion || n.tooltip || "").trim();
            if (desc && desc !== n.label) {
                const d = document.createElement("div");
                d.className = "graph-tooltip__desc";
                d.textContent = desc.slice(0, 280);
                el.appendChild(d);
            }

            const meta = document.createElement("div");
            meta.className = "graph-tooltip__meta";
            const chips = [];
            if (typeof n.confianza === "number") chips.push(["confianza", (n.confianza * 100).toFixed(0) + "%"]);
            if (typeof n.score === "number") chips.push(["score", n.score.toFixed(2)]);
            if (n.docId) chips.push(["doc id", n.docId]);
            if (n.iter) chips.push(["iter", n.iter]);
            if (n.uri) chips.push(["uri", String(n.uri).split("/").pop().slice(0, 30)]);
            if (n.ruta) chips.push(["ruta", String(n.ruta).split(/[\\/]/).pop().slice(0, 30)]);
            for (const [k, v] of chips) {
                const chip = document.createElement("span");
                chip.className = "graph-tooltip__chip";
                chip.innerHTML = "<small>" + k + "</small> " + String(v);
                meta.appendChild(chip);
            }
            if (chips.length) el.appendChild(meta);

            // Pista de interaccion
            const hint = document.createElement("div");
            hint.className = "graph-tooltip__hint";
            const tipo = n.type;
            if (tipo === "concept" || tipo === "concept_related") {
                hint.textContent = "Click → drill-down al sub-grafo";
            } else if (tipo === "doc") {
                hint.textContent = "Click → detalle persistente del documento";
            } else {
                hint.textContent = "Click → detalle persistente";
            }
            el.appendChild(hint);

            return el;
        },

        // Aplica dimming a nodos+edges fuera del 1-hop del foco (estilo
        // ontology-viewer). Llamado desde hoverNode; revertido en blurNode.
        _aplicarHoverDimming(network, allNodes, allEdges, focusId, on) {
            if (!network) return;
            if (!on) {
                // Restaurar opacity al 1.0 en todos
                allNodes.forEach(n => network.body.data.nodes.update({ id: n.id, opacity: 1.0 }));
                allEdges.forEach(e => network.body.data.edges.update({ id: e.id, color: e._origColor }));
                return;
            }
            const vecinos = new Set([focusId]);
            allEdges.forEach(e => {
                if (e.from === focusId) vecinos.add(e.to);
                if (e.to === focusId) vecinos.add(e.from);
            });
            allNodes.forEach(n => {
                network.body.data.nodes.update({
                    id: n.id, opacity: vecinos.has(n.id) ? 1.0 : 0.18
                });
            });
            allEdges.forEach(e => {
                const isPart = e.from === focusId || e.to === focusId;
                if (!e._origColor) e._origColor = e.color;
                network.body.data.edges.update({
                    id: e.id,
                    color: isPart
                        ? { color: "#FFD700", highlight: "#FFD700" }
                        : { color: this._temaEsOscuro() ? "#1f2937" : "#cbd5e1", opacity: 0.4 }
                });
            });
        },

        async _renderTravesiaVis(travesia, containerEl) {
            // vis-network con paleta corporativa del ontology-viewer (teal #00838F).
            // Layout hierarchical LR: pregunta → conceptos → glosario/tesauro → tools → docs → respuesta.
            if (typeof vis === "undefined" || !vis.Network) {
                this.travesiaError = "vis-network no cargado";
                return;
            }
            const isDark = this._temaEsOscuro();
            const fontNodo = isDark ? "#f8fafc" : "#0f172a";   // ratio AA contra canvas
            const fontEdge = isDark ? "#e2e8f0" : "#334155";
            const strokeCol = isDark ? "#0f172a" : "#ffffff";  // halo opuesto
            const edgeColor = isDark ? "#64748b" : "#94a3b8";

            // PALETA McKINSEY-STYLE — 2026-05-10 v5:
            // Diseño consultoría premium: minimalismo, neutralidad cromática, jerarquia por borde.
            // Background: SIEMPRE blanco (light) / navy slate (dark) — sin "tarjetas de colores".
            // Diferenciación: SOLO en el borde + un dot de acento (4px) en banda lateral via CSS.
            // Tipografía: navy oscuro (light) / blanco (dark) — texto siempre legible.
            // Bordes 2.5px en color corporativo del tipo (saturado pero no chillón).
            // Cero sombras pesadas — máximo `rgba(0,0,0,0.05) y:1`.
            const TYPE_STYLE = isDark ? {
                input:           { bg: "#0f172a", border: "#5ec5e5", level: 0, fontColor: "#f8fafc" },
                concept:         { bg: "#0f172a", border: "#00838F", level: 1, fontColor: "#f8fafc" },
                concept_related: { bg: "#0f172a", border: "#4dd0e1", level: 1, fontColor: "#f8fafc" },
                glosario:        { bg: "#0f172a", border: "#9575cd", level: 2, fontColor: "#f8fafc" },
                tesauro:         { bg: "#0f172a", border: "#ce93d8", level: 2, fontColor: "#f8fafc" },
                tool:            { bg: "#0f172a", border: "#90caf9", level: 3, fontColor: "#f8fafc" },
                doc:             { bg: "#0f172a", border: "#90a4ae", level: 4, fontColor: "#f8fafc" },
                output:          { bg: "#0f172a", border: "#81c784", level: 5, fontColor: "#f8fafc" }
            } : {
                input:           { bg: "#ffffff", border: "#1f70c1", level: 0, fontColor: "#003a5d" },
                concept:         { bg: "#ffffff", border: "#00838F", level: 1, fontColor: "#003e44" },
                concept_related: { bg: "#ffffff", border: "#00ACC1", level: 1, fontColor: "#006064" },
                glosario:        { bg: "#ffffff", border: "#5e35b1", level: 2, fontColor: "#311b92" },
                tesauro:         { bg: "#ffffff", border: "#9c27b0", level: 2, fontColor: "#4a148c" },
                tool:            { bg: "#ffffff", border: "#0d47a1", level: 3, fontColor: "#0d47a1" },
                doc:             { bg: "#ffffff", border: "#546e7a", level: 4, fontColor: "#263238" },
                output:          { bg: "#ffffff", border: "#2e7d32", level: 5, fontColor: "#1b5e20" }
            };
            // hilight (cuando selected): borde más oscuro y bg ligeramente teñido
            Object.keys(TYPE_STYLE).forEach(k => {
                const t = TYPE_STYLE[k];
                t.shape = "box";
                t.hilightBg = isDark ? "#1e293b" : "#f8fafc";
                t.hilightBorder = t.border;
            });
            const fallback = TYPE_STYLE.concept;

            // TYPE NUMBERING — etiqueta corta tipo McKinsey (01, 02...) por categoría
            // que aparece DENTRO del label como prefijo.
            const TYPE_LABEL_CORTO = {
                input: "PREGUNTA", concept: "CONCEPTO", concept_related: "VECINO",
                glosario: "GLOSARIO", tesauro: "TESAURO",
                tool: "HERRAMIENTA", doc: "DOCUMENTO", output: "RESPUESTA"
            };
            const nodes = [];
            const seen = new Set();
            let typeCounters = {};
            for (const n of (travesia.nodes || [])) {
                if (seen.has(n.id)) continue;
                seen.add(n.id);
                const st = TYPE_STYLE[n.type] || fallback;
                const isFocal = n.type === "input" || n.type === "output";
                const isTool = n.type === "tool";
                const isDoc = n.type === "doc";
                typeCounters[n.type] = (typeCounters[n.type] || 0) + 1;
                const cat = TYPE_LABEL_CORTO[n.type] || "";
                const num = String(typeCounters[n.type]).padStart(2, "0");
                // Label estilo McKinsey: header pequeño en mayúsculas + título
                // Usar vis-network multi:'html' para formateo de dos líneas.
                const titleClean = (n.label || n.id).slice(0, 60);
                const labelHtml = `<b>${cat} ${num}</b>\n${titleClean}`;
                const wMin = 140;
                const wMax = isFocal ? 280 : (isTool || isDoc ? 240 : 200);
                nodes.push({
                    id: n.id,
                    label: labelHtml,
                    title: this._buildTooltipNode(n),
                    level: st.level,
                    color: {
                        background: st.bg,
                        border: st.border,
                        highlight: { background: st.hilightBg, border: st.hilightBorder }
                    },
                    font: {
                        color: st.fontColor,
                        size: 13,
                        face: "Inter, system-ui, -apple-system, 'Segoe UI', sans-serif",
                        multi: "html",
                        bold: { color: st.border, size: 9, mod: "bold", face: "system-ui" },
                        align: "left"
                    },
                    shape: "box",
                    margin: { top: 12, right: 16, bottom: 12, left: 16 },
                    widthConstraint: { minimum: wMin, maximum: wMax },
                    heightConstraint: { minimum: 48 },
                    borderWidth: 2.5,
                    borderWidthSelected: 4,
                    shadow: { enabled: true, color: "rgba(15,23,42,0.06)", size: 3, x: 0, y: 1 },
                    shapeProperties: { borderRadius: 3 },
                    _orig: n
                });
            }

            // EDGES McKinsey-style: 1 solo color base (navy/gray), variación SUTIL por tipo
            // via dash pattern y opacity. Sin colores pasteles de fiesta.
            const navy = isDark ? "#cbd5e1" : "#475569";
            const accent = isDark ? "#5ec5e5" : "#1f70c1";
            const subtle = isDark ? "#64748b" : "#94a3b8";
            const EDGE_STYLE = {
                extraccion:     { color: accent, dashes: false, width: 1.8 },   // input→concept (directo)
                ontologica:     { color: subtle, dashes: [3, 3], width: 1.2 },  // sutil, dotted
                glosario_mapeo: { color: subtle, dashes: [6, 4], width: 1.2 },  // sutil, dashed
                tesauro:        { color: subtle, dashes: [2, 4], width: 1.0 },  // muy sutil
                routing:        { color: navy,   dashes: false, width: 2.0 },   // routing principal navy
                context:        { color: subtle, dashes: [4, 4], width: 1.2 },
                encadenamiento: { color: navy,   dashes: false, width: 1.8 },
                ejecucion:      { color: navy,   dashes: false, width: 1.8 },
                cita:           { color: accent, dashes: false, width: 2.0 },
                evidencia:      { color: subtle, dashes: [3, 3], width: 1.2 },
                compose:        { color: accent, dashes: false, width: 2.0 }
            };
            const fallbackEdge = { color: subtle, dashes: false, width: 1.2 };
            const edges = [];
            for (let i = 0; i < (travesia.edges || []).length; i++) {
                const e = travesia.edges[i];
                const ec = EDGE_STYLE[e.tipo] || fallbackEdge;
                edges.push({
                    id: "e" + i,
                    from: e.from,
                    to: e.to,
                    label: e.label || "",
                    arrows: { to: { enabled: true, scaleFactor: 0.6, type: "arrow" } },
                    dashes: ec.dashes,
                    color: { color: ec.color, highlight: accent, opacity: isDark ? 0.85 : 1 },
                    font: {
                        size: 10, color: subtle,
                        background: isDark ? "rgba(15,23,42,0.92)" : "rgba(255,255,255,0.95)",
                        strokeWidth: 0,
                        align: "middle",
                        face: "Inter, system-ui, -apple-system, sans-serif"
                    },
                    width: ec.width,
                    selectionWidth: 1,
                    smooth: { enabled: true, type: "cubicBezier", forceDirection: "horizontal", roundness: 0.2 }
                });
            }

            // DataSets para vis-network (faltaban antes del bloque de layouts)
            const data = { nodes: new vis.DataSet(nodes), edges: new vis.DataSet(edges) };

            // 4 LAYOUTS PROFESIONALES (todos estaticos, click/hover funcional):
            //   pipeline  — hierarchical LR (narrativo izq→der)
            //   vertical  — hierarchical UD (arbol padre→hijos)
            //   radial    — posiciones manuales en anillos concentricos por nivel
            //   compacto  — force-directed, estabiliza 2s y CONGELA
            const layout = this.travesiaLayout || "pipeline";
            let layoutCfg = { improvedLayout: true, randomSeed: 42 };
            let physicsCfg = { enabled: false };
            if (layout === "pipeline") {
                layoutCfg = {
                    hierarchical: {
                        enabled: true, direction: "LR", sortMethod: "directed",
                        shakeTowards: "leaves",
                        levelSeparation: 360, nodeSpacing: 220, treeSpacing: 320,
                        blockShifting: true, edgeMinimization: true, parentCentralization: true
                    }
                };
            } else if (layout === "vertical") {
                layoutCfg = {
                    hierarchical: {
                        enabled: true, direction: "UD", sortMethod: "directed",
                        shakeTowards: "roots",
                        levelSeparation: 200, nodeSpacing: 240, treeSpacing: 280,
                        blockShifting: true, edgeMinimization: true
                    }
                };
            } else if (layout === "radial") {
                // Radial: posiciones INICIALES en anillos concentricos por nivel.
                // NO fixed:true para permitir drag manual.
                const RADIO_BASE = 220;
                const byLevel = {};
                nodes.forEach(n => {
                    const lv = (n.level != null) ? n.level : 1;
                    if (!byLevel[lv]) byLevel[lv] = [];
                    byLevel[lv].push(n);
                });
                Object.keys(byLevel).forEach(lvStr => {
                    const lv = parseInt(lvStr);
                    const arr = byLevel[lv];
                    const radio = lv * RADIO_BASE;
                    const N = arr.length;
                    // Offset angular para que niveles distintos no se alineen vertical
                    const offsetAngle = (lv % 2) * (Math.PI / N);
                    arr.forEach((n, i) => {
                        if (lv === 0) { n.x = 0; n.y = 0; }
                        else {
                            const angle = (2 * Math.PI * i / N) + offsetAngle - Math.PI / 2;
                            n.x = Math.cos(angle) * radio;
                            n.y = Math.sin(angle) * radio;
                        }
                        // SIN fixed para permitir drag; physics off mantiene posicion
                    });
                });
            } else if (layout === "compacto") {
                // Force-directed que estabiliza y congela. Click handler de abajo
                // hace setOptions physics:false en stabilizationIterationsDone.
                physicsCfg = {
                    enabled: true,
                    barnesHut: {
                        gravitationalConstant: -18000,
                        centralGravity: 0.3,
                        springLength: 180,
                        springConstant: 0.06,
                        damping: 0.9,
                        avoidOverlap: 1.0
                    },
                    stabilization: { enabled: true, iterations: 400, fit: true },
                    minVelocity: 1.0,
                    solver: "barnesHut",
                    timestep: 0.5,
                    adaptiveTimestep: true
                };
            }
            const options = {
                layout: layoutCfg,
                physics: physicsCfg,
                interaction: {
                    hover: true,
                    zoomView: true, dragView: true, dragNodes: true,
                    keyboard: { enabled: true, speed: { x: 10, y: 10, zoom: 0.02 } },
                    tooltipDelay: 120,                    // mas snappy
                    hideEdgesOnDrag: false,
                    navigationButtons: false
                },
                edges: { width: 1.5, font: { size: 12, color: "#475569", strokeWidth: 3, strokeColor: "#ffffff" } },
                nodes: {
                    borderWidth: 1.5,
                    borderWidthSelected: 4,
                    font: { size: 15, face: "system-ui, -apple-system, Segoe UI, sans-serif", color: "#0F172A", strokeWidth: 0, multi: false },
                    chosen: {
                        node: function(values, id, selected, hovering) {
                            // Halo dorado consistente con ontology-viewer
                            if (selected) {
                                values.borderWidth = 4;
                                values.borderColor = "#FFD700";
                                values.shadow = true;
                                values.shadowColor = "rgba(255, 215, 0, 0.65)";
                                values.shadowSize = 24;
                                values.shadowX = 0;
                                values.shadowY = 0;
                            } else if (hovering) {
                                values.borderWidth = 2.5;
                            }
                        },
                        label: false
                    }
                }
            };

            if (this._visTravesia) {
                try { this._visTravesia.destroy(); } catch (e) {}
                this._visTravesia = null;
            }
            const network = new vis.Network(containerEl, data, options);

            // P3: drag persistente en layouts hierarchical.
            // vis-network re-aplica el layout despues del drag y los nodos vuelven a
            // su posicion calculada. Al detectar dragStart, deshabilitamos el layout
            // hierarchical y dejamos la posicion libre. physics ya esta en false,
            // entonces el nodo queda donde el usuario lo solto.
            if (layout === "pipeline" || layout === "vertical") {
                let _layoutLiberado = false;
                network.on("dragStart", (params) => {
                    if (_layoutLiberado || !params.nodes || params.nodes.length === 0) return;
                    try {
                        network.setOptions({ layout: { hierarchical: { enabled: false } }, physics: { enabled: false } });
                        _layoutLiberado = true;
                    } catch (e) {}
                });
            }

            // Solo modo COMPACTO usa physics. Tras estabilizar congelar permanente.
            if (layout === "compacto") {
                network.on("stabilizationIterationsDone", () => {
                    network.setOptions({ physics: { enabled: false } });
                    network.fit({ animation: { duration: 250 } });
                });
                setTimeout(() => {
                    try { network.setOptions({ physics: { enabled: false } }); } catch (e) {}
                }, 3000);
            }

            // Click simple: panel detalle persistente (todos los nodos).
            // Doble-click en concept: drill-down al sub-grafo (intencional).
            network.on("click", (params) => {
                // Ocultar tooltip nativo para evitar solapamiento con el panel detalle
                this._ocultarTooltipVis();
                const nid = params.nodes[0];
                if (!nid) {
                    this.travesiaNodoSelect = null;
                    return;
                }
                const node = nodes.find(x => x.id === nid);
                if (!node || !node._orig) return;
                this.travesiaNodoSelect = node._orig;
            });

            network.on("doubleClick", (params) => {
                const nid = params.nodes[0];
                if (!nid) return;
                const node = nodes.find(x => x.id === nid);
                if (!node || !node._orig) return;
                const tipo = node._orig.type;
                if ((tipo === "concept" || tipo === "concept_related") && /^c\d+/.test(nid)) {
                    this.verGrafoConceptual(nid, node.label);
                }
            });

            // Hover 1-hop dimming — replica patron del ontology-viewer
            network.on("hoverNode", (params) => {
                this._aplicarHoverDimming(network, nodes, edges, params.node, true);
            });
            network.on("blurNode", () => {
                this._aplicarHoverDimming(network, nodes, edges, null, false);
            });

            // Re-fit defensivo: el container puede tener tamano final solo despues
            // del reflow del drawer (Alpine x-show). Fit con escala minima para
            // que las letras se lean sin tener que hacer zoom in manual.
            const fitConMinScale = () => {
                try {
                    network.fit({ animation: { duration: 200, easingFunction: "easeInOutQuad" } });
                    network.redraw();
                    // Si el fit dejo el zoom demasiado bajo (nodos chiquitos), elevarlo.
                    const scale = network.getScale();
                    const MIN_SCALE = 0.65;
                    if (scale < MIN_SCALE) {
                        network.moveTo({ scale: MIN_SCALE, animation: { duration: 250 } });
                    }
                } catch (e) {}
            };
            setTimeout(fitConMinScale, 150);

            this._visTravesia = network;
            this._visTravesiaNodes = nodes;
            this._visTravesiaEdges = edges;
            this.travesiaError = "";
            this.travesiaNodoSelect = null;
        },

        // Aislar nodos de un tipo: dimear todo lo que no sea ese tipo. Disparado
        // por click en chip de leyenda. Vuelve a clickear para limpiar.
        toggleTravesiaTipoFiltro(tipo) {
            if (!this._visTravesia || !this._visTravesiaNodes) return;
            const network = this._visTravesia;
            const allNodes = this._visTravesiaNodes;
            const allEdges = this._visTravesiaEdges || [];
            if (this.travesiaTipoFiltro === tipo) {
                // Toggle off: restaurar
                this.travesiaTipoFiltro = "";
                allNodes.forEach(n => network.body.data.nodes.update({ id: n.id, opacity: 1.0 }));
                allEdges.forEach(e => network.body.data.edges.update({
                    id: e.id, color: e._origColor || e.color
                }));
                return;
            }
            this.travesiaTipoFiltro = tipo;
            const matchIds = new Set(allNodes.filter(n => n._orig && n._orig.type === tipo).map(n => n.id));
            allNodes.forEach(n => {
                network.body.data.nodes.update({ id: n.id, opacity: matchIds.has(n.id) ? 1.0 : 0.18 });
            });
            allEdges.forEach(e => {
                if (!e._origColor) e._origColor = e.color;
                const isPart = matchIds.has(e.from) || matchIds.has(e.to);
                network.body.data.edges.update({
                    id: e.id,
                    color: isPart
                        ? e._origColor
                        : { color: this._temaEsOscuro() ? "#1f2937" : "#cbd5e1", opacity: 0.3 }
                });
            });
        },

        cerrarTravesia() {
            this.travesiaOpen = false;
            this.travesiaNodoSelect = null;
            this.travesiaTipoFiltro = "";
            if (this._visTravesia) {
                try { this._visTravesia.destroy(); } catch (e) {}
                this._visTravesia = null;
            }
        },

        // Helpers re-export para template Alpine
        get travesiaTiposPresentes() {
            const data = this.travesiaData;
            if (!data || !data.nodes) return [];
            const seen = new Set();
            const out = [];
            data.nodes.forEach(n => {
                if (seen.has(n.type)) return;
                seen.add(n.type);
                out.push({
                    tipo: n.type,
                    label: this._typeLabel(n.type),
                    cls: "leyenda-chip--" + n.type
                });
            });
            return out;
        },

        // Agrupa los nodos por tipo en el orden narrativo del pipeline
        get travesiaNodosPorTipo() {
            const data = this.travesiaData;
            if (!data || !data.nodes) return [];
            // Orden narrativo de izquierda a derecha del grafo
            const ORDER = ["input", "concept", "concept_related", "glosario", "tesauro", "tool", "doc", "output"];
            const groups = {};
            data.nodes.forEach(n => {
                if (!groups[n.type]) groups[n.type] = [];
                groups[n.type].push(n);
            });
            const out = [];
            for (const tipo of ORDER) {
                if (!groups[tipo]) continue;
                out.push({
                    tipo,
                    label: this._typeLabel(tipo),
                    cls: "tipo-" + tipo,
                    items: groups[tipo],
                    count: groups[tipo].length
                });
            }
            // Tipos extras no en ORDER (defensivo)
            for (const tipo of Object.keys(groups)) {
                if (ORDER.includes(tipo)) continue;
                out.push({
                    tipo,
                    label: this._typeLabel(tipo),
                    cls: "tipo-" + tipo,
                    items: groups[tipo],
                    count: groups[tipo].length
                });
            }
            return out;
        },

        // Resumen narrativo data-rich (Tab "Resumen") — devuelve un OBJETO con
        // pasos detallados. Cada paso describe que paso REALMENTE y con que datos
        // concretos (no plantilla generica).
        get travesiaResumen() {
            const data = this.travesiaData;
            if (!data || !data.nodes) return null;
            const nodes = data.nodes;
            const tel = data.metricas || {};

            const inputNode = nodes.find(n => n.type === "input");
            const conceptos = nodes.filter(n => n.type === "concept");
            const conceptosRel = nodes.filter(n => n.type === "concept_related");
            const glosario = nodes.filter(n => n.type === "glosario");
            const tesauro = nodes.filter(n => n.type === "tesauro");
            const tools = nodes.filter(n => n.type === "tool")
                .sort((a, b) => (a.iter || 0) - (b.iter || 0));
            const docs = nodes.filter(n => n.type === "doc")
                .sort((a, b) => (b.score || 0) - (a.score || 0));
            const outputNode = nodes.find(n => n.type === "output");

            const pasos = [];

            // Paso 1: Pregunta
            pasos.push({
                num: 1,
                titulo: "Pregunta del usuario",
                tipo: "input",
                ms: null,
                descripcion: inputNode ? (inputNode.tooltip || data.pregunta) : data.pregunta,
                items: []
            });

            // Paso 2: Extracción de conceptos
            if (conceptos.length || conceptosRel.length) {
                pasos.push({
                    num: 2,
                    titulo: "Detección de conceptos en la ontología",
                    tipo: "concept",
                    ms: null,
                    descripcion: `Encontré ${conceptos.length} concepto${conceptos.length===1?"":"s"} clave en la pregunta` +
                                 (conceptosRel.length ? ` y ${conceptosRel.length} concepto${conceptosRel.length===1?"":"s"} vecino${conceptosRel.length===1?"":"s"} relacionado${conceptosRel.length===1?"":"s"} en la ontología` : "") +
                                 ".",
                    items: conceptos.map(c => ({
                        label: c.label,
                        sub: typeof c.confianza === "number" ? `confianza ${(c.confianza*100).toFixed(0)}%` : null,
                        info: c.descripcion || c.tooltip || null,
                        nodo: c
                    }))
                });
            }

            // Paso 3: Glosario / Tesauro
            if (glosario.length || tesauro.length) {
                const items = [
                    ...glosario.map(g => ({label: g.label, sub: g.tabla ? `glosario · tabla ${g.tabla}` : "glosario", nodo: g})),
                    ...tesauro.map(t => ({label: t.label, sub: "tesauro", info: t.tooltip, nodo: t}))
                ];
                pasos.push({
                    num: 3,
                    titulo: "Resolución institucional",
                    tipo: "glosario",
                    ms: null,
                    descripcion: `${glosario.length} entidad${glosario.length===1?"":"es"} del glosario` +
                                 (tesauro.length ? ` y ${tesauro.length} término${tesauro.length===1?"":"s"} del tesauro` : "") +
                                 " conectan los conceptos detectados con los datos institucionales de la ANH.",
                    items
                });
            }

            // Paso 4: Tool routing + ejecución
            if (tools.length) {
                pasos.push({
                    num: 4,
                    titulo: tools.length === 1 ? "Herramienta invocada" : `Cadena de ${tools.length} herramientas`,
                    tipo: "tool",
                    ms: tel.msTool || null,
                    descripcion: tools.length === 1
                        ? `El LLM decidió invocar "${tools[0].label}" para resolver la pregunta.`
                        : `El LLM encadenó ${tools.length} herramientas en orden para refinar la respuesta.`,
                    items: tools.map(t => {
                        const meta = this._toolMeta(t.label);
                        return {
                            label: t.label,
                            sub: meta ? `${meta.level} · ${meta.tooltip}` : (t.iter ? `iteración ${t.iter}` : null),
                            info: t.args ? `args: ${JSON.stringify(t.args).slice(0, 200)}` : null,
                            nodo: t
                        };
                    })
                });
            }

            // Paso 5: Documentos consultados
            if (docs.length) {
                pasos.push({
                    num: 5,
                    titulo: "Documentos consultados del corpus",
                    tipo: "doc",
                    ms: null,
                    descripcion: `Se recuperaron ${docs.length} documento${docs.length===1?"":"s"} del corpus indexado, ordenados por relevancia.`,
                    items: docs.slice(0, 8).map(d => ({
                        label: d.label,
                        sub: typeof d.score === "number" ? `score ${d.score.toFixed(3)}` : null,
                        info: d.ruta || null,
                        nodo: d
                    }))
                });
            }

            // Paso 6: Composición de la respuesta
            pasos.push({
                num: 6,
                titulo: "Composición de la respuesta",
                tipo: "output",
                ms: tel.msLlmTurn2 || null,
                descripcion: tools.length
                    ? `Con la evidencia de la${docs.length===1?"":"s"} consulta${docs.length===1?"":"s"}, el LLM compuso la respuesta final citando los documentos relevantes.`
                    : "El LLM compuso la respuesta directamente sin invocar herramientas (no se requirió consulta al corpus).",
                items: outputNode ? [{
                    label: outputNode.label,
                    sub: typeof tel.tokensCompletion === "number" ? `${tel.tokensCompletion} tokens generados` : null,
                    nodo: outputNode
                }] : []
            });

            return {
                pregunta: data.pregunta,
                msTotal: tel.msTotal || 0,
                pasos
            };
        },

        // Toggle expand/collapse de un tipo en la lista detallada
        _expandidos: {},
        toggleTipoExpand(tipo) {
            // Alpine reactive: clonar el objeto para disparar update
            this._expandidos = { ...this._expandidos, [tipo]: !this._expandidos[tipo] };
        },

        // Resize drag handler genérico — captura mousemove en window y aplica
        // newSize via callback. Usado por el drawer travesia (handle izquierdo)
        // y el sidebar del sub-grafo (handle derecho).
        _iniciarResize(e, opts) {
            e.preventDefault();
            const startPos = e.clientX;
            const startSize = opts.start;
            const direction = opts.dir || "left";  // left | right
            const min = opts.min || 200;
            const max = opts.max || 2000;
            const apply = opts.apply;
            const onEnd = opts.onEnd || (() => {});
            document.body.style.cursor = "ew-resize";
            document.body.style.userSelect = "none";
            const onMove = (ev) => {
                const delta = direction === "left" ? (startPos - ev.clientX) : (ev.clientX - startPos);
                const next = Math.max(min, Math.min(max, startSize + delta));
                apply(next);
            };
            const onUp = () => {
                document.removeEventListener("mousemove", onMove);
                document.removeEventListener("mouseup", onUp);
                document.body.style.cursor = "";
                document.body.style.userSelect = "";
                onEnd();
            };
            document.addEventListener("mousemove", onMove);
            document.addEventListener("mouseup", onUp);
        },

        // Resize del drawer travesia: handle a la izquierda, drag → mas ancho
        iniciarResizeDrawer(e) {
            const drawer = e.currentTarget.closest(".drawer");
            if (!drawer) return;
            this._iniciarResize(e, {
                start: drawer.offsetWidth,
                dir: "left",
                min: 480,
                max: Math.floor(window.innerWidth * 0.98),
                apply: (w) => {
                    drawer.style.width = w + "px";
                    drawer.style.maxWidth = "98vw";
                },
                onEnd: () => {
                    if (this._visTravesia) this._visTravesia.fit({ animation: { duration: 200 } });
                }
            });
        },

        // Resize del sidebar del sub-grafo: handle a la derecha del cy, drag → mas ancho
        iniciarResizeSidebar(e) {
            const layout = e.currentTarget.closest(".grafo-conc__layout");
            if (!layout) return;
            const sidebar = layout.querySelector(".grafo-conc__metricas");
            if (!sidebar) return;
            this._iniciarResize(e, {
                start: sidebar.offsetWidth,
                dir: "left",
                min: 220,
                max: 600,
                apply: (w) => {
                    sidebar.style.width = w + "px";
                    sidebar.style.minWidth = w + "px";
                    sidebar.style.maxWidth = w + "px";
                },
                onEnd: () => {
                    if (this._visGrafoConc) this._visGrafoConc.fit({ animation: { duration: 200 } });
                }
            });
        },

        // Acción al click en un nodo del tab "Nodos por tipo": cambia a tab Grafo,
        // setea la seleccion (panel detalle) y centra la camara en ese nodo.
        seleccionarNodoDesdeListado(nodo) {
            this.travesiaTipoFiltro = "";
            this.travesiaNodoSelect = nodo;
            const wasGrafoTab = this.travesiaTabActiva === "grafo";
            this.travesiaTabActiva = "grafo";
            this.$nextTick(() => {
                if (this._visTravesia) {
                    try {
                        this._visTravesia.selectNodes([nodo.id]);
                        this._visTravesia.focus(nodo.id, {
                            scale: 1.0,
                            animation: { duration: 400, easingFunction: "easeInOutQuad" }
                        });
                        if (!wasGrafoTab) {
                            // Tab cambio, re-fit no es necesario: focus ya posiciono
                        }
                    } catch (e) {
                        // ignore: nodo no en el grafo o vis-network no listo
                    }
                }
            });
        },

        // Mini-toolbar del grafo: fit/zoom/reset/busqueda
        _grafoActivo() {
            // Resuelve cual de los 2 grafos esta visible para aplicar la accion
            if (this.grafoConcOpen && this._visGrafoConc) return {
                net: this._visGrafoConc,
                nodes: this._visGrafoConcNodes || [],
                edges: this._visGrafoConcEdges || []
            };
            if (this.travesiaOpen && this._visTravesia) return {
                net: this._visTravesia,
                nodes: this._visTravesiaNodes || [],
                edges: this._visTravesiaEdges || []
            };
            return null;
        },
        grafoFit() {
            const g = this._grafoActivo();
            if (g) g.net.fit({ animation: { duration: 350, easingFunction: "easeInOutQuad" } });
        },
        grafoZoom(factor) {
            const g = this._grafoActivo();
            if (!g) return;
            const scale = g.net.getScale() * factor;
            g.net.moveTo({ scale, animation: { duration: 200 } });
        },
        grafoReset() {
            const g = this._grafoActivo();
            if (!g) return;
            this.travesiaTipoFiltro = "";
            this.travesiaBusqueda = "";
            g.nodes.forEach(n => g.net.body.data.nodes.update({ id: n.id, opacity: 1.0 }));
            g.edges.forEach(e => {
                const c = e._origColor || e.color;
                g.net.body.data.edges.update({ id: e.id, color: c });
            });
            g.net.unselectAll();
            g.net.fit({ animation: { duration: 350, easingFunction: "easeInOutQuad" } });
        },
        aplicarBusquedaTravesia() {
            const g = this._grafoActivo();
            if (!g) return;
            const q = (this.travesiaBusqueda || "").trim().toLowerCase();
            if (!q) {
                g.nodes.forEach(n => g.net.body.data.nodes.update({ id: n.id, opacity: 1.0 }));
                return;
            }
            const matchIds = new Set(
                g.nodes
                    .filter(n => {
                        const lbl = (n.label || "").toLowerCase();
                        const desc = ((n._orig && (n._orig.descripcion || n._orig.tooltip)) || "").toLowerCase();
                        return lbl.includes(q) || desc.includes(q);
                    })
                    .map(n => n.id)
            );
            g.nodes.forEach(n => {
                g.net.body.data.nodes.update({
                    id: n.id, opacity: matchIds.has(n.id) ? 1.0 : 0.15
                });
            });
            g.edges.forEach(e => {
                if (!e._origColor) e._origColor = e.color;
                const isPart = matchIds.has(e.from) && matchIds.has(e.to);
                g.net.body.data.edges.update({
                    id: e.id,
                    color: isPart
                        ? e._origColor
                        : { color: this._temaEsOscuro() ? "#1f2937" : "#cbd5e1", opacity: 0.25 }
                });
            });
        },
        // Cambia el layout del grafo travesia entre 'pipeline' y 'topologia' y re-renderiza
        cambiarLayoutTravesia(nuevo) {
            if (nuevo === this.travesiaLayout) return;
            this.travesiaLayout = nuevo;
            if (this.travesiaData) {
                this.$nextTick(() => {
                    const c = document.getElementById("cy-travesia-container");
                    if (c) this._renderTravesiaVis(this.travesiaData, c);
                });
            }
        },

        async grafoExportarPng() {
            const g = this._grafoActivo();
            if (!g) return;
            try {
                const canvas = g.net.canvas.frame.canvas;
                const dataUrl = canvas.toDataURL("image/png");
                const link = document.createElement("a");
                link.download = "grafo-travesia-" + Date.now() + ".png";
                link.href = dataUrl;
                link.click();
                this.toastFlash("PNG descargado");
            } catch (err) {
                this.toastFlash("No se pudo exportar: " + (err.message || err));
            }
        },

        // ---------------- Sub-grafo conceptual (Mejora 3) ----------------
        async verGrafoConceptual(conceptoId, conceptoLabel) {
            if (!conceptoId) return;
            // Extraer numero del id "c123" -> "123"
            const idStr = String(conceptoId).replace(/^c/, "");
            this.grafoConcOpen = true;
            this.grafoConcCargando = true;
            this.grafoConcData = null;
            this.grafoConcSvg = "";
            this.grafoConcConceptoLabel = conceptoLabel || ("concepto " + idStr);
            try {
                const token = this.getAccessToken();
                const url = D.BASE_URL + D.ENDPOINT_GRAFO_CONC + (token ? "?access_token=" + encodeURIComponent(token) : "");
                const resp = await fetch(url, {
                    method: "POST", headers: {"Content-Type": "application/json"},
                    body: JSON.stringify({p_concepto_id: idStr, p_depth: "2"})
                });
                if (!resp.ok) throw new Error("HTTP " + resp.status);
                const rawText = await resp.text();
                if (rawText.includes("permission denied") || rawText.includes("InsufficientPrivilege")) {
                    this._handleAuthExpired(); return;
                }
                const wrapped = JSON.parse(rawText);
                const inner = Array.isArray(wrapped) ? wrapped[0] : wrapped;
                const payload = inner && inner.result !== undefined
                    ? (typeof inner.result === "string" ? JSON.parse(inner.result) : inner.result)
                    : inner;
                if (!payload || payload.motivo !== "ok") {
                    this.grafoConcData = {motivo: payload?.motivo || "error"};
                    return;
                }
                this.grafoConcData = payload;
                this.$nextTick(() => {
                    const c = document.getElementById("cy-grafo-conc-container");
                    if (c) this._renderGrafoConcVis(payload, c);
                });
            } catch (err) {
                this.grafoConcData = {motivo: "error", err: err.message || String(err)};
            } finally {
                this.grafoConcCargando = false;
            }
        },

        async _renderGrafoConcVis(grafo, containerEl) {
            // BFS sub-ontologia con vis-network. Layout hierarchical UD (raiz arriba,
            // descendientes abajo) — replica el patron del ontology-viewer.
            if (typeof vis === "undefined" || !vis.Network) return;
            const isDark = this._temaEsOscuro();
            const fontNodo = isDark ? "#f8fafc" : "#0f172a";
            const fontEdge = isDark ? "#e2e8f0" : "#334155";
            const strokeCol = isDark ? "#0f172a" : "#ffffff";

            // McKinsey-style sub-grafo: bg blanco/navy, borde corporativo, sin pasteles
            const TYPE_STYLE = isDark ? {
                concept_root:    { bg: "#0f172a", border: "#1f70c1", shape: "box", size: 28, fontColor: "#f8fafc", fontSize: 14, borderWidth: 3 },
                concept_related: { bg: "#0f172a", border: "#00838F", shape: "box", size: 18, fontColor: "#f8fafc", fontSize: 12, borderWidth: 2 },
                glosario:        { bg: "#0f172a", border: "#9575cd", shape: "box", size: 18, fontColor: "#f8fafc", fontSize: 12, borderWidth: 2 }
            } : {
                concept_root:    { bg: "#ffffff", border: "#1f70c1", shape: "box", size: 28, fontColor: "#003a5d", fontSize: 14, borderWidth: 3 },
                concept_related: { bg: "#ffffff", border: "#00838F", shape: "box", size: 18, fontColor: "#003e44", fontSize: 12, borderWidth: 2 },
                glosario:        { bg: "#ffffff", border: "#5e35b1", shape: "box", size: 18, fontColor: "#311b92", fontSize: 12, borderWidth: 2 }
            };
            Object.keys(TYPE_STYLE).forEach(k => {
                const t = TYPE_STYLE[k];
                t.hilightBg = isDark ? "#1e293b" : "#f8fafc";
                t.hilightBorder = t.border;
            });
            const fallback = TYPE_STYLE.concept_related;

            const nodes = [];
            const seen = new Set();
            for (const n of (grafo.nodes || [])) {
                if (seen.has(n.id)) continue;
                seen.add(n.id);
                const st = TYPE_STYLE[n.type] || fallback;
                nodes.push({
                    id: n.id,
                    label: n.label || n.id,
                    title: this._buildTooltipNode(n),
                    level: typeof n.level === "number" ? n.level : 0,
                    color: {
                        background: st.bg, border: st.border,
                        highlight: { background: st.hilightBg, border: st.hilightBorder }
                    },
                    font: {
                        color: st.fontColor, size: st.fontSize,
                        face: "system-ui, -apple-system, 'Segoe UI', sans-serif",
                        multi: false, align: "center"
                    },
                    shape: "box",
                    margin: { top: 10, right: 12, bottom: 10, left: 12 },
                    widthConstraint: { minimum: 90, maximum: 200 },
                    heightConstraint: { minimum: 32 },
                    borderWidth: st.borderWidth || 2,
                    borderWidthSelected: 4,
                    shadow: { enabled: true, color: "rgba(0,0,0,0.08)", size: 5, x: 0, y: 2 },
                    shapeProperties: { borderRadius: 8 },
                    _orig: n
                });
            }

            const edges = [];
            for (let i = 0; i < (grafo.edges || []).length; i++) {
                const e = grafo.edges[i];
                const isMapeo = e.label && /mapea|sinonimo|glosario/i.test(e.label);
                const ec = isMapeo
                    ? { color: "#fbbf24", dashes: true, width: 1.8 }
                    : { color: "#0d9488", dashes: false, width: 1.5 };
                edges.push({
                    id: "ge" + i,
                    from: e.from, to: e.to,
                    label: e.label || "",
                    arrows: "to",
                    dashes: ec.dashes,
                    color: { color: ec.color, highlight: "#FFD700" },
                    font: {
                        size: 11, color: fontEdge,
                        background: isDark ? "rgba(15,23,42,0.85)" : "rgba(255,255,255,0.92)",
                        strokeWidth: 0,
                        align: "middle", face: "inherit"
                    },
                    width: ec.width,
                    smooth: { enabled: true, type: "cubicBezier", forceDirection: "vertical", roundness: 0.4 }
                });
            }

            const data = { nodes: new vis.DataSet(nodes), edges: new vis.DataSet(edges) };
            const options = {
                layout: {
                    hierarchical: {
                        enabled: true,
                        direction: "UD",                  // raiz arriba, descendientes abajo
                        sortMethod: "directed",
                        shakeTowards: "roots",
                        levelSeparation: 180,
                        nodeSpacing: 180,
                        treeSpacing: 280,
                        blockShifting: true,
                        edgeMinimization: true,
                        parentCentralization: true
                    }
                },
                physics: { enabled: false },
                interaction: {
                    hover: true,
                    zoomView: true, dragView: true, dragNodes: true,
                    keyboard: { enabled: true, speed: { x: 10, y: 10, zoom: 0.02 } },
                    tooltipDelay: 120,
                    hideEdgesOnDrag: false,
                    navigationButtons: false
                },
                edges: { width: 1.5 },
                nodes: {
                    borderWidth: 1.5,
                    borderWidthSelected: 4,
                    chosen: {
                        node: function(values, id, selected, hovering) {
                            if (selected) {
                                values.borderWidth = 4;
                                values.borderColor = "#FFD700";
                                values.shadow = true;
                                values.shadowColor = "rgba(255, 215, 0, 0.65)";
                                values.shadowSize = 24;
                            } else if (hovering) {
                                values.borderWidth = 2.5;
                            }
                        },
                        label: false
                    }
                }
            };

            if (this._visGrafoConc) {
                try { this._visGrafoConc.destroy(); } catch (e) {}
                this._visGrafoConc = null;
            }
            const network = new vis.Network(containerEl, data, options);

            // P3: drag persistente — al iniciar drag, liberar layout hierarchical.
            let _layoutLiberadoConc = false;
            network.on("dragStart", (params) => {
                if (_layoutLiberadoConc || !params.nodes || params.nodes.length === 0) return;
                try {
                    network.setOptions({ layout: { hierarchical: { enabled: false } }, physics: { enabled: false } });
                    _layoutLiberadoConc = true;
                } catch (e) {}
            });

            // Click simple: panel detalle persistente
            network.on("click", (params) => {
                this._ocultarTooltipVis();
                const nid = params.nodes[0];
                if (!nid) {
                    this.grafoConcNodoSelect = null;
                    return;
                }
                const node = nodes.find(x => x.id === nid);
                if (!node || !node._orig) return;
                this.grafoConcNodoSelect = node._orig;
            });

            // Doble-click en concepto: cambia la raiz a ese concepto (drill-down)
            network.on("doubleClick", (params) => {
                const nid = params.nodes[0];
                if (!nid) return;
                const node = nodes.find(x => x.id === nid);
                if (!node || !node._orig) return;
                const tipo = node._orig.type;
                if (tipo === "concept_related" || tipo === "concept_root") {
                    this.verGrafoConceptual(nid, node.label);
                }
            });

            // Hover 1-hop dimming
            network.on("hoverNode", (params) => {
                this._aplicarHoverDimming(network, nodes, edges, params.node, true);
            });
            network.on("blurNode", () => {
                this._aplicarHoverDimming(network, nodes, edges, null, false);
            });

            // Re-fit defensivo despues del reflow del modal
            setTimeout(() => {
                try {
                    network.fit({ animation: { duration: 200, easingFunction: "easeInOutQuad" } });
                    network.redraw();
                } catch (e) {}
            }, 150);

            this._visGrafoConc = network;
            this._visGrafoConcNodes = nodes;
            this._visGrafoConcEdges = edges;
            this.grafoConcNodoSelect = null;
        },

        cerrarGrafoConceptual() {
            this.grafoConcOpen = false;
            this.grafoConcData = null;
            this.grafoConcNodoSelect = null;
            if (this._visGrafoConc) {
                try { this._visGrafoConc.destroy(); } catch (e) {}
                this._visGrafoConc = null;
            }
        },

        // Acciones del panel detalle (compartido entre travesia y grafo conc)
        nodoDetalleAccionPrincipal(node) {
            if (!node) return;
            const tipo = node.type;
            if (tipo === "concept" || tipo === "concept_related" || tipo === "concept_root") {
                if (/^c\d+/.test(node.id)) this.verGrafoConceptual(node.id, node.label);
            } else if (tipo === "doc" && node.docId) {
                // Abrir drawer cita con el docId
                this.abrirDrawer({ id: node.docId, ruta: node.ruta, titulo: node.label }, null);
            } else if (tipo === "tool") {
                this.toolOverride = node.label;
                this.toastFlash("Tool '" + node.label + "' establecida como override");
            }
        },

        // ---------------- Feedback usuario (👍/👎/🤷) ----------------
        // Helper: clave estable de feedback por turno (siempre string, nunca null)
        _feedbackKey(turno) {
            if (!turno) return "";
            return turno.tempKey || ("ts-" + (turno.turnoId || ""));
        },

        // Helper: el feedback ya fue enviado para este turno? Retorna boolean.
        // Usado en :disabled para evitar binding ambiguo undefined→string vacio.
        esFeedbackEnviado(turno) {
            const k = this._feedbackKey(turno);
            return !!(k && this.feedbackEnviado[k]);
        },

        // Helper: veredicto enviado (string o null)
        feedbackVeredicto(turno) {
            const k = this._feedbackKey(turno);
            return (k && this.feedbackEnviado[k]) || null;
        },

        async enviarFeedback(turno, veredicto, comentario) {
            if (!turno) return;
            const tempKey = this._feedbackKey(turno) || ("ts-" + Date.now());
            const tools = (turno.toolsInvocadas || []).map(t => ({
                doc_id: null,
                titulo: t.name,
                score_rerank: null
            }));
            const docEntregado = (turno.citaciones && turno.citaciones[0] && turno.citaciones[0].id) || null;
            const tel = turno.telemetria || {};
            const payload = {
                pregunta: turno.pregunta || "",
                respuesta_sistema: (turno.respuesta || "").slice(0, 4000),
                veredicto,
                doc_entregado: docEntregado,
                agente_id: "BrainVtHidrocarburosAgent",
                user_id: this._currentUsername(),
                canal: "spa_chat_assistant",
                comentario_usuario: comentario || null,
                candidatos_top3: tools.slice(0, 3),
                tiempos_ms: {
                    extract: tel.msTool || 0,
                    judge: tel.msLlmTurn1 || 0,
                    rerank: tel.msLlmTurn2 || 0,
                    encode: 0,
                    hnsw: 0
                }
            };
            try {
                const token = this.getAccessToken();
                const url = D.BASE_URL + D.ENDPOINT_FEEDBACK + (token ? "?access_token=" + encodeURIComponent(token) : "");
                const resp = await fetch(url, {
                    method: "POST",
                    headers: {"Content-Type": "application/json"},
                    body: JSON.stringify({payload: JSON.stringify(payload)})
                });
                const rawText = await resp.text();
                if (!resp.ok || rawText.includes("permission denied") || rawText.includes("InsufficientPrivilege")) {
                    if (rawText.includes("permission denied")) this._handleAuthExpired();
                    this.toastFlash("Error enviando feedback");
                    return;
                }
                this.feedbackEnviado[tempKey] = veredicto;
                this.feedbackPendiente = null;
                this.feedbackComentario = "";
                this.toastFlash("Gracias por tu feedback");
            } catch (err) {
                this.toastFlash("Error enviando feedback: " + (err.message || err));
            }
        },

        pedirComentarioFeedback(turno, veredicto) {
            const tempKey = this._feedbackKey(turno) || ("ts-" + Date.now());
            this.feedbackPendiente = {tempKey, veredicto, turno};
            this.feedbackComentario = "";
        },

        confirmarFeedbackConComentario() {
            if (!this.feedbackPendiente) return;
            this.enviarFeedback(this.feedbackPendiente.turno,
                this.feedbackPendiente.veredicto,
                this.feedbackComentario.trim() || null);
        },

        cancelarFeedback() {
            this.feedbackPendiente = null;
            this.feedbackComentario = "";
        },

        _currentUsername() {
            // Best-effort: extraer username del JWT del URL
            try {
                const token = this.getAccessToken() || "";
                const parts = token.split(".");
                if (parts.length >= 2) {
                    const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
                    return payload.username || payload.sub || "unknown";
                }
            } catch (e) {}
            return "unknown";
        },

        rerunTurno(t, idx) {
            // Re-ejecuta la pregunta del turno como nueva (queda historial visible)
            const pregunta = t.pregunta;
            this.toolOverride = null;
            // Si ya tenía una tool, sugerimos forzar otra distinta
            this.enviar(undefined, pregunta);
        },

        editarPregunta(idx) {
            const t = this.turnos[idx];
            if (!t || this.loading) return;
            this.prompt = t.pregunta;
            this.focusInput();
            this.toastFlash("Editando — modifica y reenviá");
        },

        toggleToolOverride(name) {
            this.toolOverride = (this.toolOverride === name) ? null : name;
        },

        // ---------------- Drawer ----------------
        abrirDrawer(c, mensajeId) {
            this.drawerCita = Object.assign({}, c);
            this.drawerCita._mensajeId = mensajeId || null;
            this.drawerCita._enriquecido = null;
            this.drawerCita._cargando = true;
            // Lazy fetch del enriquecimiento
            this._enriquecerDrawerCita();
        },

        async _enriquecerDrawerCita() {
            if (!this.drawerCita || !this.drawerCita.id) {
                if (this.drawerCita) this.drawerCita._cargando = false;
                return;
            }
            try {
                const token = this.getAccessToken();
                const url = D.BASE_URL + "/functions/IaCore.detallarDocumentoCitado" +
                            (token ? "?access_token=" + encodeURIComponent(token) : "");
                const resp = await fetch(url, {
                    method: "POST",
                    headers: {"Content-Type": "application/json"},
                    body: JSON.stringify({
                        p_documento_id: String(this.drawerCita.id),
                        p_mensaje_id: this.drawerCita._mensajeId ? String(this.drawerCita._mensajeId) : ""
                    })
                });
                if (!resp.ok) throw new Error("HTTP " + resp.status);
                const rawText = await resp.text();
                if (rawText.includes("permission denied") || rawText.includes("InsufficientPrivilege")) {
                    this._handleAuthExpired();
                    return;
                }
                const wrapped = JSON.parse(rawText);
                const inner = Array.isArray(wrapped) ? wrapped[0] : wrapped;
                let payload = null;
                if (inner && inner.result !== undefined) {
                    const val = inner.result;
                    payload = (typeof val === "string") ? JSON.parse(val) : val;
                } else payload = inner;
                if (this.drawerCita) {
                    this.drawerCita._enriquecido = payload;
                    this.drawerCita._cargando = false;
                }
            } catch (err) {
                if (this.drawerCita) {
                    this.drawerCita._error = err.message || String(err);
                    this.drawerCita._cargando = false;
                }
            }
        },
        async copiarRuta() {
            if (!this.drawerCita?.ruta) return;
            try { await navigator.clipboard.writeText(this.drawerCita.ruta); this.toastFlash("Ruta copiada"); }
            catch (e) { this.lastError = "No se pudo copiar"; }
        },
        async copiarRespuesta(t) {
            try { await navigator.clipboard.writeText(t.respuesta || ""); this.toastFlash("Respuesta copiada"); }
            catch (e) { this.lastError = "No se pudo copiar"; }
        },

        toastFlash(msg, ms) {
            this.toastMsg = msg;
            if (this._toastTimer) clearTimeout(this._toastTimer);
            this._toastTimer = setTimeout(() => { this.toastMsg = ""; }, ms || 1800);
        },

        _appendCachedTurno(pregunta, payload) {
            const respuesta = payload.respuesta || "";
            this.turnos.push({
                tempKey: "cache-" + Date.now(),
                turnoId: payload.iacoreAssistantMsgId || payload.turnoId,
                aiaTurnoId: payload.turnoId,
                iacoreUserMsgId: payload.iacoreUserMsgId,
                iacoreConvId: payload.iacoreConvId,
                turnoOrden: this.turnos.length + 1,
                pregunta,
                respuesta,
                bloques: this.parseRespuestaABloques(respuesta),
                telemetria: payload.telemetria || null,
                citaciones: payload.citaciones || [],
                toolInvocada: payload.toolInvocada || null,
                toolArgs: payload.toolArgs || null,
                toolsInvocadas: payload.toolsInvocadas || [],
                toolForzada: payload.toolForzada || false,
                _pending: false,
            });
            this.prompt = "";
            this.clearDraft();
            this.$nextTick(() => this.scrollToBottom());
        },

        _uuid() {
            // RFC4122 v4
            return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
                const r = (Math.random() * 16) | 0;
                const v = c === "x" ? r : (r & 0x3) | 0x8;
                return v.toString(16);
            });
        },

        // ---------------- Plantilla ANH parser ----------------
        parseRespuestaABloques(text) {
            if (!text) return [];
            const lines = text.split(/\r?\n/);
            const matches = [];
            for (let i = 0; i < lines.length; i++) {
                for (const def of D.BLOQUES_PLANTILLA) {
                    if (def.re.test(lines[i])) { matches.push({ idx: i, def }); break; }
                }
            }
            if (matches.length === 0) {
                return [{ tipo: "plain", label: null, html: this.markdownToHtml(text) }];
            }
            const bloques = [];
            if (matches[0].idx > 0) {
                const pre = lines.slice(0, matches[0].idx).join("\n").trim();
                if (pre) bloques.push({ tipo: "plain", label: null, html: this.markdownToHtml(pre) });
            }
            for (let m = 0; m < matches.length; m++) {
                const cur = matches[m];
                const next = matches[m + 1];
                const body = lines.slice(cur.idx + 1, next ? next.idx : lines.length).join("\n").trim();
                bloques.push({ tipo: cur.def.tipo, label: cur.def.label, html: this.markdownToHtml(body) });
            }
            return bloques;
        },

        // Sanitiza tokens noise que vienen del LLM/backend (chunks de OCR, etc)
        // antes del rendering. Patrones conocidos:
        //   <imagen ...>, <img...>, <page_5>, <chunk_id 123>, <doc_id 5410>,
        //   <break>, </sep>, [[chunk_5]], {chunk_5}, etc.
        _sanitizeBackend(text) {
            if (!text || typeof text !== "string") return text;
            return text
                .replace(/<imagen[^>]*\/?>/gi, "")
                .replace(/<\/?img[^>]*>/gi, "")
                .replace(/<page[_\s-]?\d+[^>]*\/?>/gi, "")
                .replace(/<chunk[_\s-]?id[^>]*\/?>/gi, "")
                .replace(/<doc[_\s-]?id[^>]*\/?>/gi, "")
                .replace(/<\/?(break|sep|eos|bos|pad|s|cls|mask|unk)[^>]*>/gi, "")
                .replace(/\[\[\s*chunk[_\s-]?\d+\s*\]\]/gi, "")
                .replace(/\{\s*chunk[_\s-]?\d+\s*\}/gi, "")
                .replace(/<\|.+?\|>/gi, "")
                .replace(/[ \t]{2,}/g, " ")
                .replace(/\n{3,}/g, "\n\n")
                .trim();
        },

        // Preprocesa tablas markdown que estan dentro de listas anidadas.
        // El LLM Mistral genera tablas indentadas como hijas de bullets, lo que
        // marked.js trata como code block. Aqui las EXTRAEMOS al nivel raiz
        // con blank lines antes/despues para que marked las reconozca como GFM.
        _normalizarTablasMarkdown(text) {
            if (!text || !text.includes("|")) return text;
            const lines = text.split("\n");
            const out = [];
            let i = 0;
            while (i < lines.length) {
                const linea = lines[i];
                const trimmed = linea.trim();
                // Detectar inicio de tabla: linea con multiples | y siguiente linea es separator |---|
                if (trimmed.startsWith("|") && trimmed.endsWith("|") && (trimmed.match(/\|/g) || []).length >= 2) {
                    const sep = lines[i+1]?.trim() || "";
                    const isSeparator = /^\|[\s:\-|]+\|$/.test(sep);
                    if (isSeparator) {
                        // Es una tabla. Asegurar blank line previa y posterior y deindentar
                        if (out.length && out[out.length-1].trim() !== "") out.push("");
                        // Collectar todas las filas de la tabla
                        const tableLines = [linea.trim(), sep];
                        i += 2;
                        while (i < lines.length) {
                            const next = lines[i].trim();
                            if (next.startsWith("|") && next.endsWith("|")) {
                                tableLines.push(next);
                                i++;
                            } else break;
                        }
                        out.push(...tableLines);
                        out.push("");  // blank line posterior
                        continue;
                    }
                }
                out.push(linea);
                i++;
            }
            return out.join("\n");
        },

        markdownToHtml(text) {
            if (!text) return "";
            // 1) Sanitizar tokens noise
            text = this._sanitizeBackend(text);
            // 2) Normalizar tablas markdown (sacarlas de listas anidadas)
            text = this._normalizarTablasMarkdown(text);
            // Usa marked.js (CDN) + DOMPurify para producir HTML profesional
            // soporta: headings (#-######), tablas pipe, bullets, numbered lists,
            // bold, italic, code inline + bloques, blockquotes, links, etc.
            try {
                if (window.marked && window.DOMPurify) {
                    const raw = window.marked.parse(text, {
                        gfm: true,         // GitHub-flavored markdown (tablas, etc)
                        breaks: true,      // \n -> <br>
                        smartLists: true,
                        headerIds: false,  // no spam de ids
                    });
                    return window.DOMPurify.sanitize(raw, {
                        ADD_ATTR: ["target"],
                        ALLOWED_TAGS: [
                            "p","br","strong","em","u","s","del","ins","mark","sub","sup",
                            "h1","h2","h3","h4","h5","h6",
                            "ul","ol","li",
                            "table","thead","tbody","tr","th","td",
                            "code","pre","blockquote","a","span","div","hr","img"
                        ],
                        ALLOWED_ATTR: ["href","title","alt","src","class","colspan","rowspan"]
                    });
                }
            } catch (e) {
                console.warn("[markdown] marked/DOMPurify no disponibles, fallback parser:", e);
            }
            // Fallback: parser simple (legacy) por si el CDN no carga
            let html = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
            html = html.replace(/`([^`\n]+)`/g, "<code>$1</code>");
            html = html.replace(/\*\*([^*\n]+?)\*\*/g, "<strong>$1</strong>");
            return "<p>" + html.replace(/\n\n+/g, "</p><p>").replace(/\n/g, "<br>") + "</p>";
        },

        // ---------------- Modo batería QA ----------------
        async ejecutarBateria() {
            if (this.loading) return;
            const items = this.parseQaInput(this.qaPreguntas);
            if (items.length === 0) { this.lastError = "Pega al menos una pregunta"; return; }
            this.qaResultados = [];
            this.lastError = "";
            this.loading = true;
            for (let i = 0; i < items.length; i++) {
                const it = items[i];
                this.globalPasoActual = "QA " + (i + 1) + "/" + items.length + ": " + it.pregunta.substring(0, 40);
                let row = { pregunta: it.pregunta, toolEsperada: it.toolEsperada, toolObtenida: null, status: "error", msTotal: 0 };
                this._abortCtrl = new AbortController();
                try {
                    const payload = await this.callOrquestador(it.pregunta, null, null, this._abortCtrl.signal);
                    row.toolObtenida = payload.toolInvocada || null;
                    row.msTotal = (payload.telemetria && payload.telemetria.msTotal) || payload._wallMs;
                    if (!it.toolEsperada) row.status = payload.toolInvocada ? "pass" : "fail";
                    else row.status = (row.toolObtenida === it.toolEsperada) ? "pass" : "fail";
                } catch (err) {
                    row.status = "error";
                    row.toolObtenida = "ERR: " + (err.message || "").substring(0, 60);
                    if (err.name === "AbortError") { this.qaResultados.push(row); break; }
                }
                this.qaResultados.push(row);
                this.$nextTick(() => this.scrollQaTable());
            }
            this.loading = false; this.globalPasoActual = ""; this._abortCtrl = null;
        },
        parseQaInput(text) {
            if (!text) return [];
            const out = [];
            for (const raw of text.split(/\r?\n/)) {
                const line = raw.trim(); if (!line) continue;
                let pregunta = line, toolEsperada = null;
                const m = line.match(/^(.+?)\s*\|\s*tool\s*=\s*([A-Za-z_]+)\s*$/i);
                if (m) { pregunta = m[1].trim(); toolEsperada = m[2].trim(); }
                if (pregunta) out.push({ pregunta, toolEsperada });
            }
            return out;
        },
        exportarCsv() {
            if (this.qaResultados.length === 0) return;
            const rows = [["#", "pregunta", "tool_esperada", "tool_obtenida", "status", "ms_total"]];
            this.qaResultados.forEach((r, i) => rows.push([
                String(i + 1), this.csvCell(r.pregunta), this.csvCell(r.toolEsperada || ""),
                this.csvCell(r.toolObtenida || ""), r.status, String(r.msTotal),
            ]));
            const csv = rows.map(r => r.join(",")).join("\n");
            const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = "bateria_qa_" + new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19) + ".csv";
            document.body.appendChild(a); a.click(); document.body.removeChild(a);
            URL.revokeObjectURL(url);
        },
        csvCell(s) {
            const v = String(s || "");
            if (/[",\n]/.test(v)) return '"' + v.replace(/"/g, '""') + '"';
            return v;
        },

        // ---------------- Helpers ----------------
        focusInput() { try { this.$refs.input?.focus(); } catch (e) {} },
        scrollToBottom() {
            try { const el = this.$refs.feed; if (el) el.scrollTop = el.scrollHeight; } catch (e) {}
        },
        scrollQaTable() {
            try { const w = document.querySelector(".qa-table-wrap"); if (w) w.scrollTop = w.scrollHeight; } catch (e) {}
        },
    };
}

window.chatAssistant = chatAssistant;
