import { insertarFlowSensor1A } from "../main_sql_local/src/controllers/flowsensors.js";
import { obtenerUltimoNivelTabla } from "../main_sql_local/src/controllers/queries.js";
import { readHoldingRegisters } from "./src/functions/modbusRead.js";
import cron from "cron";

// Función para convertir dos registros (Big Endian) a un valor de 32 bits float
function convertTo32BitFloatBigEndian(high, low) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt16BE(high, 0);
  buffer.writeUInt16BE(low, 2);
  return buffer.readFloatBE(0);
}

async function main() {
  const ip = "192.168.7.18";
  const port = 502;
  const slaveId = 1;

  // Configuración para leer los registros correctos que representan el Flow Rate
  const startRegister = 0;
  const numRegisters = 2;

  // Leer registros de Modbus
  const registerValues = await readHoldingRegisters(
    ip,
    port,
    slaveId,
    startRegister,
    numRegisters
  );
  const calidadRaw = await readHoldingRegisters(ip, port, slaveId, 91);
  const kw = await readHoldingRegisters("192.168.7.10", 502, 1, 307);
  if (registerValues && registerValues.length >= 2) {
    const lowRegisterValue = registerValues[0];
    const highRegisterValue = registerValues[1];

    // Conversión a float de 32 bits en Big Endian
    const flowRate_m3_h = convertTo32BitFloatBigEndian(
      highRegisterValue,
      lowRegisterValue
    );
    const calidad = calidadRaw / 10;

    console.log(
      `Flow Rate (Big Endian) leído del sensor: ${flowRate_m3_h} m³/h`
    );
    console.log(`Calidad del sensor (Register 91): ${calidad}`);
    console.log(`kw de 1A: ${kw}`);
    let nivel = null;
    try {
      nivel = await obtenerUltimoNivelTabla("nivel1a");
      if (nivel !== null) {
        console.log("El último nivel obtenido es:", nivel);
      }
    } catch (error) {
      console.error(
        "Error al intentar obtener el último nivel:",
        error.message
      );
    }

    // Llamar a la función para insertar en la base de datos con los valores obtenidos, incluyendo nivel
    try {
      await insertarFlowSensor1A(flowRate_m3_h, calidad, kw, nivel);
      console.log("Inserción de datos completada con éxito.");
    } catch (error) {
      console.error("Error al intentar insertar datos:", error.message);
    }
  } else {
    console.log("No se pudieron leer los registros necesarios.");
  }
}

// Configuración del cron job para que se ejecute cada 30 segundos
const job = new cron.CronJob("*/2 * * * *", () => {
  console.log("Ejecutando tarea programada cada 2 minutos");
  main(); // Llamada a la función principal
});

// Iniciar el cron job
job.start();
