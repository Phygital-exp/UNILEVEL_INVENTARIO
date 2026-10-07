const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const app = express();

// ========== CONFIGURACIÓN (variables de entorno en Railway) ==========
const PORT = process.env.PORT || 3000;
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
    pdv: `${API_BASE_URL}/pdv_unilevel`,
    productos: `${API_BASE_URL}/productos_unilevel`,
    registros: `${API_BASE_URL}/registro_inventario_unilevel`,
};

// ⚠️ PENDIENTE DE CONFIRMAR: usuarios_unilevel está vacía, nombres tomados del proyecto Nutresa
const CAMPO_CEDULA = "CEDULA";
// ⚠️ PENDIENTE: campo que relaciona al usuario con su punto de venta (pdv_unilevel no tiene cédula)
const CAMPO_PDV_EN_USUARIO = null;   // ej. "SAP" si el usuario trae el código SAP del PDV
const CAMPO_PDV_CLAVE = "SAP";       // campo de pdv_unilevel con el que se cruza

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

async function crearDocumento(url, doc) {
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

// ⚠️ PENDIENTE: falta saber cómo la API dinamic-db actualiza un documento existente
// (método, ruta y formato). No se inventa: se responde 501 hasta tenerlo confirmado.
async function actualizarDocumento(url, id, doc) {
    throw new ErrorApi(501, "La actualización de registros aún no está configurada en el servidor.");
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

async function buscarPuntoVenta(usuario) {
    if (!CAMPO_PDV_EN_USUARIO) {
        console.warn("⚠️ Sin relación usuario → punto de venta configurada; PUNTO_VENTA queda en null");
        return null;
    }
    const valor = usuario[CAMPO_PDV_EN_USUARIO];
    if (valor === undefined || valor === null) return null;

    const pdvs = await consultarColeccion(COLECCIONES.pdv);
    const pdv = pdvs.find(p => String(p[CAMPO_PDV_CLAVE]).trim() === String(valor).trim());
    if (!pdv) return null;

    return {
        CODIGO: String(pdv.SAP),
        NOMBRE: pdv.PDV,
        CIUDAD: pdv.CIUDAD,
    };
}

// ========== REGISTROS ==========
async function buscarRegistroPorId(id) {
    const registros = await consultarColeccion(COLECCIONES.registros);
    return registros.find(r => String(r._id) === String(id)) || null;
}

async function buscarRegistroPorCedula(cedula) {
    const registros = await consultarColeccion(COLECCIONES.registros);
    return registros.find(r => r.USUARIO && String(r.USUARIO.CEDULA) === cedula) || null;
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
        const existente = await buscarRegistroPorCedula(cedula);
        if (existente) {
            console.log(`♻️ Registro recuperado para ${cedula}: ${existente._id}`);
            return existente;
        }

        const usuario = await buscarUsuario(cedula);
        if (!usuario) throw new ErrorApi(404, "No encontramos tu cédula, verifícala e intenta de nuevo");

        const { _id, created, ...datosUsuario } = usuario;
        const fecha = ahora();
        const nuevo = {
            FECHA_REGISTRO: fecha,
            FECHA_ACTUALIZACION: fecha,
            USUARIO: { ...datosUsuario, CEDULA: cedula },
            PUNTO_VENTA: await buscarPuntoVenta(usuario),
            MARCAS: [],
        };

        await crearDocumento(COLECCIONES.registros, nuevo);

        // No dependemos del formato de respuesta del POST: releemos para obtener el _id real
        const creado = await buscarRegistroPorCedula(cedula);
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
        await actualizarDocumento(COLECCIONES.registros, id, reg);
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
        await actualizarDocumento(COLECCIONES.registros, id, reg);
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
