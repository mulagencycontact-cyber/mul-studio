exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const REPLICATE_API_KEY = process.env.REPLICATE_API_KEY;
  if (!REPLICATE_API_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: "REPLICATE_API_KEY is not set in environment variables" }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: "Invalid request body" }) }; }

  const { imageBase64, mode, prompt, maskBase64 } = body;
  if (!imageBase64) return { statusCode: 400, body: JSON.stringify({ error: "No image provided" }) };

  const headers = {
    Authorization: `Token ${REPLICATE_API_KEY}`,
    "Content-Type": "application/json",
  };

  try {
    let resultUrl = null;

    // ── Product Placement ─────────────────────────────────────────────────
    if (mode === "placement") {
      if (!prompt) return { statusCode: 400, body: JSON.stringify({ error: "No prompt provided" }) };

      // Use stable-diffusion img2img via the deployment endpoint
      const requestBody = {
        version: "e490d072a34a94a11e9711ed5a6ba621c3fab884eda1665d9d3a282d65a21180",
        input: {
          prompt: `${prompt}, photorealistic, high quality, professional photography, seamlessly integrated`,
          image: imageBase64,
          num_inference_steps: 25,
          guidance_scale: 7.5,
          strength: 0.75,
        },
      };

      if (maskBase64) requestBody.input.mask = maskBase64;

      const predRes = await fetch("https://api.replicate.com/v1/predictions", {
        method: "POST",
        headers,
        body: JSON.stringify(requestBody),
      });

      const predText = await predRes.text();
      let predData;
      try { predData = JSON.parse(predText); }
      catch { return { statusCode: 500, body: JSON.stringify({ error: `Replicate returned non-JSON: ${predText.slice(0, 200)}` }) }; }

      if (!predRes.ok || predData.error) {
        return {
          statusCode: 500,
          body: JSON.stringify({
            error: `Replicate error (${predRes.status}): ${predData.error || predData.detail || JSON.stringify(predData)}`
          })
        };
      }

      resultUrl = await pollPrediction(predData.id, headers);
      return { statusCode: 200, body: JSON.stringify({ outputUrl: resultUrl }) };
    }

    // ── Upscale with Real-ESRGAN ───────────────────────────────────────────
    if (mode === "upscale" || mode === "both") {
      const res = await fetch("https://api.replicate.com/v1/predictions", {
        method: "POST", headers,
        body: JSON.stringify({
          version: "42fed1c4974146d4d2414e2be2c5277c7fcf05fcc3a73abf41610695738c1d7b",
          input: { image: imageBase64, scale: 4, face_enhance: false },
        }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      resultUrl = await pollPrediction(data.id, headers);
    }

    // ── Face Restore with CodeFormer ──────────────────────────────────────
    if (mode === "face" || mode === "both") {
      const faceInput = resultUrl || imageBase64;
      const res = await fetch("https://api.replicate.com/v1/predictions", {
        method: "POST", headers,
        body: JSON.stringify({
          version: "7de2ea26c616d5bf2245ad0d5e24f0ff9a6204578a5c876db53a4a975f90d7d6",
          input: { image: faceInput, codeformer_fidelity: 0.7, background_enhance: true, face_upsample: true, upscale: 2 },
        }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      resultUrl = await pollPrediction(data.id, headers);
    }

    return { statusCode: 200, body: JSON.stringify({ outputUrl: resultUrl }) };

  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message || "Enhancement failed" }) };
  }
};

async function pollPrediction(id, headers) {
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const res  = await fetch(`https://api.replicate.com/v1/predictions/${id}`, { headers });
    const data = await res.json();
    if (data.status === "succeeded") return Array.isArray(data.output) ? data.output[0] : data.output;
    if (data.status === "failed" || data.status === "canceled") {
      throw new Error(`Replicate prediction ${data.status}: ${data.error || "unknown error"}`);
    }
  }
  throw new Error("Timed out after 2 minutes");
}
