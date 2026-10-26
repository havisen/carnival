'use strict';

// Shared browser/server catalog. Checked against the OpenAI Images API on
// 2026-10-26; retired GPT Image 1 and DALL-E models are deliberately excluded.
// https://developers.openai.com/api/reference/resources/images/methods/generate
{
  const openAISizes = ['1024x1024', '1536x1024', '1024x1536'];
  const catalog = [
    { id: 'dola-seedream-5-0-pro-260628', label: 'Seedream 5.0 Pro', provider: 'byteplus', sizes: ['1K', '1.5K', '2K'] },
    ...[
      ['gpt-image-2.5-sunburst', 'GPT Image 2.5 Sunburst'],
      ['gpt-image-2.5-flare', 'GPT Image 2.5 Flare'],
      ['gpt-image-2', 'GPT Image 2'],
      ['gpt-image-1.5', 'GPT Image 1.5'],
      ['gpt-image-1-mini', 'GPT Image 1 Mini'],
      ['chatgpt-image-latest', 'ChatGPT Image Latest'],
      ['gpt-image-2.5-sunburst-2026-09-08', 'GPT Image 2.5 Sunburst · 2026-09-08'],
      ['gpt-image-2.5-flare-2026-09-08', 'GPT Image 2.5 Flare · 2026-09-08'],
      ['gpt-image-2-2026-04-21', 'GPT Image 2 · 2026-04-21'],
    ].map(([id, label]) => ({ id, label, provider: 'openai', sizes: [...openAISizes] })),
  ];
  if (typeof module !== 'undefined' && module.exports) module.exports = catalog;
  else globalThis.CARNIVAL_IMAGE_MODELS = catalog;
}
