

import log from 'electron-log';






export { mapGeminiToOpenAI, mapOpenAIToGemini, mapOpenAIChunkToGemini } from './openai';




export function getOllamaApiUrl(baseUrl: string): string {
  let url = baseUrl;


  if (url.includes('/api/')) {
    return url;
  }


  url = url.replace(/\/$/, '');


  if (url.match(/^https?:\/\/localhost$/)) {
    url = 'http://localhost:11434';
    log.info('[OllamaTranslator] Added default Ollama port 11434');
  }


  if (url.endsWith('/v1')) {
    url += '/chat/completions';
    return url;
  }


  if (!url.includes('/chat/completions') && !url.includes('/completions')) {
    url += '/v1/chat/completions';
  }

  return url;
}


export function translateOllamaError(statusCode: number, body: string): string {

  if (body.includes('ECONNREFUSED') || body.includes('connect ECONNREFUSED')) {
    return 'Ollama is not running. Start it with `ollama serve` or launch the Ollama desktop app.';
  }


  if (statusCode === 404 || (body.includes('model') && body.includes('not found'))) {
    const modelMatch = body.match(/model ['"]([^'"]+)['"]/);
    const modelName = modelMatch ? modelMatch[1] : 'unknown';
    return `Ollama model "${modelName}" not found. Pull it: ollama pull ${modelName}`;
  }


  if (statusCode >= 500) {
    return `Ollama server error (${statusCode}). Check if Ollama has enough resources (RAM/VRAM).`;
  }


  const snippet = body.substring(0, 200);
  return `Ollama error (${statusCode}): ${snippet}`;
}
