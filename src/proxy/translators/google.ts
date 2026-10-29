




interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
  thought?: boolean;
  inlineData?: { mimeType: string; data: string };
  fileData?: { mimeType: string; fileUri: string };
}

interface GeminiContent {
  parts?: GeminiPart[];
  role?: string;
}

interface GeminiCandidate {
  content?: GeminiContent;
  finishReason?: string;
  index?: number;
  safetyRatings?: unknown[];
}

interface GeminiStreamChunk {
  candidates?: GeminiCandidate[];
  usageMetadata?: unknown;
  modelVersion?: string;
}

interface GeminiRequestBody {
  model?: string;
  modelId?: string;
  contents?: GeminiContent[];
  systemInstruction?: { parts: { text?: string }[] };
  tools?: unknown[];
  generationConfig?: {
    temperature?: number;
    maxOutputTokens?: number;
    topP?: number;
    topK?: number;
    stopSequences?: string[];
  };
}




export function mapGeminiToGoogle(geminiBody: GeminiRequestBody, _modelName: string): GeminiRequestBody {

  const body = { ...geminiBody } as GeminiRequestBody & { stream?: boolean; model_id?: string; sessionId?: string; conversationId?: string };
  delete body.model;
  delete body.modelId;
  delete body.model_id;
  delete body.stream;
  delete body.sessionId;
  delete body.conversationId;
  return body;
}




export function mapGoogleToGemini(googleRes: unknown, _modelName: string): unknown {


  return googleRes;
}




export function mapGoogleChunkToGemini(chunk: unknown, _modelName: string): GeminiCandidate | null {
  if (!chunk || typeof chunk !== 'object') return null;

  const data = chunk as GeminiStreamChunk;


  if (!data.candidates || data.candidates.length === 0) return null;

  const candidate = data.candidates[0];


  const parts = candidate.content?.parts;
  if (!parts || parts.length === 0) {

    if (candidate.finishReason) {
      return {
        content: { parts: [], role: 'model' },
        finishReason: candidate.finishReason,
        index: candidate.index ?? 0,
      };
    }
    return null;
  }

  return {
    content: candidate.content,
    finishReason: candidate.finishReason || 'OTHER',
    index: candidate.index ?? 0,
    safetyRatings: candidate.safetyRatings,
  };
}




export function getGoogleApiUrl(baseUrl: string, modelName: string, isStream: boolean): string {
  const url = new URL(baseUrl);
  let pathname = url.pathname.replace(/\/+$/, '').replace(/:(?:streamGenerateContent|generateContent)$/, '');
  const modelsIndex = pathname.lastIndexOf('/models/');
  const existingModel = modelsIndex >= 0 ? pathname.slice(modelsIndex + 8) : '';
  const chosenModel = (modelName || '').replace(/^models\//, '') || decodeURIComponent(existingModel);
  if (!chosenModel) throw new Error('Google endpoint requires a model name');
  if (modelsIndex >= 0) pathname = pathname.slice(0, modelsIndex);
  else if (pathname.endsWith('/models')) pathname = pathname.slice(0, -7);
  if (!pathname) pathname = '/v1beta';
  url.pathname = `${pathname}/models/${encodeURIComponent(chosenModel)}:${isStream ? 'streamGenerateContent' : 'generateContent'}`;
  if (isStream) url.searchParams.set('alt', 'sse');
  else if (url.searchParams.get('alt') === 'sse') url.searchParams.delete('alt');
  return url.toString();
}
