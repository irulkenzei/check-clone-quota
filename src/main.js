// ============================================================
// checkCloneQuota  (sekarang cuma menangani transkrip)
// ------------------------------------------------------------
// Quota "clone voice" TIDAK lagi ditegakkan lewat function ini.
// Setelah VoiceScreen.tsx disesuaikan dengan pola CreateScreen.tsx
// (anonymous session + collection `user_stats`, di-update langsung
// dari client lewat databases.updateDocument() -- sama persis
// seperti generation_count), function ini cuma dipakai untuk 1 hal:
// transkrip audio hasil live-record lewat Replicate Whisper.
//
// Tidak pakai verifikasi JWT lagi (disesuaikan dengan pola
// persistGeneratedAudio yang juga tidak memverifikasi identitas
// pemanggil -- payload di-trust apa adanya, konsisten dengan
// tingkat keamanan function lain di project ini).
//
// Body request (JSON): { "action": "transcribe", "audioUrl": "..." }
// Response: { text: string, language?: string }
// ============================================================

export default async ({ req, res, log, error }) => {
  const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;
  // Isi dengan version hash model Whisper pilihan Anda dari halaman model
  // di Replicate (mis. https://replicate.com/openai/whisper -> tab "API").
  const WHISPER_MODEL_VERSION = process.env.WHISPER_MODEL_VERSION;

  let payload = {};
  try {
    payload = JSON.parse(req.body || '{}');
  } catch (e) {
    return res.json({ error: 'Invalid JSON body' }, 400);
  }

  if (payload.action !== 'transcribe') {
    return res.json({ error: 'Unsupported action' }, 400);
  }

  const { audioUrl, language } = payload;
  if (!audioUrl) {
    return res.json({ error: 'audioUrl is required' }, 400);
  }

  try {
    const createRes = await fetch('https://api.replicate.com/v1/predictions', {
      method: 'POST',
      headers: {
        Authorization: `Token ${REPLICATE_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        version: WHISPER_MODEL_VERSION,
        input: {
          audio: audioUrl,
          // Kasih hint bahasa eksplisit (kalau dikirim client) supaya Whisper
          // tidak auto-detect per-segmen -- itu penyebab model kadang
          // "lompat" bahasa di tengah transkrip pada audio pendek/ambigu.
          ...(language ? { language } : {}),
        },
      }),
    });

    let prediction = await createRes.json();

    if (!createRes.ok) {
      error(`Replicate error: ${JSON.stringify(prediction)}`);
      return res.json({ error: 'Failed to start transcription' }, 500);
    }

    // Klip rekaman maksimal 30 detik -> polling tiap 1 detik, maksimal 45x.
    const pollUrl = prediction.urls?.get;
    for (let i = 0; i < 45; i++) {
      if (['succeeded', 'failed', 'canceled'].includes(prediction.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const pollRes = await fetch(pollUrl, {
        headers: { Authorization: `Token ${REPLICATE_API_TOKEN}` },
      });
      prediction = await pollRes.json();
    }

    if (prediction.status !== 'succeeded') {
      return res.json({ error: `Transcription ${prediction.status}` }, 500);
    }

    const text =
      prediction.output?.transcription ||
      prediction.output?.text ||
      (typeof prediction.output === 'string' ? prediction.output : '');

    return res.json({
      text: text.trim(),
      language: prediction.output?.detected_language || null,
    });
  } catch (e) {
    error(e.message);
    return res.json({ error: 'Transcription failed' }, 500);
  }
};
