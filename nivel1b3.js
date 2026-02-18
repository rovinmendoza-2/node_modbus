import moment from "moment-timezone";
import cron from "cron";
// Pool de BD
import { poolNiveles } from "../main_sql_local/database.js";
// Lectura Modbus
import { readHoldingRegisters } from "./src/functions/modbusRead.js";

/* =========================
   Configuración Global
   ========================= */
const ZONA_HORARIA = "America/Tegucigalpa";
const VALOR_FALLO = -1;

// Conexión Modbus común
const MODBUS_COMUN = {
  IP: "192.168.6.18",
  PORT: 502,
  SLAVE_ID: 1,
};

// Conexión Modbus para lavandería
const MODBUS_LAVANDERIA = {
  IP: "192.168.14.11",
  PORT: 502,
  SLAVE_ID: 1,
};

/* =========================
   Sensores (por tanque)
   - Define computeNivel(raw) por sensor
   ========================= */
const SENSORES = [
  {
    nombre: "1b3",
    descripcion: "Nivel tanque 1b3",
    register: 103, // Dirección para 1b3
    tabla: "nivel1b3",
    modbus: MODBUS_COMUN,
    computeNivel: (raw) => raw, // SE RESTA 369 AQUÍ
  },
  {
    nombre: "1b2",
    descripcion: "Nivel tanque 1b2",
    register: 51, // 400052 -> 51 si tu lib es 0-based
    tabla: "nivel1b2",
    modbus: MODBUS_COMUN,
    computeNivel: (raw) => raw, // NO SE RESTA NADA
  },
  {
    nombre: "lavanderia",
    descripcion: "Nivel lavandería",
    register: 41, // 4:0042 -> 41 (0-based)
    tabla: "nivel_lavanderia",
    modbus: MODBUS_LAVANDERIA,
    computeNivel: (raw) => raw, // Sin transformación por ahora
  },
];

// Evitar reprocesar el mismo minuto
let ultimoMinutoProcesado = null;

/* =========================
   Utilitarios
   ========================= */
const ahora = () => moment().tz(ZONA_HORARIA).format();
const timestampActualStr = () =>
  moment().tz(ZONA_HORARIA).format("YYYY-MM-DD HH:mm:ss");

async function leerModbusSeguro({ descripcion, register, modbus }) {
  try {
    console.log(
      `[${ahora()}] Intentando leer: ${descripcion} (${
        modbus.IP
      }:${register})`
    );
    const res = await readHoldingRegisters(
      modbus.IP,
      modbus.PORT,
      modbus.SLAVE_ID,
      register
    );
    if (res && res.length > 0) {
      const valor = res[0];
      console.log(`[${ahora()}] ✅ Éxito (${descripcion}): ${valor}`);
      return valor;
    }
    console.warn(
      `[${ahora()}] ⚠️ Respuesta inesperada o vacía en (${descripcion}).`
    );
    return VALOR_FALLO;
  } catch (e) {
    console.warn(
      `[${ahora()}] ❌ Error Modbus (${descripcion} - ${
        modbus.IP
      }:${register}): ${e.message}`
    );
    return VALOR_FALLO;
  }
}

async function registrarDatos({
  tabla,
  timestamp,
  nivelCalculado,
  valorOriginal,
}) {
  console.log(
    `[${ahora()}] Intentando registrar datos (${tabla}) para ${timestamp}...`
  );
  try {
    const sql = `
      INSERT INTO ${tabla} (fecha, nivel)
      VALUES (?, ?)
      ON DUPLICATE KEY UPDATE nivel = VALUES(nivel)
    `;
    const values = [timestamp, nivelCalculado];

    console.log(
      `[${ahora()}] SQL (${tabla}): Fecha=${timestamp}, Nivel=${nivelCalculado} (original=${valorOriginal})`
    );

    const [result] = await poolNiveles.query(sql, values);

    if (result.affectedRows > 0) {
      if (result.insertId > 0) {
        console.log(
          `[${ahora()}] ✅ INSERT en ${tabla} para ${timestamp} (ID=${
            result.insertId
          }).`
        );
      } else {
        console.log(`[${ahora()}] ✅ UPDATE en ${tabla} para ${timestamp}.`);
      }
    } else {
      console.log(`[${ahora()}] ℹ️ Sin cambios en ${tabla} para ${timestamp}.`);
    }
    return true;
  } catch (e) {
    console.error(
      `[${ahora()}] ❌ Error CRÍTICO al registrar en ${tabla} para ${timestamp}: ${
        e.message
      }`
    );
    return false;
  }
}

/* =========================
   Ejecución por sensor
   ========================= */
async function procesarSensor(sensor, timestamp) {
  const { descripcion, tabla, computeNivel } = sensor;

  const valorOriginal = await leerModbusSeguro(sensor);

  let nivelCalculado = VALOR_FALLO;
  if (valorOriginal !== VALOR_FALLO) {
    try {
      nivelCalculado = computeNivel(valorOriginal);
      console.log(
        `[${ahora()}] (${tabla}) Cálculo: computeNivel(${valorOriginal}) = ${nivelCalculado}`
      );
      if (!Number.isFinite(nivelCalculado)) {
        console.warn(
          `[${ahora()}] ⚠️ (${tabla}) Resultado no numérico/finito. Se marcará como fallo.`
        );
        nivelCalculado = VALOR_FALLO;
      }
    } catch (e) {
      console.warn(
        `[${ahora()}] ⚠️ (${tabla}) Error en computeNivel: ${
          e.message
        }. Se marcará como fallo.`
      );
      nivelCalculado = VALOR_FALLO;
    }
  } else {
    console.error(
      `[${ahora()}] ❌ (${tabla}) No se pudo leer valor original. Se registrará fallo.`
    );
  }

  await registrarDatos({ tabla, timestamp, nivelCalculado, valorOriginal });
}

/* =========================
   Lógica principal
   ========================= */
async function ejecutarLecturas() {
  const timestamp = timestampActualStr();
  if (timestamp === ultimoMinutoProcesado) {
    console.log(`[${ahora()}] Timestamp ${timestamp} ya procesado. Saltando.`);
    return;
  }

  console.log(`[${ahora()}] --- Iniciando ciclo para ${timestamp} ---`);
  ultimoMinutoProcesado = timestamp;

  const tareas = SENSORES.map((s) => procesarSensor(s, timestamp));
  const resultados = await Promise.allSettled(tareas);

  resultados.forEach((r, i) => {
    const { tabla } = SENSORES[i];
    if (r.status === "rejected") {
      console.error(
        `[${ahora()}] ❌ FATAL en procesamiento de ${tabla}:`,
        r.reason
      );
    } else {
      console.log(`[${ahora()}] ✅ Finalizado procesamiento de ${tabla}`);
    }
  });

  console.log(`[${ahora()}] --- Ciclo para ${timestamp} completado ---`);
}

/* =========================
   Cron
   ========================= */
console.log(`[${ahora()}] Configurando Cron job (1b3, 1b2 & lavandería) cada minuto...`);
const job = new cron.CronJob(
  "0 * * * * *", // segundo 0 de cada minuto
  () => {
    console.log(`\n[${ahora()}] --- Cron Job Disparado (1b3, 1b2 & lavandería) ---`);
    ejecutarLecturas().catch((error) => {
      console.error(
        `[${ahora()}] Error FATAL no capturado en ejecutarLecturas:`,
        error
      );
    });
  },
  null,
  false,
  ZONA_HORARIA
);

// Arranque
job.start();
console.log(
  `[${ahora()}] Cron job iniciado. Esperando la primera ejecución...`
);

// Opcional: ejecución inmediata
console.log(`[${ahora()}] Ejecutando una vez inmediatamente para prueba...`);
ejecutarLecturas().catch((error) => {
  console.error(
    `[${ahora()}] Error FATAL no capturado en la ejecución inicial:`,
    error
  );
});
