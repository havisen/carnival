'use strict';

const crypto = require('node:crypto');

function problem(message, code, status = 502) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  throw error;
}

async function generateOpenAIImage({ apiKey, model, size, prompt, images = [], baseUrl, userId }, fetchImage) {
  const endpoint = `${baseUrl.replace(/\/+$/, '')}/images/${images.length ? 'edits' : 'generations'}`;
  const body = {
    model, prompt, size, n: 1, quality: 'auto', output_format: 'png',
    safety_identifier: crypto.createHash('sha256').update(`carnival:${userId}`).digest('hex'),
    ...(images.length && model === 'gpt-image-1.5' ? { input_fidelity: 'high' } : {}),
  };
  let requestBody = JSON.stringify(body);
  const headers = { Authorization: `Bearer ${apiKey}` };
  if (images.length) {
    const form = new FormData();
    Object.entries(body).forEach(([name, value]) => form.append(name, String(value)));
    images.forEach((image, index) => {
      const match = /^data:(image\/(?:png|jpeg|webp));base64,([a-z0-9+/=\s]+)$/i.exec(image);
      if (!match) problem('OpenAI reference images must be PNG, JPEG, or WebP. Choose another image.', 'IMAGE_REFERENCE_FORMAT', 400);
      const extension = match[1] === 'image/jpeg' ? 'jpg' : match[1].split('/')[1];
      form.append('image[]', new Blob([Buffer.from(match[2], 'base64')], { type: match[1] }), `reference-${index + 1}.${extension}`);
    });
    requestBody = form;
  } else {
    headers['Content-Type'] = 'application/json';
  }
  let response;
  try {
    response = await fetchImage(endpoint, {
      method: 'POST',
      headers,
      body: requestBody,
      signal: AbortSignal.timeout(180000),
    });
  } catch (error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') problem('OpenAI image generation timed out. Your prompt and references are still available.', 'IMAGEGEN_TIMEOUT', 504);
    problem('Could not reach the OpenAI image API. Check the saved base URL and try again.', 'IMAGEGEN_UNREACHABLE');
  }
  let payload;
  try { payload = JSON.parse(await response.text()); } catch (_) {
    problem('OpenAI returned an unreadable image response.', 'IMAGEGEN_BAD_JSON');
  }
  if (!response.ok) {
    let detail = String(payload?.error?.message || payload?.error?.code || '').split(apiKey).join('[redacted]').slice(0, 500);
    if (response.status === 401) problem('Your OpenAI API key was rejected. Update it in Settings.', 'INVALID_IMAGEGEN_KEY');
    if (response.status === 429) problem(`OpenAI image quota or rate limit reached. ${detail}`.trim(), 'IMAGEGEN_RATE_LIMITED');
    problem(`OpenAI rejected the image request (${response.status}). ${detail}`.trim(), 'IMAGEGEN_ERROR');
  }
  const encoded = payload?.data?.[0]?.b64_json;
  if (typeof encoded !== 'string' || !encoded.trim()) problem('OpenAI returned no image data.', 'IMAGEGEN_NO_DATA');
  const raw = encoded.replace(/\s/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) problem('OpenAI returned invalid image data.', 'IMAGEGEN_DECODE_FAILED');
  const buffer = Buffer.from(raw, 'base64');
  if (!buffer.length) problem('OpenAI returned an empty image.', 'IMAGEGEN_EMPTY');
  if (buffer.length > 50 * 1024 * 1024) problem('The generated image is too large to store.', 'IMAGEGEN_TOO_LARGE');
  const png = buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const webp = buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP';
  if (!png && !jpeg && !webp) problem('OpenAI returned an unsupported image format.', 'IMAGEGEN_DECODE_FAILED');
  return { buffer, mime: png ? 'image/png' : jpeg ? 'image/jpeg' : 'image/webp', extension: png ? 'png' : jpeg ? 'jpg' : 'webp', size: payload.size || size };
}

module.exports = { generateOpenAIImage };
