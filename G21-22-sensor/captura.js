// CommonJS version (Node v20+) - captura cada 30s
const ModbusRTU = require("modbus-serial");
const fs = require("fs/promises");
const path = require("path");
const cron = require("node-cron");
const moment = require("moment-timezone");

// ===== Config =====
const TZ = "America/Tegucigalpa";
const MODBUS_PORT = 502;
const CONNECT_TIMEOUT = 5000;
const READ_TIMEOUT = 3000;
const UNIT_ID = 1;
// 10040 (Discrete Input) => 10040 - 10001 = 39
const ADDR_DI = 10040 - 10001;

// Dispositivos (solo IP/label cambian)
const DEVICES = [
  { label: "G21", ip: "192.168.0.120" },
  { label: "G22", ip: "192.168.0.130" },
];

// ===== CSV (hora,G21,G22) =====
const outDir = path.join(__dirname, "logs");
const outFile = path.join(outDir, "estados_min.csv");

async function ensureCsvHeader() {
  await fs.mkdir(outDir, { recursive: true });
  try {
    await fs.access(outFile);
  } catch {
    await fs.writeFile(outFile, "hora,G21,G22\n", "utf8");
  }
}

const tsLog = () => moment().tz(TZ).format("YYYY-MM-DD HH:mm:ss");
const tsSec = () => moment().tz(TZ).format("HH:mm:ss");

// ===== Modbus helpers =====
async function connect(ip) {
  const client = new ModbusRTU();
  await new Promise((resolve, reject) => {
    client.setTimeout(CONNECT_TIMEOUT);
    client.connectTCP(ip, { port: MODBUS_PORT }, (err) => {
      if (err) return reject(err);
      client.setID(UNIT_ID);
      client.setTimeout(READ_TIMEOUT);
      resolve();
    });
  });
  return client;
}

async function readDI(ip) {
  let client;
  try {
    client = await connect(ip);
    const res = await client.readDiscreteInputs(ADDR_DI, 1); // FC2
    return res.data[0] ? 1 : 0;
  } catch (e) {
    console.error(`[${tsLog()}] ERROR ${ip}: ${e.message}`);
    return null; // sin dato -> columna vacía
  } finally {
    try {
      client && (await client.close());
    } catch {}
  }
}

// ===== Anti-solape simple =====
let running = false;

async function tick() {
  if (running) {
    console.warn(`[${tsLog()}] Tick saltado: ejecución anterior en curso`);
    return;
  }
  running = true;
  const start = Date.now();

  try {
    const [g21, g22] = await Promise.all([
      readDI(DEVICES[0].ip),
      readDI(DEVICES[1].ip),
    ]);

    const line = `${tsSec()},${g21 ?? ""},${g22 ?? ""}\n`;
    await fs.appendFile(outFile, line, "utf8");
    console.log(`[${tsLog()}] CSV -> ${line.trim()}`);
  } catch (e) {
    console.error(`[${tsLog()}] ERROR tick: ${e.message}`);
  } finally {
    const dur = Date.now() - start;
    if (dur > 25000) {
      console.warn(
        `[${tsLog()}] Tick duró ${dur} ms (cercano a 30s). Revisa red/latencia.`
      );
    }
    running = false;
  }
}

(async () => {
  console.log(
    `[${tsLog()}] Iniciando captura cada 30s | UnitID=${UNIT_ID} | addrDI=${ADDR_DI}`
  );
  await ensureCsvHeader();
  await tick(); // primera escritura inmediata

  // Cron con segundos: cada 30 s
  cron.schedule("*/30 * * * * *", tick);
})();
