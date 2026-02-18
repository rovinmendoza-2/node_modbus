import ModbusRTU from "modbus-serial";
import moment from "moment-timezone";

// --- Configuración Modbus ---
const PLC_IP = "192.168.14.11";
const MODBUS_PORT = 502;
const SLAVE_ID = 1;
const CONNECT_TIMEOUT = 5000;
const READ_TIMEOUT = 3000;
const ZONA_HORARIA = "America/Tegucigalpa";

// --- Direcciones de los tanques ---
const DIRECCIONES = {
  DIRECCION_1: { addr: 41, desc: "Direccion de lavanderia" },
  DIRECCION_2: { addr: 199, desc: "Direccion 2" },
  DIRECCION_3: { addr: 230, desc: "Direccion 3" },
};

async function leerNivelesTanques() {
  const client = new ModbusRTU();
  let conectado = false;

  try {
    console.log(
      `[${moment().tz(ZONA_HORARIA).format()}] Conectando a ${PLC_IP}...`
    );

    client.setTimeout(CONNECT_TIMEOUT);
    await client.connectTCP(PLC_IP, { port: MODBUS_PORT });
    client.setID(SLAVE_ID);
    conectado = true;
    client.setTimeout(READ_TIMEOUT);

    console.log(
      `[${moment()
        .tz(ZONA_HORARIA)
        .format()}] ========== Datos de las direcciones: ==========`
    );

    for (const [key, config] of Object.entries(DIRECCIONES)) {
      try {
        const result = await client.readHoldingRegisters(config.addr, 1);
        const nivel = result.data[0];
        console.log(
          `[${moment().tz(ZONA_HORARIA).format()}] ${config.desc}: ${nivel}`
        );
      } catch (readError) {
        console.error(
          `[${moment().tz(ZONA_HORARIA).format()}] ERROR al leer ${
            config.desc
          } (addr: ${config.addr}): ${readError.message}`
        );
      }
    }

    console.log(
      `[${moment()
        .tz(ZONA_HORARIA)
        .format()}] ==========================================`
    );
  } catch (connectError) {
    console.error(
      `[${moment()
        .tz(ZONA_HORARIA)
        .format()}] ERROR al conectar con ${PLC_IP}: ${connectError.message}`
    );
  } finally {
    if (conectado && client.isOpen) {
      try {
        await client.close(() => {});
        console.log(
          `[${moment().tz(ZONA_HORARIA).format()}] Conexión cerrada.`
        );
      } catch (closeError) {
        console.error(
          `[${moment().tz(ZONA_HORARIA).format()}] Error al cerrar conexión: ${
            closeError.message
          }`
        );
      }
    }
  }
}

// Ejecutar consulta
leerNivelesTanques().catch((error) => {
  console.error(
    `[${moment().tz(ZONA_HORARIA).format()}] ERROR FATAL: ${error.message}`
  );
  process.exit(1);
});
