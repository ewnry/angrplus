import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const preload = ts.transpileModule(readFileSync(path.resolve('src/customPreload.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const modelsUrl = 'http://localhost:50999/fetchAvailableModels';
const customModel = { name: 'example', displayName: 'Example', externalModelName: 'example-model' };

function createFixture(response: Response, models: unknown[] = [customModel]) {
  let onDomLoaded = () => {};
  const exposeInMainWorld = vi.fn();
  const vendorStorage = Object.freeze({ getItems: vi.fn(), updateItems: vi.fn() });
  const nativeFetch = vi.fn().mockResolvedValue(response);
  const getModels = vi.fn().mockResolvedValue(models);
  const nativeOpen = vi.fn();
  const nativeSend = vi.fn();
  class TestXHR {
    readyState = 0;
    status = 0;
    responseType = '';
    contentType = 'application/json';
    responseText = '{"models":{"existing":{"displayName":"Existing"}}}';
    response: unknown = this.responseText;
    onreadystatechange: ((event: Event) => unknown) | null = null;
    onload: (() => void) | null = null;
    open(...args: unknown[]) {
      nativeOpen(...args);
    }
    send(...args: unknown[]) {
      nativeSend(...args);
    }
    getResponseHeader() {
      return this.contentType;
    }
    complete() {
      this.readyState = 4;
      this.status = 200;
      const result = this.onreadystatechange?.(new Event('readystatechange'));
      this.onload?.();
      return result;
    }
  }
  const window = {
    nativeStorage: vendorStorage,
    fetch: nativeFetch as typeof fetch,
    addEventListener: (name: string, callback: () => void) => {
      if (name === 'DOMContentLoaded') onDomLoaded = callback;
    },
  };
  runInNewContext(preload, {
    exports: {},
    require: (id: string) => {
      if (id !== 'electron') throw new Error(`Unexpected preload dependency: ${id}`);
      return {
        contextBridge: { exposeInMainWorld },
        ipcRenderer: { invoke: getModels },
        webFrame: {},
      };
    },
    window,
    document: { querySelectorAll: () => [], getElementById: () => ({}) },
    location: { href: 'http://localhost:54321/' },
    setInterval: vi.fn(),
    XMLHttpRequest: TestXHR,
    URL,
    Request,
    Response,
    console,
  });
  onDomLoaded();
  return { window, nativeFetch, getModels, TestXHR, nativeOpen, nativeSend, exposeInMainWorld, vendorStorage };
}

describe('preload model-response compatibility', () => {
  it('runs with Electron alone and preserves APIs exposed by the vendor preload', () => {
    const fixture = createFixture(new Response());
    expect(fixture.exposeInMainWorld).not.toHaveBeenCalled();
    expect(fixture.window.nativeStorage).toBe(fixture.vendorStorage);
    expect(Object.keys(fixture.window.nativeStorage)).toEqual(['getItems', 'updateItems']);
  });

  it.each(['string', 'URL', 'Request'])('accepts %s fetch input and injects plain JSON model lists', async (kind) => {
    const original = new Response('{"models":{"existing":{"displayName":"Existing"}}}', {
      headers: { 'content-type': 'Application/JSON; charset=utf-8' },
    });
    const fixture = createFixture(original);
    const input = kind === 'URL' ? new URL(modelsUrl) : kind === 'Request' ? new Request(modelsUrl) : modelsUrl;
    const result = await fixture.window.fetch(input);
    expect(fixture.nativeFetch).toHaveBeenCalledWith(input, undefined);
    expect(await result.json()).toMatchObject({
      models: { existing: { displayName: 'Existing' }, 'custom-example-model': { displayName: 'Example' } },
    });
    expect(original.bodyUsed).toBe(false);
  });

  it.each([
    'http://localhost:54321/exa.language_server_pb.LanguageServerService/GetAvailableModels',
    'http://localhost:54321/LanguageServerService/GetAvailableModels',
  ])('leaves RPC responses untouched even when labeled JSON: %s', async (url) => {
    const original = new Response('\0\0\0\0\x02{}', { headers: { 'content-type': 'application/json' } });
    const clone = vi.spyOn(original, 'clone');
    const fixture = createFixture(original);
    expect(await fixture.window.fetch(url)).toBe(original);
    expect(clone).not.toHaveBeenCalled();
    expect(fixture.getModels).not.toHaveBeenCalled();
    expect(original.bodyUsed).toBe(false);
  });

  it.each(['application/connect+json', 'application/proto', 'application/json-seq', 'text/event-stream', ''])(
    'does not read, clone, or replace a %s response',
    async (contentType) => {
      const original = new Response('protocol frame', { headers: { 'content-type': contentType } });
      const clone = vi.spyOn(original, 'clone');
      const fixture = createFixture(original);
      expect(await fixture.window.fetch(modelsUrl)).toBe(original);
      expect(clone).not.toHaveBeenCalled();
      expect(fixture.getModels).not.toHaveBeenCalled();
      expect(original.bodyUsed).toBe(false);
    },
  );

  it('preserves invalid JSON and its unread original body', async () => {
    const original = new Response('not valid JSON', { headers: { 'content-type': 'application/json' } });
    const fixture = createFixture(original);
    expect(await fixture.window.fetch(modelsUrl)).toBe(original);
    expect(original.bodyUsed).toBe(false);
    expect(await original.text()).toBe('not valid JSON');
  });

  it('passes unrelated URLs and unsuccessful responses through', async () => {
    const original = new Response('forbidden', { status: 403, headers: { 'content-type': 'application/json' } });
    const fixture = createFixture(original);
    expect(await fixture.window.fetch(modelsUrl)).toBe(original);
    expect(await fixture.window.fetch(new URL('http://localhost:54321/health'))).toBe(original);
    expect(fixture.getModels).not.toHaveBeenCalled();
  });

  it('preserves the fetch rejection when the request fails', async () => {
    const fixture = createFixture(new Response());
    const failure = new TypeError('Network request failed');
    fixture.nativeFetch.mockRejectedValue(failure);
    await expect(fixture.window.fetch(new URL(modelsUrl))).rejects.toBe(failure);
  });

  it('preserves omitted and explicit synchronous XHR open modes', () => {
    const fixture = createFixture(new Response());
    const xhr = new fixture.TestXHR();
    xhr.open('GET', modelsUrl);
    expect(fixture.nativeOpen).toHaveBeenLastCalledWith('GET', modelsUrl, true, undefined, undefined);
    xhr.open('GET', modelsUrl, false);
    expect(fixture.nativeOpen).toHaveBeenLastCalledWith('GET', modelsUrl, false, undefined, undefined);
  });

  it('never replaces a Connect-RPC XHR event handler', () => {
    const fixture = createFixture(new Response());
    const xhr = new fixture.TestXHR();
    const onReady = vi.fn();
    xhr.onreadystatechange = onReady;
    xhr.open('POST', 'http://localhost:54321/exa.language_server_pb.LanguageServerService/GetAvailableModels');
    xhr.send();
    expect(xhr.onreadystatechange).toBe(onReady);
    expect(fixture.getModels).not.toHaveBeenCalled();
  });

  it.each([
    { contentType: 'application/connect+json', responseType: '' },
    { contentType: 'text/event-stream', responseType: '' },
    { contentType: 'application/json', responseType: 'arraybuffer' },
    { contentType: 'application/json', responseType: 'json' },
  ])('does not read unsupported XHR responses and preserves native event order: %j', (options) => {
    const fixture = createFixture(new Response());
    const xhr = new fixture.TestXHR();
    Object.assign(xhr, options);
    const readText = vi.fn(() => {
      throw new Error('Unsupported responseText access');
    });
    Object.defineProperty(xhr, 'responseText', { get: readText });
    const events: string[] = [];
    xhr.onreadystatechange = () => events.push('readystatechange');
    xhr.onload = () => events.push('load');
    xhr.open('GET', modelsUrl);
    xhr.send();
    expect(xhr.complete()).toBeUndefined();
    expect(events).toEqual(['readystatechange', 'load']);
    expect(readText).not.toHaveBeenCalled();
  });

  it('injects cached XHR JSON without delaying readystatechange behind load', async () => {
    const fixture = createFixture(new Response());
    const xhr = new fixture.TestXHR();
    const events: string[] = [];
    xhr.onreadystatechange = () => events.push('readystatechange');
    xhr.onload = () => events.push('load');
    xhr.open('GET', modelsUrl);
    xhr.send();
    await new Promise((resolve) => setImmediate(resolve));
    xhr.complete();
    expect(JSON.parse(xhr.responseText)).toMatchObject({
      models: { existing: { displayName: 'Existing' }, 'custom-example-model': { displayName: 'Example' } },
    });
    expect(events).toEqual(['readystatechange', 'load']);
  });

  it('keeps synchronous XHR completion synchronous when the model cache is empty', () => {
    const fixture = createFixture(new Response());
    const xhr = new fixture.TestXHR();
    const original = xhr.responseText;
    const onReady = vi.fn();
    xhr.onreadystatechange = onReady;
    xhr.open('GET', modelsUrl, false);
    xhr.send();
    expect(xhr.complete()).toBeUndefined();
    expect(onReady).toHaveBeenCalledOnce();
    expect(fixture.getModels).not.toHaveBeenCalled();
    expect(xhr.responseText).toBe(original);
  });
});
