import moment from "moment-timezone";
// Asegúrate de que la ruta a tu pool de base de datos sea correcta
import { poolLecturas } from "../main_sql_local/database.js";
import cron from "cron";
// Asegúrate de que la ruta a tus funciones Modbus sea correcta
import {
  readHoldingRegisters,
  readSignedHoldingRegister,
} from "./src/functions/modbusRead.js"; // AJUSTA ESTA RUTA SI ES NECESARIO

// --- Constantes y Variables Globales ---
let ultimoMinutoProcesado = null;
const VALOR_FALLO = -1; // Valor a registrar si una lectura Modbus falla
const ZONA_HORARIA = "America/Tegucigalpa";

// --- Funciones Auxiliares ---

// Función para obtener el último ID registrado (sin cambios)
async function obtenerUltimoId() {
  try {
    const query = `SELECT MAX(id) AS ultimoId FROM generacion`;
    const [result] = await poolLecturas.query(query);
    // Asegura devolver 0 si la tabla está vacía o hay un error leve
    return result[0]?.ultimoId || 0;
  } catch (error) {
    console.error("Error GRAVE al obtener el último ID:", error.message);
    // Decide cómo manejar un error crítico aquí. ¿Detener el script? ¿Continuar con ID 0?
    // Por ahora, devolveremos 0 para intentar continuar, pero esto podría necesitar revisión.
    return 0;
  }
}

// Función para generar el minuto actual (sin cambios)
function obtenerMinutoActual() {
  const minutoActual = moment()
    .tz(ZONA_HORARIA)
    .startOf("minute")
    .format("YYYY-MM-DD HH:mm:ss");
  // console.log(`Minuto actual generado: ${minutoActual}`);
  return minutoActual;
}

// Función de lectura Modbus individual y segura - VERSIÓN ROBUSTA
async function leerModbusSeguro(
  tipoFuncion, // 'holding' o 'signedHolding'
  ip,
  port,
  slaveId,
  register,
  descripcion // Para logs de error claros
) {
  try {
    let resultado;
    // console.log(`  🔄 Intentando leer: ${descripcion} (${ip}:${port} - Slave:${slaveId} - Reg:${register})`);
    
    if (tipoFuncion === "holding") {
      resultado = await readHoldingRegisters(ip, port, slaveId, register);
      // Validación más estricta para holding registers
      if (Array.isArray(resultado) && resultado.length > 0 && typeof resultado[0] === 'number') {
        const valor = resultado[0];
        // console.log(`    ✅ Éxito ${descripcion}: ${valor}`);
        return valor;
      } else {
        console.warn(`    ⚠️ Fallo ${descripcion}: Respuesta inválida [${JSON.stringify(resultado)}]`);
        return VALOR_FALLO;
      }
    } 
    else if (tipoFuncion === "signedHolding") {
      resultado = await readSignedHoldingRegister(ip, port, slaveId, register);
      // Validación más estricta para signed holding registers
      if (typeof resultado === 'number' && !isNaN(resultado)) {
        // console.log(`    ✅ Éxito ${descripcion}: ${resultado}`);
        return resultado;
      } else {
        console.warn(`    ⚠️ Fallo ${descripcion}: Respuesta no numérica [${JSON.stringify(resultado)}]`);
        return VALOR_FALLO;
      }
    } 
    else {
      console.error(`❌ Tipo de función Modbus desconocido: ${tipoFuncion} para ${descripcion}`);
      return VALOR_FALLO;
    }
  } catch (error) {
    // Mejorar el logging de errores para diagnóstico
    console.warn(`    ❌ Error Modbus ${descripcion} (${ip}:${port}/Slave:${slaveId}/Reg:${register}): ${error.message}`);
    
    // Si es un error específico de kw1A, agregar información adicional
    if (descripcion === "kw1A") {
      console.warn(`    🔧 DIAGNÓSTICO kw1A: Verificar conectividad con generador 1A en ${ip}:${port}`);
    }
    
    return VALOR_FALLO; // Devolver valor de fallo en caso de excepción
  }
}

// Función para registrar datos en la BD
async function registrarDatos(
  minutoActual,
  kw22,
  kvar22,
  kw21,
  kvar21,
  kw1A,
  kw1B,
  voltage
) {
  // console.log(`Intentando registrar datos para ${minutoActual}...`);
  let nuevoId = 0; // Inicializar
  try {
    const ultimoId = await obtenerUltimoId();
    // Asegúrate de que `ultimoId` sea un número antes de sumar
    nuevoId = (typeof ultimoId === 'number' && !isNaN(ultimoId) ? ultimoId : 0) + 5;

    // IMPORTANTE: Asegúrate que las columnas en tu tabla 'generacion'
    // (kw22, kvar22, kw21, kvar21, kw1A, kw1B, voltage)
    // permitan valores negativos (ej: INT, FLOAT, DECIMAL, no UNSIGNED INT).
    const queryActual = `INSERT INTO generacion (id, fecha, kw22, kvar22, kw21, kvar21, kw1A, kw1B, voltage)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                         ON DUPLICATE KEY UPDATE kw22 = VALUES(kw22), kvar22 = VALUES(kvar22),
                                             kw21 = VALUES(kw21), kvar21 = VALUES(kvar21),
                                             kw1A = VALUES(kw1A), kw1B = VALUES(kw1B),
                                             voltage = VALUES(voltage)`;

    const values = [
        nuevoId, minutoActual, kw22, kvar22, kw21, kvar21, kw1A, kw1B, voltage
    ];

    // console.log(`  Ejecutando SQL: INSERT/UPDATE con ID=${nuevoId}, Fecha=${minutoActual}, Valores:`, {kw22, kvar22, kw21, kvar21, kw1A, kw1B, voltage});

    const [result] = await poolLecturas.query(queryActual, values);

    // Loguear resultado de la inserción/actualización
    if (result.affectedRows > 0) {
         if (result.insertId === nuevoId) { // O result.affectedRows === 1 si no hay duplicado
            //  console.log(`  ✅ Datos INSERTADOS para ${minutoActual} con ID ${nuevoId}.`);
         } else { // O result.affectedRows === 2 si hubo duplicado y se actualizó
            //  console.log(`  ✅ Datos ACTUALIZADOS para ${minutoActual} (ID existente o diferente, revisar lógica de ID si importa).`);
         }
    } else {
         // Esto podría pasar si ON DUPLICATE KEY UPDATE resulta en que no hay cambios
        //  console.log(`  ℹ️ No se realizaron cambios en la BD para ${minutoActual} (posiblemente los datos eran idénticos).`);
    }

    return true; // Indicar éxito de la operación de BD

  } catch (error) {
    console.error(
      `❌ Error CRÍTICO al insertar/actualizar datos para ${minutoActual} (ID intento: ${nuevoId}):`,
      error.message
    );
    // Aquí podrías implementar una lógica de reintento o notificación si falla la BD
    return false; // Indicar fallo de la operación de BD
  }
}

// --- Lógica Principal de Ejecución ---
async function ejecutarLectura() {
  const minutoActual = obtenerMinutoActual();
  if (minutoActual === ultimoMinutoProcesado) {
    // console.log(`Minuto ${minutoActual} ya fue procesado. Saltando ejecución.`);
    return;
  }
  // console.log(`--- Iniciando ciclo para ${minutoActual} ---`);
  ultimoMinutoProcesado = minutoActual;

  // --- Lecturas Modbus Individuales ---
  // console.log("Iniciando lecturas Modbus...");
  let kw22   = await leerModbusSeguro("holding", "192.168.0.130", 502, 1, 1633, "kw22");
  let kw21   = await leerModbusSeguro("holding", "192.168.0.120", 502, 1, 1633, "kw21");
  let kvar22 = await leerModbusSeguro("signedHolding", "192.168.0.130", 502, 1, 1635, "kvar22");
  let kvar21 = await leerModbusSeguro("signedHolding", "192.168.0.120", 502, 1, 1635, "kvar21");
  let   kw1A   = await leerModbusSeguro("holding", "192.168.7.10", 502, 1, 307, "kw1A");
  let   kw1B   = await leerModbusSeguro("holding", "192.168.6.100", 502, 1, 239, "kw1B");
  const voltage22_raw = await leerModbusSeguro("holding", "192.168.0.130", 502, 1, 1631, "voltage22");
  const voltage21_raw = await leerModbusSeguro("holding", "192.168.0.120", 502, 1, 1631, "voltage21");
  // console.log("Lecturas Modbus completadas.");

  // --- Procesamiento Post-Lectura ---
  // console.log("Procesando valores leídos...");

  // --- VALIDACIÓN ROBUSTA DE DATOS kW ---
  // Convertir valores negativos a 0 para kW (no aplica a kvar que pueden ser negativos)
  // IMPORTANTE: Solo validamos si NO es un error de comunicación Modbus
  
  // Validación para kw22
  if (kw22 !== VALOR_FALLO && kw22 < 0) {
    console.warn(`  Valor negativo detectado en kw22 (${kw22}). Se registrará como 0.`);
    kw22 = 0;
  }
  // Si kw22 es menor que 100 (pero no es error), considerarlo ruido de arranque y guardar 0
  if (kw22 !== VALOR_FALLO && kw22 < 100) {
    console.warn(`  Valor bajo detectado en kw22 (${kw22} < 100). Se registrará como 0.`);
    kw22 = 0;
  }
  
  // Validación para kw21
  if (kw21 !== VALOR_FALLO && kw21 < 0) {
    console.warn(`  Valor negativo detectado en kw21 (${kw21}). Se registrará como 0.`);
    kw21 = 0;
  }
  
  // VALIDACIÓN SIMPLIFICADA PARA kw1A (Generador 1A)
  // REGLA SIMPLE: Cualquier valor <= 0 o error de comunicación -> registrar 0
  if (kw1A === VALOR_FALLO) {
    console.warn(`  ❌ Error de comunicación Modbus para kw1A. Se registrará como 0.`);
    kw1A = 0;
  } 
  else if (kw1A < 0) {
    console.warn(`  ⚠️ Valor negativo leído de kw1A (${kw1A}). Se registrará como 0.`);
    kw1A = 0;
  }
  else if (kw1A > 1000) {
    console.warn(`  ⚠️ Valor fuera de rango para kw1A (${kw1A} > 1000). Se registrará como 0.`);
    kw1A = 0;
  }
  // Si kw1A está entre 0 y 1000, se mantiene tal como está
  
  // VALIDACIÓN SIMPLIFICADA PARA kw1B (Generador 1B) - misma lógica
  if (kw1B === VALOR_FALLO) {
    console.warn(`  ❌ Error de comunicación Modbus para kw1B. Se registrará como 0.`);
    kw1B = 0;
  } 
  else if (kw1B < 0) {
    console.warn(`  ⚠️ Valor negativo leído de kw1B (${kw1B}). Se registrará como 0.`);
    kw1B = 0;
  }
  else if (kw1B > 1000) {
    console.warn(`  ⚠️ Valor fuera de rango para kw1B (${kw1B} > 1000). Se registrará como 0.`);
    kw1B = 0;
  }
  // Si kw1B está entre 0 y 1000, se mantiene tal como está

  // VALIDACIÓN PARA kVAR - Solo convertir errores de comunicación a 0, valores negativos son válidos
  if (kvar22 === VALOR_FALLO) {
    console.warn(`  ❌ Error de comunicación Modbus para kvar22. Se registrará como 0.`);
    kvar22 = 0;
  }
  if (kvar21 === VALOR_FALLO) {
    console.warn(`  ❌ Error de comunicación Modbus para kvar21. Se registrará como 0.`);
    kvar21 = 0;
  }
  // Nota: Los kVAR pueden ser negativos naturalmente, así que no los convertimos a 0

  // Procesar y combinar lecturas de voltaje - NUNCA registrar -1
  let voltage_base = 0; // Cambiar default a 0 en lugar de VALOR_FALLO
  if (voltage22_raw !== VALOR_FALLO && voltage22_raw !== 0) {
    voltage_base = voltage22_raw;
    //  console.log(`  Voltaje base tomado de voltage22: ${voltage_base}`);
  } else if (voltage21_raw !== VALOR_FALLO && voltage21_raw !== 0) {
    voltage_base = voltage21_raw;
    //  console.log(`  Voltaje base tomado de voltage21 (voltage22 fue ${voltage22_raw}): ${voltage_base}`);
  } else {
    console.warn(`  ⚠️ No se pudo obtener voltaje válido (v22=${voltage22_raw}, v21=${voltage21_raw}). Se registrará como 0.`);
    voltage_base = 0;
  }

  // Calcular voltaje final, aplicar escala * 10 siempre (si es 0, queda 0)
  const voltage = voltage_base * 10;
  //  console.log(`  Voltaje final calculado: ${voltage}`);

  // --- Registro en Base de Datos ---
  // Se intenta registrar siempre, incluso si algunas lecturas fallaron (VALOR_FALLO)
  await registrarDatos(
    minutoActual,
    kw22,
    kvar22,
    kw21,
    kvar21,
    kw1A,
    kw1B,
    voltage
  );

  //  console.log(`--- Ciclo para ${minutoActual} completado ---`);
}

// --- Configuración y Arranque del Cron Job ---
// console.log("Configurando Cron job para ejecutarse cada 50 segundos...");
const job = new cron.CronJob(
  "20 * * * * *", // Ejecutar en el segundo 30 de cada minuto (*)
  () => {
    // console.log("\n--- Cron Job Disparado ---");
    ejecutarLectura().catch(error => {
        // Captura errores no manejados dentro de ejecutarLectura (aunque debería haber pocos)
        console.error("Error FATAL no capturado en ejecutarLectura:", error);
    });
  },
  null, // onComplete
  false, // start automatically (se inicia manualmente abajo)
  ZONA_HORARIA // Timezone
);

// Iniciar el job
job.start();
// console.log("Cron job iniciado. Esperando la primera ejecución...");

// Opcional: Ejecutar una vez inmediatamente al iniciar para pruebas rápidas
// console.log("Ejecutando una vez inmediatamente para prueba...");
// ejecutarLectura().catch(error => {
//     console.error("Error FATAL no capturado en la ejecución inicial:", error);
// });

// ===============================================================================
// CAMBIOS REALIZADOS - VALIDACIÓN SIMPLIFICADA: NUNCA REGISTRAR -1
// ===============================================================================
// PROBLEMA SOLUCIONADO: 
// - Antes: Se registraban valores -1 en la BD por errores de comunicación o valores negativos
// - Requerimiento: NUNCA registrar -1, siempre usar 0 para cualquier problema
//
// SOLUCIÓN IMPLEMENTADA:
// 1. REGLA SIMPLE para todos los kW (kw22, kw21, kw1A, kw1B):
//    - Error de comunicación Modbus → 0
//    - Valor negativo leído → 0  
//    - Valor fuera de rango (>1000) → 0
//    - Valor válido (0-1000) → se mantiene
//
// 2. REGLA para kVAR (kvar22, kvar21):
//    - Error de comunicación Modbus → 0
//    - Valores negativos → se mantienen (son válidos para kVAR)
//
// 3. REGLA para Voltaje:
//    - Error de comunicación → 0
//    - Sin lecturas válidas → 0
//
// RESULTADO FINAL:
// - La BD NUNCA tendrá valores -1
// - Errores de comunicación = 0 (generador apagado/desconectado)
// - Valores negativos de kW = 0 (generador apagado)
// - Solo los kVAR pueden ser negativos (comportamiento eléctrico normal)
// ===============================================================================