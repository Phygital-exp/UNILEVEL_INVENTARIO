const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const app = express();

// ========== CONFIGURACIÓN (variables de entorno en Railway) ==========
const PORT = process.env.PORT || 8080;
const API_TOKEN = process.env.API_TOKEN;
const API_BASE_URL = (process.env.API_BASE_URL ||
    "https://botai.smartdataautomation.com/api_backend_ai/dinamic-db/report/119").replace(/\/+$/, "");
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "https://phygital-exp.github.io")
    .split(",").map(o => o.trim().replace(/\/+$/, "")).filter(Boolean);

if (!API_TOKEN) {
    console.error("❌ Falta la variable de entorno API_TOKEN. Configúrala en Railway.");
    process.exit(1);
}

const AUTH_HEADERS = {
    Authorization: `Token ${API_TOKEN}`,
    "Content-Type": "application/json",
};

const COLECCIONES = {
    usuarios: `${API_BASE_URL}/usuarios_unilevel`,
    ingresosPdv: `${API_BASE_URL}/pdv_registro_unilevel`,
    productos: `${API_BASE_URL}/productos_unilevel`,
    registros: `${API_BASE_URL}/registro_inventario_unilevel`,
};

// Campo de cédula en usuarios_unilevel y pdv_registro_unilevel
const CAMPO_CEDULA = "CEDULA";
// Zona horaria para decidir qué ingresos son "de hoy"
const ZONA_HORARIA = "America/Bogota";

const CANTIDAD_MAXIMA = 999999;
const ESTADO_EN_PROCESO = "EN_PROCESO";
const ESTADO_FINALIZADA = "FINALIZADA";

// ========== CORS: solo GitHub Pages (y los orígenes configurados) ==========
app.use(cors({
    origin(origin, callback) {
        // Peticiones sin origen (curl, health checks de Railway) se permiten
        if (!origin || ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
        callback(new Error(`Origen no permitido por CORS: ${origin}`));
    },
}));
app.use(express.json({ limit: "100kb" }));

// ========== UTILIDADES ==========
class ErrorApi extends Error {
    constructor(status, mensaje, extra = {}) {
        super(mensaje);
        this.status = status;
        this.extra = extra;
    }
}

// Envuelve los handlers async para que los errores lleguen al manejador central
const manejar = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const ahora = () => new Date().toISOString();

// Limpia espacios dobles y finales ("REXONA " -> "REXONA", "3D  LIQ" -> "3D LIQ")
const normalizarMarca = marca => String(marca || "").trim().replace(/\s+/g, " ").toUpperCase();

const soloDigitos = valor => /^\d+$/.test(String(valor || "").trim());

async function consultarColeccion(url) {
    const response = await fetch(url, { headers: AUTH_HEADERS });
    if (!response.ok) {
        const errorBody = await response.text();
        console.error(`❌ ${url} respondió ${response.status}:`, errorBody);
        throw new ErrorApi(502, "No pudimos consultar la información. Intenta de nuevo.");
    }
    const data = await response.json();
    return Array.isArray(data.result) ? data.result : [];
}

// La API dinamic-db usa POST para todo:
//  - sin _id  -> crea el documento y responde { status: "ok", insert_id: "..." }
//  - con _id  -> actualiza ese documento; los campos deben llamarse EXACTAMENTE igual
//                que en la base, si no se crea un registro nuevo
async function enviarDocumento(url, doc) {
    const response = await fetch(url, {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify(doc),
    });
    if (!response.ok) {
        const errorBody = await response.text();
        console.error(`❌ POST ${url} respondió ${response.status}:`, errorBody);
        throw new ErrorApi(502, "No pudimos guardar la información. Intenta de nuevo.");
    }
    return response.json().catch(() => ({}));
}

async function crearDocumento(url, doc) {
    const { _id, ...sinId } = doc;
    const data = await enviarDocumento(url, sinId);
    return data && data.insert_id ? String(data.insert_id) : null;
}

async function actualizarDocumento(url, id, campos) {
    const data = await enviarDocumento(url, { _id: String(id), ...campos });
    if (data && data.insert_id && String(data.insert_id) !== String(id)) {
        console.warn(`⚠️ Se esperaba actualizar ${id} pero la API creó ${data.insert_id}. Revisa los nombres de campos.`);
    }
}

// "YYYY-MM-DD" en hora de Colombia. Los "created" de la base vienen en UTC sin zona.
function diaLocal(fecha) {
    const texto = String(fecha || "");
    const d = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(texto) ? texto : `${texto}Z`);
    if (Number.isNaN(d.getTime())) return null;
    return new Intl.DateTimeFormat("en-CA", { timeZone: ZONA_HORARIA }).format(d);
}

// Serializa las operaciones sobre un mismo registro para no pisar cambios simultáneos
const bloqueos = new Map();
function conBloqueo(clave, fn) {
    const anterior = bloqueos.get(clave) || Promise.resolve();
    const actual = anterior.catch(() => {}).then(fn);
    const cola = actual.catch(() => {});
    bloqueos.set(clave, cola);
    cola.then(() => { if (bloqueos.get(clave) === cola) bloqueos.delete(clave); });
    return actual;
}

// ========== PRODUCTOS (con caché corta: el catálogo cambia poco) ==========
const CACHE_PRODUCTOS_MS = 5 * 60 * 1000;
let cacheProductos = { datos: null, expira: 0 };

async function obtenerProductos() {
    if (cacheProductos.datos && Date.now() < cacheProductos.expira) return cacheProductos.datos;

    const crudos = await consultarColeccion(COLECCIONES.productos);
    const datos = crudos
        .filter(p => p._id && p.MARCA)
        .map(p => ({
            PRODUCTO_ID: String(p._id),
            MARCA: normalizarMarca(p.MARCA),
            DESC: String(p.DESC || "").trim(),
            EAN: p["EAN 13"] !== undefined && p["EAN 13"] !== null ? String(p["EAN 13"]) : "",
        }))
        .sort((a, b) => a.DESC.localeCompare(b.DESC, "es"));

    cacheProductos = { datos, expira: Date.now() + CACHE_PRODUCTOS_MS };
    return datos;
}

async function productosDeMarca(marca) {
    const objetivo = normalizarMarca(marca);
    return (await obtenerProductos()).filter(p => p.MARCA === objetivo);
}

// ========== USUARIOS Y PUNTO DE VENTA ==========
async function buscarUsuario(cedula) {
    const usuarios = await consultarColeccion(COLECCIONES.usuarios);
    return usuarios.find(u =>
        u[CAMPO_CEDULA] !== undefined && u[CAMPO_CEDULA] !== null &&
        u[CAMPO_CEDULA].toString().trim() === cedula
    ) || null;
}

// Día del ingreso: FECHA_REGISTRO ya viene en fecha local ("2026-10-07T00:00:00");
// si no viene, se usa "created" (UTC) convertido a hora de Colombia
function diaDeIngreso(ingreso) {
    const fecha = String(ingreso.FECHA_REGISTRO || "");
    return /^\d{4}-\d{2}-\d{2}/.test(fecha) ? fecha.slice(0, 10) : diaLocal(ingreso.created);
}

// El chatbot registra en pdv_registro_unilevel a qué punto va la persona.
// Se toma el ingreso MÁS RECIENTE de HOY para esa cédula.
async function buscarIngresoDeHoy(cedula) {
    const hoy = diaLocal(new Date().toISOString());
    const ingresos = await consultarColeccion(COLECCIONES.ingresosPdv);
    return ingresos
        .filter(i =>
            i[CAMPO_CEDULA] !== undefined && i[CAMPO_CEDULA] !== null &&
            i[CAMPO_CEDULA].toString().trim() === cedula &&
            diaDeIngreso(i) === hoy
        )
        .sort((a, b) => String(b.created).localeCompare(String(a.created)))[0] || null;
}

// pdv_registro_unilevel: { SAP, PDV, CIUDAD, CEDULA, NOMBRE, TELEFONO, FECHA_REGISTRO, created }
function puntoVentaDesdeIngreso(ingreso) {
    return {
        INGRESO_ID: String(ingreso._id),
        CODIGO: ingreso.SAP !== undefined && ingreso.SAP !== null ? String(ingreso.SAP) : null,
        NOMBRE: ingreso.PDV ?? null,
        CIUDAD: ingreso.CIUDAD ?? null,
        FECHA_INGRESO: ingreso.FECHA_REGISTRO || ingreso.created || null,
    };
}

// ========== REGISTROS ==========
async function buscarRegistroPorId(id) {
    const registros = await consultarColeccion(COLECCIONES.registros);
    return registros.find(r => String(r._id) === String(id)) || null;
}

// Un registro de inventario por cada ingreso al punto de venta (cédula + ingreso del chatbot)
async function buscarRegistroPorIngreso(cedula, ingresoId) {
    const registros = await consultarColeccion(COLECCIONES.registros);
    return registros.find(r =>
        r.USUARIO && String(r.USUARIO.CEDULA) === cedula &&
        r.PUNTO_VENTA && String(r.PUNTO_VENTA.INGRESO_ID) === ingresoId
    ) || null;
}

async function obtenerRegistroOError(id) {
    const registro = await buscarRegistroPorId(id);
    if (!registro) throw new ErrorApi(404, "No encontramos tu registro de inventario. Vuelve a ingresar tu cédula.");
    if (!Array.isArray(registro.MARCAS)) registro.MARCAS = [];
    return registro;
}

// ========== ENDPOINTS ==========

// Paso 1: validar cédula
app.get("/api/usuarios/:cedula", manejar(async (req, res) => {
    const cedula = String(req.params.cedula || "").trim();
    if (!soloDigitos(cedula)) {
        throw new ErrorApi(400, "La cédula solo debe tener números.");
    }

    console.log(`🔎 Validando cédula: ${cedula}`);
    const usuario = await buscarUsuario(cedula);

    if (!usuario) {
        return res.json({ existe: false, mensaje: "No encontramos tu cédula, verifícala e intenta de nuevo" });
    }
    res.json({ existe: true, usuario });
}));

// Paso 1 (confirmado "Sí, soy yo"): crea o recupera el registro único de la persona
app.post("/api/registros", manejar(async (req, res) => {
    const cedula = String((req.body && req.body.cedula) || "").trim();
    if (!soloDigitos(cedula)) {
        throw new ErrorApi(400, "La cédula solo debe tener números.");
    }

    const registro = await conBloqueo(`cedula:${cedula}`, async () => {
        const usuario = await buscarUsuario(cedula);
        if (!usuario) throw new ErrorApi(404, "No encontramos tu cédula, verifícala e intenta de nuevo");

        const ingreso = await buscarIngresoDeHoy(cedula);
        if (!ingreso) {
            throw new ErrorApi(404,
                "No encontramos tu ingreso a un punto de venta hoy. Primero indica en el chatbot a qué punto vas.");
        }
        const ingresoId = String(ingreso._id);

        const existente = await buscarRegistroPorIngreso(cedula, ingresoId);
        if (existente) {
            console.log(`♻️ Registro recuperado para ${cedula}: ${existente._id}`);
            return existente;
        }

        const { _id, created, ...datosUsuario } = usuario;
        const fecha = ahora();
        const nuevo = {
            FECHA_REGISTRO: fecha,
            FECHA_ACTUALIZACION: fecha,
            USUARIO: { ...datosUsuario, CEDULA: cedula },
            PUNTO_VENTA: puntoVentaDesdeIngreso(ingreso),
            MARCAS: [],
        };

        const insertId = await crearDocumento(COLECCIONES.registros, nuevo);
        const creado = insertId
            ? { _id: insertId, ...nuevo }
            : await buscarRegistroPorIngreso(cedula, ingresoId); // respaldo si no llega insert_id
        if (!creado) throw new ErrorApi(502, "No pudimos crear tu registro. Intenta de nuevo.");
        console.log(`🆕 Registro creado para ${cedula}: ${creado._id}`);
        return creado;
    });

    res.json({ registro });
}));

// Recuperar progreso
app.get("/api/registros/:id", manejar(async (req, res) => {
    res.json({ registro: await obtenerRegistroOError(req.params.id) });
}));

// Paso 2: marcas únicas en orden alfabético
app.get("/api/marcas", manejar(async (req, res) => {
    const conteo = new Map();
    for (const p of await obtenerProductos()) {
        conteo.set(p.MARCA, (conteo.get(p.MARCA) || 0) + 1);
    }
    const marcas = [...conteo.entries()]
        .map(([MARCA, TOTAL_PRODUCTOS]) => ({ MARCA, TOTAL_PRODUCTOS }))
        .sort((a, b) => a.MARCA.localeCompare(b.MARCA, "es"));
    res.json({ marcas });
}));

// Paso 3: productos de una marca
app.get("/api/productos", manejar(async (req, res) => {
    const marca = normalizarMarca(req.query.marca);
    if (!marca) throw new ErrorApi(400, "Debes indicar la marca.");
    res.json({ marca, productos: await productosDeMarca(marca) });
}));

// Paso 3: guardar o editar la cantidad de un producto
app.put("/api/registros/:id/producto", manejar(async (req, res) => {
    const id = req.params.id;
    const { productoId, cantidad } = req.body || {};

    const textoCantidad = String(cantidad ?? "").trim();
    if (!/^\d+$/.test(textoCantidad) || Number(textoCantidad) > CANTIDAD_MAXIMA) {
        throw new ErrorApi(400, "La cantidad debe ser un número entero igual o mayor a 0.");
    }
    const valor = Number(textoCantidad);

    const producto = (await obtenerProductos()).find(p => p.PRODUCTO_ID === String(productoId));
    if (!producto) throw new ErrorApi(404, "Este producto no existe en el catálogo.");

    const registro = await conBloqueo(`registro:${id}`, async () => {
        const reg = await obtenerRegistroOError(id);
        const fecha = ahora();

        let marca = reg.MARCAS.find(m => normalizarMarca(m.MARCA) === producto.MARCA);
        if (marca && marca.ESTADO === ESTADO_FINALIZADA) {
            throw new ErrorApi(409, `La marca ${producto.MARCA} ya fue finalizada y no se puede editar.`);
        }
        if (!marca) {
            marca = { MARCA: producto.MARCA, ESTADO: ESTADO_EN_PROCESO, FECHA_FINALIZACION: null, PRODUCTOS: [] };
            reg.MARCAS.push(marca);
        }
        if (!Array.isArray(marca.PRODUCTOS)) marca.PRODUCTOS = [];

        const item = {
            PRODUCTO_ID: producto.PRODUCTO_ID,
            EAN: producto.EAN,
            DESC: producto.DESC,
            MARCA: producto.MARCA,
            CANTIDAD: valor,
            FECHA_ACTUALIZACION: fecha,
        };
        const indice = marca.PRODUCTOS.findIndex(p => String(p.PRODUCTO_ID) === producto.PRODUCTO_ID);
        if (indice >= 0) marca.PRODUCTOS[indice] = item;
        else marca.PRODUCTOS.push(item);

        reg.FECHA_ACTUALIZACION = fecha;
        await actualizarDocumento(COLECCIONES.registros, id, {
            MARCAS: reg.MARCAS,
            FECHA_ACTUALIZACION: fecha,
        });
        return reg;
    });

    console.log(`💾 ${id} · ${producto.MARCA} · ${producto.EAN} = ${valor}`);
    res.json({ registro });
}));

// Paso 3: finalizar marca (después de esto el servidor rechaza cualquier cambio en ella)
app.post("/api/registros/:id/marcas/:marca/finalizar", manejar(async (req, res) => {
    const id = req.params.id;
    const nombreMarca = normalizarMarca(req.params.marca);

    const catalogo = await productosDeMarca(nombreMarca);
    if (catalogo.length === 0) throw new ErrorApi(404, "Esta marca no existe en el catálogo.");

    const registro = await conBloqueo(`registro:${id}`, async () => {
        const reg = await obtenerRegistroOError(id);
        const marca = reg.MARCAS.find(m => normalizarMarca(m.MARCA) === nombreMarca);

        if (marca && marca.ESTADO === ESTADO_FINALIZADA) {
            throw new ErrorApi(409, `La marca ${nombreMarca} ya estaba finalizada.`);
        }

        const registrados = new Set(
            ((marca && marca.PRODUCTOS) || [])
                .filter(p => Number.isInteger(p.CANTIDAD) && p.CANTIDAD >= 0)
                .map(p => String(p.PRODUCTO_ID))
        );
        const faltantes = catalogo.filter(p => !registrados.has(p.PRODUCTO_ID));
        if (faltantes.length > 0) {
            throw new ErrorApi(409, `Te faltan ${faltantes.length} productos por registrar.`, { faltantes });
        }

        const fecha = ahora();
        marca.ESTADO = ESTADO_FINALIZADA;
        marca.FECHA_FINALIZACION = fecha;
        reg.FECHA_ACTUALIZACION = fecha;
        await actualizarDocumento(COLECCIONES.registros, id, {
            MARCAS: reg.MARCAS,
            FECHA_ACTUALIZACION: fecha,
        });
        return reg;
    });

    console.log(`✅ ${id} · marca ${nombreMarca} finalizada`);
    res.json({ registro });
}));

// ========== HEALTH CHECK ==========
app.get("/health", (req, res) => {
    res.json({ status: "OK", timestamp: ahora() });
});

// ========== 404 Y ERRORES ==========
app.use((req, res) => {
    res.status(404).json({ error: "Ruta no encontrada" });
});

app.use((err, req, res, next) => {
    if (err instanceof ErrorApi) {
        return res.status(err.status).json({ error: err.message, ...err.extra });
    }
    if (err.type === "entity.parse.failed") {
        return res.status(400).json({ error: "Los datos enviados no son válidos." });
    }
    if (err.message && err.message.startsWith("Origen no permitido")) {
        return res.status(403).json({ error: err.message });
    }
    console.error("❌ Error inesperado:", err);
    res.status(500).json({ error: "Ocurrió un error inesperado. Intenta de nuevo." });
});

app.listen(PORT, () => {
    console.log(`🚀 Proxy de inventario escuchando en puerto ${PORT}`);
    console.log(`🌐 CORS permitido para: ${ALLOWED_ORIGINS.join(", ")}`);
    console.log(`📍 Endpoints disponibles:`);
    console.log(`   - GET  /api/usuarios/:cedula`);
    console.log(`   - POST /api/registros`);
    console.log(`   - GET  /api/registros/:id`);
    console.log(`   - GET  /api/marcas`);
    console.log(`   - GET  /api/productos?marca=DOVE`);
    console.log(`   - PUT  /api/registros/:id/producto`);
    console.log(`   - POST /api/registros/:id/marcas/:marca/finalizar`);
    console.log(`   - GET  /health`);
});
