const express = require("express");
const cors = require("cors");
const multer = require("multer");
const Papa = require("papaparse");
const JSZip = require("jszip");

const upload = multer();
const app = express();
const PORT = process.env.PORT || 3000;

const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "*";

app.use(
  cors({
    origin: FRONTEND_ORIGIN,
  })
);

// Para leer JSON en POST (lista de URLs)
app.use(express.json({ limit: "2mb" }));

// ====== STORE EN MEMORIA (TEMPORAL) ======
/*
  store = {
    activeDate: "12/15/2025",
    ordersByCrewDevice: {
      "584": {
        "919": [ { id, rawText, meta }, ... ],
        "920": [ ... ]
      },
      "299": { ... }
    }
  }
*/
let store = {
  activeDate: null,
  ordersByCrewDevice: {},
};

// ====== HELPERS ======
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
  add(
    "New Genre (from Book Data) (from 3 Text)",
    row["New Genre (from Book Data) (from 3 Text)"]
  );
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

// Extraer código numérico del crew: "584ArmandoNavarro" -> "584"
function extractCrewCode(crew) {
  if (!crew) return "";
  const m = String(crew).trim().match(/^\d+/);
  return m ? m[0] : String(crew).trim();
}

// Extraer código numérico del celular: "TIKTOK USA 920" -> "920"
function extractDeviceCode(device) {
  if (!device) return "";
  const m = String(device).trim().match(/(\d+)\s*$/);
  return m ? m[1] : String(device).trim();
}

// ====== ENDPOINT: subir CSV del día ======
app.post("/api/import-csv", upload.single("file"), (req, res) => {
  if (!req.file) {
    return res
      .status(400)
      .json({ ok: false, error: "No se recibió archivo CSV (campo 'file')." });
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
    const crewFull = (row["2 Crew"] || "").trim();     // ej: "584ArmandoNavarro"
    const deviceFull = (row["Celular"] || "").trim();  // ej: "TIKTOK USA 920"
    const dia = (row["Dia de Entregable"] || "").trim();

    const crewCode = extractCrewCode(crewFull);        // "584"
    const deviceCode = extractDeviceCode(deviceFull);  // "920"

    if (!crewCode || !deviceCode) return;

    if (!activeDate && dia) activeDate = dia;

    const rawText = buildRawBlockFromRow(row);
    if (!rawText.trim()) return;

    if (!store.ordersByCrewDevice[crewCode]) {
      store.ordersByCrewDevice[crewCode] = {};
    }
    if (!store.ordersByCrewDevice[crewCode][deviceCode]) {
      store.ordersByCrewDevice[crewCode][deviceCode] = [];
    }

    const list = store.ordersByCrewDevice[crewCode][deviceCode];
    const orderId = list.length + 1;

    const order = {
      id: orderId,
      rawText,
      meta: {
        entregableId: row["EntregableID"] || "",
        dia,
        cuenta: row["1 Cuenta"] || "",
        crewFull,
        crewCode,
        deviceFull,
        deviceCode,
        typeOfPost: row["Type of Post"] || "",
      },
    };

    list.push(order);
    totalOrders++;
    crewsSet.add(crewCode);
    devicesSet.add(deviceCode);
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
  const crewParam = (req.query.crewId || "").trim();
  const deviceParam = (req.query.deviceId || "").trim();

  if (!crewParam || !deviceParam) {
    return res
      .status(400)
      .json({ ok: false, error: "Faltan parámetros crewId y/o deviceId." });
  }

  // Acepta tanto "584" como "584ArmandoNavarro"
  const crewCode = extractCrewCode(crewParam);
  const deviceCode = extractDeviceCode(deviceParam);

  const byCrew = store.ordersByCrewDevice[crewCode] || {};
  const list = byCrew[deviceCode] || [];

  return res.json({
    ok: true,
    activeDate: store.activeDate,
    count: list.length,
    orders: list,
  });
});

// ====== ENDPOINT: generar ZIP con imágenes (server-side) ======
app.post("/api/images-zip", async (req, res) => {
  try {
    const urls = req.body && Array.isArray(req.body.urls) ? req.body.urls : [];
    if (!urls.length) {
      return res
        .status(400)
        .json({ ok: false, error: "No se recibieron URLs de imágenes." });
    }

    const zip = new JSZip();
    let index = 1;

    for (const rawUrl of urls) {
      const url = String(rawUrl || "").trim();
      if (!url) continue;

      try {
        const resp = await fetch(url); // Node 18+ tiene fetch global
        if (!resp.ok) {
          console.error("Error HTTP al descargar", url, resp.status);
          continue;
        }
        const arrayBuf = await resp.arrayBuffer();

        const extMatch = url.match(
          /\.(jpe?g|png|webp|gif|heic|jpeg)(\?|$)/i
        );
        const ext = extMatch ? extMatch[1].toLowerCase() : "jpg";
        const filename = `img_${String(index).padStart(3, "0")}.${ext}`;

        zip.file(filename, Buffer.from(arrayBuf));
        index++;
      } catch (err) {
        console.error("Error descargando", url, err);
      }
    }

    if (index === 1) {
      return res.status(500).json({
        ok: false,
        error: "No se pudo descargar ninguna imagen.",
      });
    }

    const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });

    res.setHeader("Content-Type", "application/zip");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="imagenes_ordenes.zip"'
    );
    return res.send(zipBuffer);
  } catch (err) {
    console.error("Error generando ZIP", err);
    return res.status(500).json({ ok: false, error: "Error generando ZIP." });
  }
});

// ====== ENDPOINT: resetear todos los datos del backend ======
app.post("/api/reset-store", (req, res) => {
  store.activeDate = null;
  store.ordersByCrewDevice = {};
  return res.json({
    ok: true,
    message: "Store reseteada: se borraron todas las órdenes del backend.",
  });
});

// ====== ROOT ======
app.get("/", (_, res) => {
  res.send("Backend de órdenes TikTok funcionando.");
});

app.listen(PORT, () => {
  console.log(`Servidor escuchando en puerto ${PORT}`);
});
