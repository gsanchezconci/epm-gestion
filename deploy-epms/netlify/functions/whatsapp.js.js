const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

// Inicialización Firebase (una sola vez)
let db;
function getDB() {
  if (!db) {
    initializeApp({
      credential: cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      }),
    });
    db = getFirestore();
  }
  return db;
}

// ─── Handler principal ───────────────────────────────────────────
exports.handler = async (event) => {
  // PASO 1: Verificación inicial de Meta (GET)
  if (event.httpMethod === 'GET') {
    const p = event.queryStringParameters || {};
    if (p['hub.verify_token'] === process.env.VERIFY_TOKEN) {
      return { statusCode: 200, body: p['hub.challenge'] };
    }
    return { statusCode: 403, body: 'Token inválido' };
  }

  // PASO 2: Mensaje entrante (POST)
  if (event.httpMethod === 'POST') {
    let body;
    try { body = JSON.parse(event.body); } 
    catch { return { statusCode: 200, body: 'ok' }; }

    const msg = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msg || msg.type !== 'text') return { statusCode: 200, body: 'ok' };

    const from = msg.from;           // número del que escribe
    const texto = msg.text.body;     // contenido del mensaje

    // Procesamos de forma async para responder 200 a Meta inmediatamente
    procesarMensaje(from, texto).catch(console.error);

    return { statusCode: 200, body: 'ok' };
  }

  return { statusCode: 405, body: 'Method not allowed' };
};

// ─── Lógica principal ─────────────────────────────────────────────
async function procesarMensaje(from, texto) {
  const firestore = getDB();

  // 1. Identificar el colaborador por número de WhatsApp
  const usersSnap = await firestore
    .collection('appUsers')
    .where('whatsapp', '==', from)
    .limit(1)
    .get();

  if (usersSnap.empty) {
    await enviarMensaje(from, 'No tenés acceso al bot de EPMS. Pedile a Gary que registre tu número.');
    return;
  }

  const usuario = usersSnap.docs[0].data();
  const userId  = usersSnap.docs[0].id;
  const esAdmin = usuario.role === 'admin';

  // 2. Obtener contexto del usuario (horas del mes actual)
  const ahora = new Date();
  const mesId  = `${ahora.getFullYear()}-${String(ahora.getMonth() + 1).padStart(2, '0')}`;

  const horasSnap = await firestore
    .collection('horas')
    .where('userId', '==', userId)
    .where('mes', '==', mesId)
    .get();

  const horasPorProyecto = {};
  horasSnap.forEach(doc => {
    const d = doc.data();
    horasPorProyecto[d.proyecto] = (horasPorProyecto[d.proyecto] || 0) + d.horas;
  });

  const totalHoras = Object.values(horasPorProyecto).reduce((a, b) => a + b, 0);

  // 3. Llamar a Claude con el contexto
  const respuestaIA = await llamarClaude({
    usuario: usuario.nombre,
    esAdmin,
    horasPorProyecto,
    totalHoras,
    mesId,
    userId,
    mensajeUsuario: texto,
  });

  // 4. Ejecutar acciones si Claude lo indica
  if (respuestaIA.accion === 'registrar_horas') {
    await registrarHoras(firestore, userId, respuestaIA.datos);
  }

  // 5. Responder al usuario por WhatsApp
  await enviarMensaje(from, respuestaIA.respuesta);
}

// ─── Claude API ───────────────────────────────────────────────────
async function llamarClaude({ usuario, esAdmin, horasPorProyecto, totalHoras, mesId, userId, mensajeUsuario }) {
  const proyectos = ['MSK', '5 Hispanos', 'RDC', 'Delta V', 'Estudio', 'Acerbon'];

  const systemPrompt = `Sos el asistente de gestión de horas del equipo EPMS.
Usuario actual: ${usuario}${esAdmin ? ' (admin)' : ''}.

Horas registradas este mes (${mesId}):
${JSON.stringify(horasPorProyecto, null, 2)}
Total: ${totalHoras}hs

Proyectos disponibles: ${proyectos.join(', ')}

Podés hacer tres cosas:
1. CONSULTAR horas (responde con un resumen claro)
2. REGISTRAR horas: cuando el usuario diga "cargá X horas en PROYECTO", devolvé JSON con accion:"registrar_horas"
3. RECORDATORIO: si te piden mandar recordatorio (solo admin), explicá que esa función la maneja el cron

Cuando registres horas, respondé SOLO con este JSON (sin texto extra):
{"accion":"registrar_horas","datos":{"proyecto":"NOMBRE","horas":N,"descripcion":"texto"},"respuesta":"Confirmación para el usuario"}

Para consultas y cualquier otra cosa, respondé SOLO con:
{"accion":"ninguna","respuesta":"Tu respuesta en texto plano"}

Sé conciso. Máximo 3 líneas en la respuesta al usuario.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 400,
      system: systemPrompt,
      messages: [{ role: 'user', content: mensajeUsuario }],
    }),
  });

  const data = await res.json();
  const texto = data.content?.[0]?.text || '{"accion":"ninguna","respuesta":"No entendí el mensaje."}';

  try { return JSON.parse(texto); }
  catch { return { accion: 'ninguna', respuesta: texto }; }
}

// ─── Registrar horas en Firestore ─────────────────────────────────
async function registrarHoras(firestore, userId, { proyecto, horas, descripcion }) {
  const ahora = new Date();
  await firestore.collection('horas').add({
    userId,
    proyecto,
    horas,
    descripcion: descripcion || '',
    fecha: ahora.toISOString().split('T')[0],
    mes: `${ahora.getFullYear()}-${String(ahora.getMonth() + 1).padStart(2, '0')}`,
    fuente: 'whatsapp',
    timestamp: ahora,
  });
}

// ─── Enviar mensaje por WhatsApp ──────────────────────────────────
async function enviarMensaje(to, texto) {
  await fetch(
    `https://graph.facebook.com/v19.0/${process.env.PHONE_NUMBER_ID}/messages`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: texto },
      }),
    }
  );
}