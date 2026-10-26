'use strict';

// A composition is rendered in one provider request, not one request per panel.
const LAYOUTS = {
  'grid-2x2': { columns: 2, rows: 2, positions: ['Top left', 'Top right', 'Bottom left', 'Bottom right'] },
  'side-by-side': { columns: 2, rows: 1, positions: ['Left', 'Right'] },
  stacked: { columns: 1, rows: 2, positions: ['Top', 'Bottom'] },
};

function invalid(message) {
  const error = new Error(message);
  error.status = 400;
  throw error;
}

function prepareImagePrompt(promptInput, input) {
  const sharedPrompt = typeof promptInput === 'string' ? promptInput.trim() : '';
  if (input === undefined || input === null) {
    if (!sharedPrompt) invalid('Enter a prompt first.');
    if (sharedPrompt.length > 30000) invalid('Image prompt is too long (max 30,000 characters).');
    return { prompt: sharedPrompt, composition: null };
  }
  const layout = typeof input.layout === 'string' && Object.hasOwn(LAYOUTS, input.layout)
    ? LAYOUTS[input.layout] : null;
  if (!layout) invalid('Choose a supported multi-panel layout.');
  if (!Array.isArray(input.panels) || input.panels.length !== layout.positions.length) {
    invalid(`This layout needs exactly ${layout.positions.length} panel prompts.`);
  }
  const panels = input.panels.map((value, index) => {
    if (typeof value !== 'string' || !value.trim()) invalid(`Enter a prompt for panel ${index + 1}.`);
    if (value.trim().length > 6000) invalid(`Panel ${index + 1} is too long (max 6,000 characters).`);
    return value.trim();
  });
  const prompt = [
    `Create ONE finished image containing exactly ${panels.length} equally sized panels in ${layout.columns} column(s) and ${layout.rows} row(s).`,
    'Arrange the panels in the specified positions, read left to right and top to bottom. Fill the canvas edge to edge with a clean grid, without gaps, borders, titles, captions, or text labels.',
    'Each panel is a distinct scene described below. Keep the same characters recognizable across panels unless a panel asks for someone different. Follow the attached reference images for their appearance, clothing, places, and visual style.',
    ...(sharedPrompt ? [`Shared instructions for every panel:\n${sharedPrompt}`] : []),
    ...panels.map((text, index) => `Panel ${index + 1} — ${layout.positions[index]}:\n${text}`),
    'Return a single combined image, not separate image files.',
  ].join('\n\n');
  if (prompt.length > 30000) invalid('The shared instructions and panel prompts are too long together (max 30,000 characters).');
  return { prompt, composition: { layout: input.layout, panels, sharedPrompt } };
}

module.exports = { prepareImagePrompt };
