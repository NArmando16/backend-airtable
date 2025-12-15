const express = require("express");
const cors = require("cors");
const multer = require("multer");
const Papa = require("papaparse");

const upload = multer();
const app = express();
const PORT = process.env.PORT || 3000;

// 👇 Cambia esto por el dominio de tu frontend
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "*";

app.use(
  cors({
    origin: FRONTEND_ORIGIN,
  })
);

// ====== STORE EN MEMORIA (TEMPORAL) ======
/*
  store = {
    activeDate: "12/11/2025",
    ordersByCrewDevice: {
      "584ArmandoNavarro": {
        "TIKTOK USA 919": [
          { id, rawText, meta: {...} },
          ...
        ]
      },
      ...
    }
  }
*/
let store = {
  activeDate: null,
  ordersByCrewDevice: {},
};

// ====== Helper: construir el bloque de texto "tipo Airtable" ======
function buildRawBlockFromRow(row) {
  const parts = [];

  function add(label, value) {
    if (value == null) return;
    const v = String(value).trim();
    if (!v) return;
    parts.push(label);
    parts.push(v);
  }

  add("EntregableID", row["EntregableID"]);
  add("Dia de Entregable", row["Dia de Entregable"]);
  add("1 Cuenta", row["1 Cuenta"]);
  add("2 Crew", row["2 Crew"]);
  add("Celular", row["Celular"]);
  add("LINK PARA REPORTAR EL POST", row["LINK PARA REPORTAR EL POST"]);
  add("REPORTE DE CONTENIDO", row["REPORTE DE CONTENIDO"]);
  add("Sound Link", row["Sound Link"]);
  add("New Genre (from Book Data) (from 3 Text)", row["New Genre (from Book Data) (from 3 Text)"]);
  add("Type of Post", row["Type of Post"]);
  add("Text to use on post", row["Text to use on post"]);
  add(
    "Images for Post (from Book Data) (from 3 Text)",
    row["Images for Post (from Book Data) (from 3 Text)"]
  );
  add("Link Cover Image", row["Link Cover Image"]);
  add("Use for Short Hooks", row["Use for Short Hooks"]);
  add("Short Hooks Images", row["Short Hooks Images"]);
  add("Link To Short hook Image", row["Link To Short hook Image"]);
  add("Book - Author - Tropes", row["Book - Author - Tropes"]);
  add("Hashtags for post", row["Hashtags for post"]);

  return parts.join("\n");
}

// ====== ENDPOINT: subir CSV del día ======
app.post("/api/import-csv", upload.single("file"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ ok: false, error: "No se recibió archivo CSV (campo 'file')." });
  }

  const csvStr = req.file.buffer.toString("utf8");

  const parsed = Papa.parse(csvStr, {
    header: true,
    skipEmptyLines: true,
  });

  if (parsed.errors && parsed.errors.length > 0) {
    console.error(parsed.errors[0]);
  }

  const rows = parsed.data || [];
  if (!rows.length) {
    return res.status(400).json({ ok: false, error: "El CSV no contiene filas." });
  }

  // 🔥 Reset: al importar un nuevo CSV borramos todo lo anterior
  store.activeDate = null;
  store.ordersByCrewDevice = {};

  let totalOrders = 0;
  const crewsSet = new Set();
  const devicesSet = new Set();
  let activeDate = null;

  rows.forEach((row) => {
    const crew = (row["2 Crew"] || "").trim();
    const device = (row["Celular"] || "").trim();
    const dia = (row["Dia de Entregable"] || "").trim();

    if (!crew || !device) return;

    if (!activeDate && dia) activeDate = dia;

    const rawText = buildRawBlockFromRow(row);
    if (!rawText.trim()) return;

    if (!store.ordersByCrewDevice[crew]) {
      store.ordersByCrewDevice[crew] = {};
    }
    if (!store.ordersByCrewDevice[crew][device]) {
      store.ordersByCrewDevice[crew][device] = [];
    }

    const list = store.ordersByCrewDevice[crew][device];
    const orderId = list.length + 1;

    const order = {
      id: orderId,
      rawText,
      meta: {
        entregableId: row["EntregableID"] || "",
        dia,
        cuenta: row["1 Cuenta"] || "",
        crew,
        device,
        typeOfPost: row["Type of Post"] || "",
      },
    };

    list.push(order);
    totalOrders++;
    crewsSet.add(crew);
    devicesSet.add(device);
  });

  store.activeDate = activeDate || null;

  return res.json({
    ok: true,
    activeDate: store.activeDate,
    totalOrders,
    crews: Array.from(crewsSet),
    devices: Array.from(devicesSet),
  });
});

// ====== ENDPOINT: obtener órdenes para un worker + celular ======
app.get("/api/orders", (req, res) => {
  const crewId = (req.query.crewId || "").trim();
  const deviceId = (req.query.deviceId || "").trim();

  if (!crewId || !deviceId) {
    return res
      .status(400)
      .json({ ok: false, error: "Faltan parámetros crewId y/o deviceId." });
  }

  const byCrew = store.ordersByCrewDevice[crewId] || {};
  const list = byCrew[deviceId] || [];

  return res.json({
    ok: true,
    activeDate: store.activeDate,
    count: list.length,
    orders: list,
  });
});

app.get("/", (_, res) => {
  res.send("Backend de órdenes TikTok funcionando.");
});

app.listen(PORT, () => {
  console.log(`Servidor escuchando en puerto ${PORT}`);
});
