(function(root) {
  'use strict';
  const defaults = { deepseek: 'deepseek-v4-pro', anthropic: 'claude-sonnet-5-5', 'openai-direct': 'gpt-6.1-sol', openai: 'gpt-4o-mini' };
  const seeds = {
    deepseek: ['deepseek-v4-pro', 'deepseek-chat', 'deepseek-reasoner'],
    anthropic: ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
    'openai-direct': ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-luna', 'gpt-5.6', 'gpt-5.4', 'gpt-5.2', 'gpt-5', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4o-mini', 'o3', 'o4-mini'],
    openai: [],
  };
  function valid(provider, id) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,99}$/.test(id)) return false;
    if (provider === 'deepseek') return /^deepseek-/i.test(id);
    if (provider === 'anthropic') return /^claude-/i.test(id);
    return provider === 'openai' || provider === 'openai-direct' && /^(?:ft:)?(gpt-|chatgpt-|o[134](?:-|$))/i.test(id);
  }
  function vision(provider, id, metadata = {}) {
    const inputs = metadata.input_modalities || metadata.architecture?.input_modalities || metadata.capabilities?.input_modalities;
    if (Array.isArray(inputs)) return inputs.includes('image');
    if (typeof metadata.supports_vision === 'boolean') return metadata.supports_vision;
    if (typeof metadata.capabilities?.image_input?.supported === 'boolean') return metadata.capabilities.image_input.supported;
    if (provider === 'anthropic') return /^claude-(?:(?:fable|opus|sonnet|haiku)-[345]|3|[345])/i.test(id);
    if (provider === 'openai-direct' || provider === 'openai') return /^(?:ft:)?(?:gpt-(?:4o|4\.1|5|6)|chatgpt-(?:4o|5|6)|o3(?:-|$)|o4-mini)/i.test(id.split('/').pop()) && !/audio|transcribe|tts|image|realtime/.test(id);
    return false;
  }
  function chat(id) { return !/embedding|moderation|whisper|tts|transcri|dall-e|gpt-image|realtime|audio|sora|codex|search-api/.test(id); }
  const api = { defaults, seeds, valid, vision, chat };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CARNIVAL_CHAT_MODELS = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
