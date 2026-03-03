exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const REPLICATE_API_KEY = process.env.REPLICATE_API_KEY;
  if (!REPLICATE_API_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: "API key not configured" }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid request body" }) };
  }

  const { imageBase64, mode } = body; // mode: "upscale" | "face" | "both"

  if (!imageBase64) {
    return { statusCode: 400, body: JSON.stringify({ error: "No image provided" }) };
  }

  const headers = {
    Authorization: `Token ${REPLICATE_API_KEY}`,
    "Content-Type": "application/json",
  };

  try {
    let resultUrl = null;

    // ── Step 1: Upscale with Real-ESRGAN ──────────────────────────────────
    if (mode === "upscale" || mode === "both") {
      const upscaleRes = await fetch("https://api.replicate.com/v1/predictions", {
        method: "POST",
        headers,
        body: JSON.stringify({
          version: "42fed1c4974146d4d2414e2be2c5277c7fcf05fcc3a73abf41610695738c1d7b",
          input: {
            image: imageBase64,
            scale: 4,
            face_enhance: false,
          },
        }),
      });

      const upscaleData = await upscaleRes.json();
      resultUrl = await pollPrediction(upscaleData.id, headers);
    }

    // ── Step 2: Face Restore with CodeFormer ──────────────────────────────
    if (mode === "face" || mode === "both") {
      const faceInput = resultUrl ? resultUrl : imageBase64;
      const isUrl = typeof faceInput === "string" && faceInput.startsWith("http");

      const faceRes = await fetch("https://api.replicate.com/v1/predictions", {
        method: "POST",
        headers,
        body: JSON.stringify({
          version: "7de2ea26c616d5bf2245ad0d5e24f0ff9a6204578a5c876db53a4a975f90d7d6",
          input: {
            image: faceInput,
            codeformer_fidelity: 0.7,
            background_enhance: true,
            face_upsample: true,
            upscale: 2,
          },
        }),
      });

      const faceData = await faceRes.json();
      resultUrl = await pollPrediction(faceData.id, headers);
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ outputUrl: resultUrl }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message || "Enhancement failed" }),
    };
  }
};

// Poll Replicate until prediction is done
async function pollPrediction(predictionId, headers) {
  const url = `https://api.replicate.com/v1/predictions/${predictionId}`;
  for (let i = 0; i < 60; i++) {
    await sleep(2000);
    const res = await fetch(url, { headers });
    const data = await res.json();
    if (data.status === "succeeded") {
      return Array.isArray(data.output) ? data.output[0] : data.output;
    }
    if (data.status === "failed" || data.status === "canceled") {
      throw new Error(`Prediction ${data.status}: ${data.error || "unknown error"}`);
    }
  }
  throw new Error("Prediction timed out after 2 minutes");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
