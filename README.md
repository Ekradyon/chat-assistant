# chat-assistant — SPA Asistente Hidrocarburos ANH

SPA externa Airflows que reemplaza la UI nativa `aia.ChatAssistant` para conversar con `BrainVtHidrocarburosAgent`, optimizada para:

1. **Telemetria inline** — tool elegido, ms, tokens, payload por turno (la UI nativa no lo expone)
2. **Plantilla institucional ANH renderizada** — los 5 bloques (RESPUESTA / FUENTE / ALCANCE / VIGENCIA / CONSIDERACIONES) + apendice CONTENIDO DE LOS DOCUMENTOS, con jerarquia visual y drawer del documento citado
3. **Selector tool override** (modo QA) — manipulacion del system prompt para forzar routing a una tool especifica, util para validacion de la matriz N1-N7
4. **Modo bateria QA** — corre lista de preguntas con asserts inline + export CSV
5. **Sin overhead UI nativa** — evita los 9 requests basura por turno (6 graphql + 1 features + 2 logo) que cuestan ~2-5s

## Stack

- Alpine.js (CDN local en `lib/alpine.min.js`)
- CSS plano con tokens (sin Bootstrap a menos que se necesite)
- Sin dependencias npm — WebPackage type=STATIC en Airflows
- Auth: JWT del usuario logueado (cookie de sesion + `?access_token=` querystring)
- Backend: reuso del proxy propietario `/api/ai/proxy/chat` (Mistral 14B local en anh-inf2:11434)

## Estructura

```
chat-assistant/
├── index.html       # entry point, layout shell
├── assets/
│   ├── app.css      # tokens + estilos
│   ├── app.js       # Alpine factory + logica chat
│   └── data.js      # constantes (URLs, tools, paleta)
├── lib/
│   └── alpine.min.js
├── scripts/         # placeholders/utilidades dev
├── build.ps1        # empaqueta a chat-assistant.zip
└── deploy.ps1       # sube WebPackage a Airflows
```

## Endpoint del proxy (referencia capturada 2026-05-09)

```
POST https://anh-pro.flows.ninja/api/ai/proxy/chat
Headers: Authorization: Bearer <JWT>, Content-Type: application/json
Body: {
  "targetUrl": "http://anh-inf2.flows.ninja:11434/v1/chat/completions",
  "model": 13238,                    // aia.Model.id
  "payload": {                       // OpenAI Chat Completions estandar
    "model": "ministral-3:14b",
    "max_tokens": 8000,
    "temperature": 0.1,
    "top_p": 0.9,
    "stream": true,
    "tools": [...7 tools OpenAI-style...],
    "tool_choice": "auto",
    "messages": [{role,content},...]
  }
}
Response: SSE OpenAI-compat (data: {chunks...})
```

Detalles completos en `reference_chat_assistant_airflows_endpoint.md`.

## Tools del agente (cargadas dinamicamente)

7 tools en `aia.AgentTool` asociadas a `BrainVtHidrocarburosAgent`:

| Nivel | Tool | Funcion PG |
|---|---|---|
| N1 | anhLookupSimple | IaCore.anhLookupSimple |
| N2 | anhAgregarHidrocarburos | IaCore.anhAgregarHidrocarburos |
| N3 | anhRecuperarVinculosHidrocarburos | IaCore.anhRecuperarVinculosHidrocarburos |
| N4 | anhGeoespacialHidrocarburos | IaCore.anhGeoespacialHidrocarburos |
| N5 | anhSerieTemporalHidrocarburos | IaCore.anhSerieTemporalHidrocarburos |
| N6 | anhBuscarImagenes3GHidrocarburos | IaCore.anhBuscarImagenes3GHidrocarburos |
| N7 | anhBuscarGeoVisorHidrocarburos | IaCore.buscarGeoVisor |

## Estado

- 2026-05-09: scaffold inicial creado. Pendiente: implementacion del flujo chat completo + render plantilla ANH + telemetria inline.
- Siguiente paso: definir el factory Alpine y el flujo de turnos LLM <-> tool.

## Referencias

- `feedback_deploy_webpackage_airflows.md` — patron deploy validado (vision-validation, ontology-viewer, pipeline-flow)
- `feedback_spa_access_token_querystring.md` — auth JWT en querystring
- `feedback_path_endpoints_functions_airflows.md` — POST /functions/<schema>.<func>
- `feedback_pipeline_flow_diseno_validado.md` — reglas UX de SPA (logo propio, mobile flow, dark mode tokens)
- `frontend-accessible` skill (~/.claude/skills/) — WCAG AA requerido por contrato
- `frontend-design-system` skill — tokens, estados, jerarquia
