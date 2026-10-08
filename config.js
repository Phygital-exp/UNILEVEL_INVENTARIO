// ========== CONFIGURACIÓN DEL FRONT ==========
// Único lugar donde se definen las URLs del backend (proxy en Railway).
window.APP_CONFIG = {
    API_BASE_URL: "https://unilevelinventario-production.up.railway.app",

    RUTAS: {
        usuario: cedula => `/api/usuarios/${encodeURIComponent(cedula)}`,
        crearRegistro: () => "/api/registros",
        registro: id => `/api/registros/${encodeURIComponent(id)}`,
        marcas: () => "/api/marcas",
        productos: marca => `/api/productos?marca=${encodeURIComponent(marca)}`,
        guardarProducto: id => `/api/registros/${encodeURIComponent(id)}/producto`,
        finalizarMarca: (id, marca) =>
            `/api/registros/${encodeURIComponent(id)}/marcas/${encodeURIComponent(marca)}/finalizar`,
    },

    // Tiempo máximo de espera por petición (ms)
    TIMEOUT_MS: 25000,
};
