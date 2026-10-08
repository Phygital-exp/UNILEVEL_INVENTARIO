# Inventario por marca – Web

Front de la toma de inventario por marca. HTML + CSS + JavaScript sin frameworks, publicado en GitHub Pages.
Solo habla con el proxy de Railway (rama `Proxy`); nunca con la base directamente.

## Archivos
| Archivo | Para qué |
|---|---|
| `config.js` | **Única** configuración: URL del proxy y rutas de cada endpoint. |
| `index.html` | Estructura de los 3 pasos, modal y avisos. |
| `styles.css` | Estilos mobile-first (tarjetas en celular, tabla en computador). |
| `app.js` | Lógica: identificación, marcas, cantidades, finalizar marca. |

## Flujo
1. **Identificación:** cédula → `GET /api/usuarios/:cedula` → confirmación "¿Eres…?" → `POST /api/registros` (crea o recupera el registro del ingreso de hoy).
2. **Marca:** `GET /api/marcas`; las finalizadas salen deshabilitadas.
3. **Cantidades:** `GET /api/productos?marca=` · guardar/editar con `PUT /api/registros/:id/producto` · cerrar con `POST /api/registros/:id/marcas/:marca/finalizar`.

Si se recarga la página el mismo día, se recupera el progreso con `GET /api/registros/:id`.

## Publicar en GitHub Pages
Settings → Pages → *Deploy from a branch* → rama `Web`, carpeta `/ (root)`.
La URL queda en `https://phygital-exp.github.io/UNILEVEL_INVENTARIO/`; el proxy ya permite ese origen por CORS.
